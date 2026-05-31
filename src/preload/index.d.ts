import { ElectronAPI } from '@electron-toolkit/preload'

// Definiáljuk a zene struktúráját a globális típusok között is, 
// hogy a kimeneti tömbök pontosan tipizálva legyenek
interface TrackData {
  path: string
  title: string
  artist: string
  album: string
  duration: number
  cover: string
}

declare global {
  interface Window {
    // Ha az electron-toolkit-et használod, ez megtartható:
    electron: ElectronAPI
    
    // Itt definiáljuk a saját egyedi API-nkat a hídhoz
    electronAPI: {
      selectMusicFiles: () => Promise<TrackData[]>
      selectMusicFolder(recursive: boolean): Promise<{ folderPath: string; tracks: any[] } | null>    
    }
  }
}