import { app, shell, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import path from 'path'
import fs from 'fs'
import * as parseMusic from 'music-metadata'
import * as querystring from 'querystring'

// Szám struktúra interfész a közös használathoz
interface TrackData {
  path: string
  title: string
  artist: string
  album: string
  duration: number
  cover: string
  format: string
  sampleRate: string
  bitrate: string
}

// 1. A 'media' séma privilegizálása a CORS hibák elkerülésére (Még az app.ready előtt!)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: false,
      corsEnabled: true,
      stream: true
    }
  }
])

const FIXED_WIDTH = 400 // Az ablak fix szélessége nem lehet méretezni

function createWindow(): void {
  // --- ABLAK MAGASSÁG VISSZATÖLTÉSE ---
  let savedHeight = 1300 // Alapértelmezett magasság, ha még nincs mentés
  
  // Mivel a fő folyamatban nincs localStorage, az Electron saját konfigurációs mappáját használjuk
  const userDataPath = app.getPath('userData')
  const windowStatePath = path.join(userDataPath, 'window-state.json')

  try {
    if (fs.existsSync(windowStatePath)) {
      const state = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'))
      if (state && typeof state.height === 'number') {
        savedHeight = state.height
      }
    }
  } catch (e) {
    console.error('Nem sikerült beolvasni az ablak méretét:', e)
  }

// --- ABLAK LÉTREHOZÁSA A MENTETT MAGASSÁGGAL ---
  const mainWindow = new BrowserWindow({
    width: FIXED_WIDTH,
    height: savedHeight, // <-- Itt alkalmazzuk a visszatöltött értéket!
    minWidth: FIXED_WIDTH,
    maxWidth: FIXED_WIDTH,
    minHeight: 450,      // Biztonsági korlát: ne lehessen túlságosan összenyomni a fő panelt
    maxHeight: 1400,     // Maximális magasság a képernyőhöz igazítva
    
    frame: false,
    transparent: true,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

// --- MINIMIZE ÉS CLOSE IPC KEZELŐK ---
  ipcMain.on('window-minimize', () => {
    mainWindow.minimize()
  })

  ipcMain.on('window-close', () => {
    mainWindow.close()
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 2. Az alkalmazás inicializálása
app.whenReady().then(() => {

// Biztonságos és stabil média protokoll kezelő (baj volt az elérési útvonalakkal)
protocol.registerFileProtocol('media', (request, callback) => {
    try {
      // 1. Levágjuk a sémát az elejéről
      let rawPath = request.url.replace(/^media:\/\/\/?/, '')
      
      // 2. FIX: A querystring.unescape soha nem dob "URI malformed" hibát, 
      // még akkor sem, ha magányos % vagy ! jelek vannak a fájlnévben!
      let decodedPath = querystring.unescape(rawPath)

      // WINDOWS FIX: Ha az útvonal úgy kezdődik, hogy "d/zene" (nincs kettőspont)
      if (decodedPath.match(/^[a-zA-Z]\//)) {
        decodedPath = decodedPath.charAt(0) + ':' + decodedPath.slice(1)
      }

      // 3. Visszaadjuk a normalizált elérési utat
      return callback({ path: path.normalize(decodedPath) })
    } catch (error) {
      console.error('Protokoll hiba a beolvasáskor:', error)
      return callback({ error: -6 })
    }
  })

  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ==========================================
//          IPC KEZELŐK (API HÍD)
// ==========================================

// --- MAPPA SZKENNELÉSE (REKURZÍV) ---
ipcMain.removeHandler('select-music-folder')
ipcMain.handle('select-music-folder', async (_event, recursive: boolean) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null // Null-t adunk vissza, ha megszakította, így nem írja felül a listát üressel
  }

  const targetFolder = result.filePaths[0]
  const trackList: any[] = []

  // Belső rekurzív mappaolvasó függvény
  async function scanDirectory(dir: string) {
    let files: string[] = []
    try {
      files = fs.readdirSync(dir)
    } catch (err) {
      console.error(`Nem sikerült a mappa olvasása: ${dir}`, err)
      return
    }

    for (const file of files) {
      const fullPath = path.join(dir, file)
      let stat: fs.Stats
      
      try {
        stat = fs.statSync(fullPath)
      } catch (err) {
        continue
      }

      if (stat.isDirectory()) {
        // Csak akkor lépünk be az almappába, ha a felhasználó kérte a rekurzív módot
        if (recursive) {
          await scanDirectory(fullPath)
        }
      } else {
        const ext = path.extname(file).toLowerCase()
        if (['.mp3', '.wav', '.ogg', '.flac'].includes(ext)) {
          try {
            const metadata = await parseMusic.parseFile(fullPath)
            
            let coverStr = ''
            const picture = parseMusic.selectCover(metadata.common.picture)
            if (picture) {
              const base64Data = Buffer.from(picture.data).toString('base64')
              coverStr = `data:${picture.format};base64,${base64Data}`
            }

            // Kiterjesztés kinyerése és tisztítása (pl. .mp3 -> MP3)
            const fileFormat = ext.replace('.', '').toUpperCase()

            // Mintavételi frekvencia kiszámítása (pl. 44100 -> 44.1 kHz)
            const sampleRateStr = metadata.format.sampleRate 
              ? `${(metadata.format.sampleRate / 1000).toFixed(1)} kHz` 
              : '44.1 kHz'

            // Bitráta kiszámítása (pl. 320000 -> 320 kbps)
            const bitrateStr = metadata.format.bitrate 
              ? `${Math.round(metadata.format.bitrate / 1000)} kbps` 
              : '320 kbps'

            trackList.push({
              path: fullPath,
              title: metadata.common.title || file.replace(ext, ''),
              artist: metadata.common.artist || 'Ismeretlen előadó',
              album: metadata.common.album || 'Ismeretlen album',
              duration: metadata.format.duration || 0,
              cover: coverStr,
              // ÚJ AUDIO INFÓK:
              format: fileFormat,
              sampleRate: sampleRateStr,
              bitrate: bitrateStr
            })
          } catch (error) {
            // Ha a metaadat sérült, a fájlt alapadatokkal akkor is hozzáadjuk
            trackList.push({
              path: fullPath,
              title: file.replace(ext, ''),
              artist: 'Ismeretlen előadó',
              album: 'Ismeretlen album',
              duration: 0,
              cover: '',
              // Biztonsági alapértelmezett értékek hiba esetén:
              format: ext.replace('.', '').toUpperCase(),
              sampleRate: '44.1 kHz',
              bitrate: '320 kbps'
            })
          }
        }
      }
    }
  }

  await scanDirectory(targetFolder)
  
  // Visszaadjuk a mappa útvonalát és a talált számokat is egy objektumban
  return {
    folderPath: targetFolder,
    tracks: trackList
  }
})

// --- EGYEDI FÁJLOK KIVÁLASZTÁSA ---
ipcMain.removeHandler('select-music-files')
ipcMain.handle('select-music-files', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'flac'] }
    ]
  })

  if (result.canceled || result.filePaths.length === 0) {
    return []
  }

  const trackList: TrackData[] = []

  for (const filePath of result.filePaths) {
    const ext = path.extname(filePath).toLowerCase()
    
    try {
      const metadata = await parseMusic.parseFile(filePath)
      
      let coverStr = ''
      const picture = parseMusic.selectCover(metadata.common.picture)
      if (picture) {
        const base64Data = Buffer.from(picture.data).toString('base64')
        coverStr = `data:${picture.format};base64,${base64Data}`
      }

      // Kiterjesztés kinyerése és tisztítása (pl. .flac -> FLAC)
      const fileFormat = ext.replace('.', '').toUpperCase()

      // Mintavételi frekvencia kiszámítása (pl. 44100 -> 44.1 kHz)
      const sampleRateStr = metadata.format.sampleRate 
        ? `${(metadata.format.sampleRate / 1000).toFixed(1)} kHz` 
        : '44.1 kHz'

      // Bitráta kiszámítása (pl. 320000 -> 320 kbps)
      const bitrateStr = metadata.format.bitrate 
        ? `${Math.round(metadata.format.bitrate / 1000)} kbps` 
        : '320 kbps'

      trackList.push({
        path: filePath,
        title: metadata.common.title || filePath.split('\\').pop()?.split('/').pop() || 'Ismeretlen szám',
        artist: metadata.common.artist || 'Ismeretlen előadó',
        album: metadata.common.album || 'Ismeretlen album',
        duration: metadata.format.duration || 0,
        cover: coverStr,
        // ÚJ AUDIO INFÓK:
        format: fileFormat,
        sampleRate: sampleRateStr,
        bitrate: bitrateStr
      })
    } catch (error) {
      console.error('Hiba a fájl beolvasása közben:', error)
      
      // Ha a metaadat sérült, a fájlt alapadatokkal akkor is hozzáadjuk, így nem esik ki a listából
      trackList.push({
        path: filePath,
        title: filePath.split('\\').pop()?.split('/').pop() || 'Ismeretlen szám',
        artist: 'Ismeretlen előadó',
        album: 'Ismeretlen album',
        duration: 0,
        cover: '',
        // Biztonsági alapértelmezett értékek hiba esetén:
        format: ext.replace('.', '').toUpperCase(),
        sampleRate: '44.1 kHz',
        bitrate: '320 kbps'
      })
    }
  }

  return trackList
})