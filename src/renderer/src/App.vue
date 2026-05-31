<script setup lang="ts">
import { ref, computed, onUnmounted, onMounted, watch } from 'vue'

interface Track {
  path: string
  title: string
  artist: string
  album: string
  duration: number
  cover: string
  format: string
  bitrate: number
  sampleRate: number
}

// --- REAKTÍV ÁLLAPOTOK ---
const playlist = ref<Track[]>([])
const currentTrackIndex = ref<number | null>(null)
const isPlaying = ref<boolean>(false)
const currentTime = ref<number>(0)
// 'none' = nincs, 'track' = egy szám ismétlése, 'list' = teljes lista ismétlése
const repeatMode = ref<'none' | 'track' | 'list'>('none')
const searchQuery = ref<string>('')
// 'bars' = hangsávok, 'vu' = analóg VU méter, 'off' = kikapcsolva
const visualizerMode = ref<'bars' | 'vu' | 'off'>('bars')
//const playlist = ref<any[]>([])
const lastOpenedFolder = ref<string>('')
const showSettings = ref(false) // Vezérli, hogy a lista vagy a beállítások látszódjanak-e
const showCopyright = ref(false)

const volume = ref<number>(0.5)
const isMuted = ref<boolean>(false)
const previousVolume = ref<number>(0.5) // Ebbe mentjük a hangerőt némításkor
const minimizeApp = () => {
  // @ts-ignore
  window.electronAPI.minimizeWindow()
}

const closeApp = () => {
  // @ts-ignore
  window.electronAPI.closeWindow()
}

// --- AUDIO VÁLTOZÓK ---
let audio: HTMLAudioElement | null = null
let audioContext: AudioContext | null = null
let source: MediaElementAudioSourceNode | null = null
let analyser: AnalyserNode | null = null
let animationFrameId: number | null = null

const visualizerCanvas = ref<HTMLCanvasElement | null>(null)

const currentTrackDuration = computed(() => {
  if (currentTrackIndex.value !== null && playlist.value[currentTrackIndex.value]) {
    return playlist.value[currentTrackIndex.value].duration
  }
  return 0
})

// Ez a reaktív lista mindig csak azokat a számokat tartalmazza, amik egyeznek a kereséssel
const filteredPlaylist = computed(() => {
  if (!searchQuery.value.trim()) {
    return playlist.value
  }

  const query = searchQuery.value.toLowerCase()
  return playlist.value.filter(track => 
    track.title.toLowerCase().includes(query) || 
    track.artist.toLowerCase().includes(query)
  )
})

// Központi beállítások (Alapértelmezett értékekkel)
const settings = ref({
  recursiveScan: true,
  glitchEffect: true,
  theme: 'cyan-punk',
  isTransparent: true
})

const handleMouseEnter = (event: MouseEvent) => {
  const item = event.currentTarget as HTMLElement
  const details = item.querySelector('.details') as HTMLElement
  const scrollText = item.querySelector('.scroll-text') as HTMLElement
  
  if (details && scrollText) {
    // Kiszámoljuk a különbséget a teljes szöveghossz és a látható szélesség között
    const overflowWidth = scrollText.scrollWidth - details.clientWidth
    
    // Csak akkor indítjuk el, ha a szöveg tényleg nem fér el
    if (overflowWidth > 0) {
      // Beállítjuk a pontos pixel értéket a CSS-nek (+20px biztonsági ráhagyás a végére)
      scrollText.style.setProperty('--scroll-dist', `-${overflowWidth + 20}px`)
      scrollText.classList.add('is-scrolling')
    }
  }
}

const handleMouseLeave = (event: MouseEvent) => {
  const item = event.currentTarget as HTMLElement
  const scrollText = item.querySelector('.scroll-text') as HTMLElement
  
  if (scrollText) {
    scrollText.classList.remove('is-scrolling')
    scrollText.style.removeProperty('--scroll-dist')
  }
}

// Segédfüggvény, hogy ha megnyitjuk a copyrightot, a sima beállítások záródjanak be
const toggleCopyright = () => {
  showCopyright.value = !showCopyright.value
  if (showCopyright.value) showSettings.value = false
}

// --- TÉMA ALKALMAZÁSA ---
const applyTheme = (themeName: string) => {
  settings.value.theme = themeName
  document.documentElement.setAttribute('data-theme', themeName)
}

const toggleVisualizerMode = () => {
  if (visualizerMode.value === 'bars') {
    visualizerMode.value = 'vu'
  } else if (visualizerMode.value === 'vu') {
    visualizerMode.value = 'off'
  } else {
    visualizerMode.value = 'bars'
  }
}

const formatTime = (seconds: number): string => {
  if (!seconds || isNaN(seconds)) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

// --- VIZUÁLIS KIVEZÉRLÉS ---
const startVisualizer = () => {
  if (!analyser || !visualizerCanvas.value) return
  
  const canvas = visualizerCanvas.value
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  analyser.fftSize = 64
  const bufferLength = analyser.frequencyBinCount
  const dataArray = new Uint8Array(bufferLength)

  // VU méterhez szükséges simítási változók a mutatóknak
  let leftSmoothedVolume = 0
  let rightSmoothedVolume = 0
  let tehetetlensegiTenyezo = 0.40
  const draw = () => {
    animationFrameId = requestAnimationFrame(draw)
    analyser!.getByteFrequencyData(dataArray)

    // Tiszta lappal indulunk minden képkockánál
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // --- 1. MÓD: NEON SÁVOK ---
    if (visualizerMode.value === 'bars') {
      const barWidth = (canvas.width / bufferLength) * 1.4
      let barHeight
      let x = 0

      for (let i = 0; i < bufferLength; i++) {
        barHeight = (dataArray[i] / 255) * canvas.height * 0.9

        if (barHeight > 0) {
          const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0)
          gradient.addColorStop(0, '#0066ff')
          gradient.addColorStop(0.4, '#00ffff')
          gradient.addColorStop(1, '#ff00ff')

          ctx.fillStyle = gradient
          ctx.fillRect(x, canvas.height - barHeight, barWidth - 3, barHeight)
        }
        x += barWidth
      }
    } 
    // --- 2. MÓD: RETRÓ ANALÓG VU MÉTER ---
    // --- 2. MÓD: FELTURBÓZOTT ANALÓG STÚDIÓ VU MÉTER ---
    else if (visualizerMode.value === 'vu') {
      // Spektrum kettéválasztása (Bal / Jobb csatorna szimuláció)
      let leftSum = 0, rightSum = 0
      const half = Math.floor(bufferLength / 2)
      for (let i = 0; i < half; i++) leftSum += dataArray[i]
      for (let i = half; i < bufferLength; i++) rightSum += dataArray[i]

      const leftNorm = (leftSum / half) / 255
      const rightNorm = (rightSum / half) / 255

      // Mutatók tehetetlensége a lágy mozgásért
      leftSmoothedVolume += (leftNorm - leftSmoothedVolume) * tehetetlensegiTenyezo //0.22 volt
      rightSmoothedVolume += (rightNorm - rightSmoothedVolume) * tehetetlensegiTenyezo //0.22 volt

      // Középpontok és geometriai méretek (A megnövelt 85px-es magassághoz igazítva)
      const centers = [canvas.width * 0.25, canvas.width * 0.75]
      const centerY = canvas.height - 5
      const radius = canvas.height * 0.85

      centers.forEach((centerX, idx) => {
        const currentVol = idx === 0 ? leftSmoothedVolume : rightSmoothedVolume

        // --- A: FŐ SKÁLA ÍVEK RAJZOLÁSA ---
        // Normál tartomány íve (Cián)
        ctx.beginPath()
        ctx.arc(centerX, centerY, radius, Math.PI * 1.2, Math.PI * 1.65)
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.4)'
        ctx.lineWidth = 2
        ctx.stroke()

        // Piros / Túlvezérlési tartomány íve (Magenta / Piros)
        ctx.beginPath()
        ctx.arc(centerX, centerY, radius, Math.PI * 1.65, Math.PI * 1.8)
        ctx.strokeStyle = '#ff00ff'
        ctx.lineWidth = 3
        ctx.stroke()

        // --- B: BESÁVOZOTT OSZTÁSVONALAK (TICK MARKS) ---
        // Sűrű osztásvonalakat rajzolunk a skálára körbe-körbe
        const totalTicks = 15
        for (let t = 0; t <= totalTicks; t++) {
          const ratio = t / totalTicks
          const tickAngle = Math.PI * 1.2 + ratio * (Math.PI * 0.6)
          
          // Meghatározzuk a vonal színét a helyzete alapján (a felső 20% már a piros zóna)
          const isRedZone = ratio > 0.75
          ctx.strokeStyle = isRedZone ? 'rgba(255, 0, 255, 0.6)' : 'rgba(0, 255, 255, 0.3)'
          ctx.lineWidth = isRedZone ? 2 : 1

          // Külső és belső pontok kiszámítása a rovátkáknak
          const tickLength = t % 5 === 0 ? 8 : 4 // Minden 5. vonal hosszabb
          const x1 = centerX + Math.cos(tickAngle) * radius
          const y1 = centerY + Math.sin(tickAngle) * radius
          const x2 = centerX + Math.cos(tickAngle) * (radius - tickLength)
          const y2 = centerY + Math.sin(tickAngle) * (radius - tickLength)

          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          ctx.stroke()

          // --- C: ÉRTÉK FELIRATOK (-20, -10, -5, 0, +3 dB szimuláció) ---
          if (t % 3 === 0) {
            const labelX = centerX + Math.cos(tickAngle) * (radius - 16)
            const labelY = centerY + Math.sin(tickAngle) * (radius - 16)
            
            // Értékek szövegei a hifi szabvány szerint
            let dbText = ''
            if (t === 0) dbText = '-20'
            else if (t === 3) dbText = '-10'
            else if (t === 6) dbText = '-5'
            else if (t === 9) dbText = '-2'
            else if (t === 12) dbText = '0'
            else if (t === 15) dbText = '+3'

            ctx.fillStyle = isRedZone ? '#ff00ff' : 'rgba(0, 255, 255, 0.5)'
            ctx.font = '8px Share Tech Mono'
            ctx.textAlign = 'center'
            ctx.fillText(dbText, labelX, labelY)
          }
        }

        // --- D: MUTATÓ KISZÁMÍTÁSA ÉS RAJZOLÁSA ---
        // A hangerő szögét képezzük le a skálára
        const needleAngle = Math.PI * 1.2 + (currentVol * (Math.PI * 0.6))
        const pointerX = centerX + Math.cos(needleAngle) * (radius - 2)
        const pointerY = centerY + Math.sin(needleAngle) * (radius - 2)

        ctx.beginPath()
        ctx.moveTo(centerX, centerY)
        ctx.lineTo(pointerX, pointerY)
        
        // Dinamikus mutató szín: ha beér a piros tartományba, dühös neon-magantává és vastagabbá válik
        if (currentVol > 0.75) {
          ctx.strokeStyle = '#ff00ff'
          ctx.lineWidth = 2.5
          ctx.shadowColor = '#ff00ff'
          ctx.shadowBlur = 6
        } else {
          ctx.strokeStyle = '#00ffff'
          ctx.lineWidth = 1.5
          ctx.shadowBlur = 0 // Alapon nincs elmosódás a precíz látványért
        }
        ctx.stroke()
        ctx.shadowBlur = 0 // Reset

        // --- E: MŰSZER KÖZÉPPONT ÉS PANEL KIJELZŐK ---
        // Csavar / tengely takaró sapka alul
        ctx.beginPath()
        ctx.arc(centerX, centerY, 5, 0, Math.PI * 2)
        ctx.fillStyle = '#111222'
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)'
        ctx.lineWidth = 1
        ctx.fill()
        ctx.stroke()

        // Csatorna felirat (Bal / Jobb) háttérvilágítással
        ctx.fillStyle = currentVol > 0.75 ? 'rgba(255, 0, 255, 0.4)' : 'rgba(0, 255, 255, 0.2)'
        ctx.font = '10px Share Tech Mono'
        ctx.textAlign = 'center'
        ctx.fillText(idx === 0 ? 'LEFT_CH' : 'RIGHT_CH', centerX, centerY - 32)
      })

      // Középső dekoratív stúdió elválasztó vagy státusz szöveg
      ctx.fillStyle = 'rgba(0, 255, 255, 0.1)'
      ctx.font = '9px Share Tech Mono'
      ctx.textAlign = 'center'
      ctx.fillText('ANALOG_VU_v2', canvas.width / 2, 15)
    }
    // --- 3. MÓD: OFF (Semmit nem rajzolunk, a képernyő sötét marad)
    else if (visualizerMode.value === 'off') {
      // Csak egy nagyon halvány "OFF" feliratot villantunk fel dizájnnak a sarokban
      ctx.fillStyle = 'rgba(255, 0, 0, 0.15)'
      ctx.font = '10px Share Tech Mono'
      ctx.fillText('DISP_OFF', canvas.width - 55, 12)
    }
  }

  if (animationFrameId) cancelAnimationFrame(animationFrameId)
  draw()
}

const initAudioContext = () => {
  if (!audio || audioContext) return
  audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
  analyser = audioContext.createAnalyser()
  analyser.smoothingTimeConstant = 0.75
  
  source = audioContext.createMediaElementSource(audio)
  source.connect(analyser)
  analyser.connect(audioContext.destination)
}

// --- FÁJLOK HOZZÁADÁSA ---
const loadFiles = async () => {
  try {
    // @ts-ignore
    const files = await window.electronAPI.selectMusicFiles()
    if (files && files.length > 0) {
      const oldLength = playlist.value.length
     // playlist.value = [...playlist.value, ...files]
     playlist.value = [
  ...playlist.value, 
  ...files.map((track: any) => ({
    ...track,
    // Garantáljuk a hiányzó tulajdonságokat, ha a forrásfájlban nem lennének meg
    format: track.format || '?',
    bitrate: track.bitrate || '?',
    sampleRate: track.sampleRate || '?'
  }))
];
      if (currentTrackIndex.value === null) playTrack(oldLength)
    }
  } catch (err) {
    console.error(err)
  }
}

// --- MAPPA SZKENNELÉSE ---
// --- MÓDOSÍTOTT MAPPA BEOLVASÓ FÜGGVÉNY ---
const loadFolder = async () => {
  // @ts-ignore - Átadjuk a rekurzív beállítást a hátérnek
  const result = await window.electronAPI.selectMusicFolder(settings.value.recursiveScan)
  
  // Ha nem szakította meg a felhasználó
  if (result) {
    playlist.value = result.tracks
    lastOpenedFolder.value = result.folderPath
  }
}

// --- STOP FUNKCIÓ ---
const stopTrack = () => {
  if (!audio) return
  audio.pause()
  audio.currentTime = 0
  currentTime.value = 0
  isPlaying.value = false
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
  
  // Kitöröljük a vizualizációt a canvasról, hogy üres legyen
  if (visualizerCanvas.value) {
    const ctx = visualizerCanvas.value.getContext('2d')
    if (ctx) ctx.clearRect(0, 0, visualizerCanvas.value.width, visualizerCanvas.value.height)
  }
}

// --- ISMÉTLÉSI MÓD VÁLTÓ (3-állású) ---
const toggleRepeatMode = () => {
  if (repeatMode.value === 'none') {
    repeatMode.value = 'track'
  } else if (repeatMode.value === 'track') {
    repeatMode.value = 'list'
  } else {
    repeatMode.value = 'none'
  }
}

// --- LEJÁTSZÁS ---
// --- LEJÁTSZÁS ---
const playTrack = async (index: number) => {
  if (index < 0 || index >= playlist.value.length) return
  
  currentTrackIndex.value = index
  const track = playlist.value[index]

  if (animationFrameId) cancelAnimationFrame(animationFrameId)

// Egységesítjük a perjeleket
  const cleanPath = track.path.replace(/\\/g, '/')
  
  // A gyári encodeURI biztonságossá teszi a hálózat számára a % és ! jeleket, 
  // de nem bántja a perjeleket és a kettőspontot
  const finalMediaSrc = `media:///${encodeURI(cleanPath)}`

  if (audio) {
    audio.ontimeupdate = null
    audio.onended = null
    audio.pause()
    audio.src = finalMediaSrc
  } else {
    audio = new Audio(finalMediaSrc)
    audio.crossOrigin = 'anonymous'
  }

  // Aktuális hangerő érvényesítése (figyelembe véve a némítást)
  audio.volume = isMuted.value ? 0 : volume.value

  initAudioContext()

  if (audioContext && audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  // Eseménykezelők regisztrálása
  audio.ontimeupdate = () => { if (audio) currentTime.value = audio.currentTime }
  audio.onended = () => {
    if (repeatMode.value === 'track') {
      // 1. Csak a jelenlegi szám ismétlése
      playTrack(currentTrackIndex.value!)
    } else if (repeatMode.value === 'list') {
      // 2. Teljes lista ismétlése (ha a végére ért, az elsőre ugrik)
      nextTrack()
    } else {
      // 3. Nincs ismétlés: ha az utolsó számon állunk, megállítjuk
      if (currentTrackIndex.value === playlist.value.length - 1) {
        stopTrack()
      } else {
        nextTrack()
      }
    }
  }

  // FIX: Megvárjuk a lejátszás elindulását, és elkapjuk a gyors léptetés miatti megszakításokat (AbortError)
  try {
    const playPromise = audio.play()
    if (playPromise !== undefined) {
      await playPromise
      isPlaying.value = true
      setTimeout(startVisualizer, 50)
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn('[RENDSZER] Lejátszás megszakítva a gyors léptetés miatt.')
    } else {
      console.error('[RENDSZER] Lejátszási hiba:', err)
    }
  }
}

const togglePlay = () => {
  if (!audio) return
  if (isPlaying.value) {
    audio.pause()
    isPlaying.value = false
    if (animationFrameId) cancelAnimationFrame(animationFrameId)
  } else {
    if (audioContext && audioContext.state === 'suspended') audioContext.resume()
    audio.play()
    isPlaying.value = true
    startVisualizer()
  }
}

const nextTrack = () => {
  if (currentTrackIndex.value !== null && playlist.value.length > 0) {
    playTrack((currentTrackIndex.value + 1) % playlist.value.length)
  }
}

const prevTrack = () => {
  if (currentTrackIndex.value !== null && playlist.value.length > 0) {
    let prev = currentTrackIndex.value - 1
    if (prev < 0) prev = playlist.value.length - 1
    playTrack(prev)
  }
}

const seek = (event: Event) => {
  const target = event.target as HTMLInputElement
  if (audio) audio.currentTime = Number(target.value)
}

// --- HANGERŐ ÉS NÉMÍTÁS LOGIKA ---
const changeVolume = (event: Event) => {
  const target = event.target as HTMLInputElement
  volume.value = Number(target.value)
  
  if (volume.value > 0) {
    isMuted.value = false // Ha felhúzza a csúszkát, kikapcsol a némítás
  }
  
  if (audio) {
    audio.volume = isMuted.value ? 0 : volume.value
  }
}

const toggleMute = () => {
  if (isMuted.value) {
    // Visszahangosítás
    volume.value = previousVolume.value
    isMuted.value = false
  } else {
    // Némítás
    previousVolume.value = volume.value // Elmentjük a szintet
    volume.value = 0
    isMuted.value = true
  }

  if (audio) {
    audio.volume = isMuted.value ? 0 : volume.value
  }
}

// --- PERZISZTENCIA LERAKÁSA (BETÖLTÉS) ---
onMounted(() => {
  // 1. Beállítások betöltése
  const savedSettings = localStorage.getItem('cyber_player_settings')
  if (savedSettings) {
    try {
      settings.value = JSON.parse(savedSettings)
      applyTheme(settings.value.theme)
    } catch (e) {
      console.error('Hiba a beállítások betöltésekor:', e)
    }
  } else {
    applyTheme(settings.value.theme) // Alapértelmezett téma aktiválása
  }

  // 2. Utolsó megnyitott mappa útvonalának betöltése
  const savedFolder = localStorage.getItem('cyber_player_last_folder')
  if (savedFolder) lastOpenedFolder.value = savedFolder

  // 3. Leátszási lista betöltése
  const savedPlaylist = localStorage.getItem('cyber_player_playlist')
  if (savedPlaylist) {
    try {
      playlist.value = JSON.parse(savedPlaylist)
    } catch (e) {
      console.error('Hiba a lejátszási lista visszaállításakor:', e)
    }
  }
})

onUnmounted(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
  if (audioContext) audioContext.close()
})

// --- AUTOMATIKUS MENTÉSEK (WATCHERS) ---
watch(settings, (newSettings) => {
  localStorage.setItem('cyber_player_settings', JSON.stringify(newSettings))
}, { deep: true })

watch(playlist, (newPlaylist) => {
  localStorage.setItem('cyber_player_playlist', JSON.stringify(newPlaylist))
}, { deep: true })

watch(lastOpenedFolder, (newFolder) => {
  localStorage.setItem('cyber_player_last_folder', newFolder)
})


</script>

<template>
<div class="cyber-player">
    
    <div :class="['player-main', { 'solid-bg': !settings.isTransparent }]">
      
      <div class="neon-header window-drag-area">
        <span class="glitch-text copyright-trigger" @click="toggleCopyright" title="Névjegy és Licenc">
          CPAP_AUDIO
        </span>
        
        <div class="header-action-buttons">
          <button @click="loadFiles" class="neon-add-btn" title="Egy zene betallózása">🎵</button>
          <button @click="loadFolder" class="neon-add-btn folder-btn" title="Mappa betöltése">📂</button>

          <div class="window-controls-separator"></div>
          
          <button @click="minimizeApp" class="window-btn min-btn" title="Letálcázás">—</button>
          <button @click="closeApp" class="window-btn close-btn" title="Bezárás">X</button>
        </div>
      </div>

      <div @click="toggleVisualizerMode" class="visualizer-panel" title="Kijelző mód váltása">
        <canvas ref="visualizerCanvas" width="370" height="85"></canvas>
      </div>

      <div class="track-display">
        <div class="neon-cover-border">
          <img v-if="currentTrackIndex !== null && playlist[currentTrackIndex]?.cover" :src="playlist[currentTrackIndex].cover" /> <!-- Hibajavítás: nem töltötte be a mappát/listát szám borítókép hiba miatt -->
          <div v-else class="no-cover">>></div>
        </div>
        
        <div class="track-details" v-if="currentTrackIndex !== null && playlist[currentTrackIndex]">
          <div class="track-title-container">
            <div class="track-title-scroll">{{ playlist[currentTrackIndex].title }}</div>
          </div>
          <div class="track-artist">{{ playlist[currentTrackIndex].artist }}</div>
          
          <div class="track-tech-specs">
            <span class="spec-badge format">{{ playlist[currentTrackIndex].format }}</span>
            <span class="spec-divider">//</span>
            <span class="spec-badge sample">{{ playlist[currentTrackIndex].sampleRate }}</span>
            <span class="spec-divider">//</span>
            <span class="spec-badge bitrate">{{ playlist[currentTrackIndex].bitrate }}</span>
          </div>
        </div>
        
        <div class="track-details" v-else>
          <div class="track-title waiting">RENDSZER_KÉSZ // VÁRAKOZÁS...</div>
        </div>
      </div>

      <div class="progress-section">
        <span class="time-display">{{ formatTime(currentTime) }}</span>
        <input type="range" class="neon-slider" min="0" :max="currentTrackDuration" :value="currentTime" @input="seek" />
        <span class="time-display">{{ formatTime(currentTrackDuration) }}</span>
      </div>

      <div class="bottom-controls">
        <div class="buttons-group">
          <button @click="toggleRepeatMode" :class="['cyber-btn', 'repeat-btn', repeatMode]" :title="'Ismétlés: ' + repeatMode">
            🔁 <span class="mode-badge">{{ repeatMode === 'none' ? 'KI' : repeatMode === 'track' ? '1' : 'ALL' }}</span>
          </button>

          <button @click="prevTrack" class="cyber-btn" title="Előző">&lt;&lt;</button>
          <button @click="togglePlay" class="cyber-btn play-btn" title="Lejátszás">{{ isPlaying ? '||' : '&#9654;' }}</button>
          <button @click="stopTrack" class="cyber-btn stop-btn" title="Leállítás">■</button>
          <button @click="nextTrack" class="cyber-btn" title="Következő">&gt;&gt;</button>
          
          <button @click="showSettings = !showSettings" class="window-btn neon-toggle-btn" :class="{ 'active-btn': showSettings }">
            {{ showSettings ? '🎵 LISTA' : '⚙️ BEÁLLÍTÁS' }}
          </button>
        </div>

        <div class="volume-group" :class="{ 'is-muted-ui': isMuted }">
          <button @click="toggleMute" class="mute-btn" :title="isMuted ? 'Hang be' : 'Némítás'">
            {{ isMuted ? '🔇' : '🔊' }}
          </button>
          <input 
            type="range" 
            class="volume-slider" 
            min="0" 
            max="1" 
            step="0.01" 
            :value="volume" 
            @input="changeVolume" 
          />
        </div>
      </div>
    </div>

    <div class="bottom-panel-container">
      
      <div v-if="lastOpenedFolder" class="folder-path-indicator">
        <span class="pulse-dot"></span> ZENEI KÖNYVTÁR: {{ lastOpenedFolder }}
      </div>

      <div v-if="showSettings" :class="['cyber-settings-panel', { 'solid-bg': !settings.isTransparent }]">
        <div class="playlist-header">SYSTEM_SETTINGS_v1.0</div>
        
        <div class="settings-group">
          <label class="cyber-checkbox-label">
            <input type="checkbox" v-model="settings.recursiveScan" />
            <span class="checkbox-custom"></span>
            ALMAPPA_KERESÉS_REKURZÍV
          </label>

          <label class="cyber-checkbox-label">
            <input type="checkbox" v-model="settings.glitchEffect" />
            <span class="checkbox-custom"></span>
            TEXT_GLITCH_VIBRÁLÁS
          </label>

          <label class="cyber-checkbox-label">
            <input type="checkbox" v-model="settings.isTransparent" />
            <span class="checkbox-custom"></span>
            INTERFÉSZ_ÁTLÁTSZÓSÁG
          </label>

          <div class="settings-row">
            <span class="setting-label">NEON_RENDSZER_STÍLUS:</span>
            <select v-model="settings.theme" @change="applyTheme(settings.theme)" class="cyber-select">
              <option value="cyan-punk">CYAN_PUNK</option>
              <option value="matrix-core">MATRIX_CORE</option>
              <option value="tokyo-drive">TOKYO_DRIVE</option>
            </select>
          </div>
        </div>
      </div>

      <div v-else-if="showCopyright" :class="['cyber-copyright-panel', { 'solid-bg': !settings.isTransparent }]">
        <div class="playlist-header">
          <span>📜</span> SYSTEM_INFO_&_COPYRIGHT <span>📜</span>
        </div>
        
        <div class="copyright-content">
          <div class="copyright-image-container">
            <img src="./assets/cpap_logo.png" class="copyright-neon-logo" alt="CPAP Logo" />
          </div>
          <div class="copyright-brand">CPAP AUDIO PLAYER</div>
          <div class="copyright-version">VERSION 1.26.05.26b-pb (Production Build)</div>
          
          <div class="cyber-divider"></div>
          
          <p class="copyright-text">
           CPAP - Cross Platform Audio Player. © 2026 Minden jog fenntartva. A szoftver moduláris felépítésű, Chromium WEB Böngésző motorral szerelt modern webes technológiákat használó platformfüggetlen zenelejátszó kliensalkalmazás. 
          </p>
          
          <div class="specs-table">
            <div class="spec-row"><span class="label">KÖRNYEZET:</span><span class="val">Electron/Vue3/VITE/CHROMIUM</span></div>
            <div class="spec-row"><span class="label">RENDSZER:</span><span class="val">Cross Platform Alkalmazás</span></div>
            <div class="spec-row"><span class="label">LICENC:</span><span class="val">End-User Proprietary License</span></div>
            <div class="spec-row"><span class="label">KÉSZÍTETTE:</span><span class="val">Hegedűs Alex (jacekbacsi01)</span></div>
            <div class="spec-row"><span class="label">KÉSZÍTÉS IDEJE:</span><span class="val">2026.05.26.</span></div>
          </div>

          <button @click="showCopyright = false" class="cyber-btn close-copyright-btn">
            >> RENDSZER_VISSZALÉPÉS
          </button>
        </div>
      </div>

      <div v-else :class="['player-playlist', { 'solid-bg': !settings.isTransparent }]">
        <div class="playlist-header">📜 LEJÁTSZÁSI_LISTA 📜</div>
        
        <div class="search-container">
          <input 
            type="text" 
            v-model="searchQuery" 
            placeholder="🔍 Keresés (szám címe vagy előadó)..." 
            class="cyber-search-input"
          />
          <button v-if="searchQuery" @click="searchQuery = ''" class="search-clear-btn">X</button>
        </div>

        <div class="playlist-content">
          <div 
            v-for="(track) in filteredPlaylist" 
            :key="track.path"
            :class="['playlist-item', { active: track.path === playlist[currentTrackIndex ?? -1]?.path }]"
            @click="playTrack(playlist.indexOf(track))"
            @mouseenter="handleMouseEnter"
            @mouseleave="handleMouseLeave"
          >
            <span class="index">{{ String(playlist.indexOf(track) + 1).padStart(2, '0') }}</span>
            
            <span class="details">
              <span class="scroll-text">{{ track.artist }} // {{ track.title }}</span>
            </span>
            
            <span class="dur">{{ formatTime(track.duration) }}</span>
          </div>
          
          <div v-if="filteredPlaylist.length === 0" class="empty-list">
            >> [RENDSZER]: Nincs a keresésnek megfelelő találat.
          </div>
        </div>
      </div>

      <div class="window-resize-handle"></div>

    </div>
  </div>
</template>

<style>
/* --- TÉMA PROFILOK --- */
:root, [data-theme="cyan-punk"] {
  --neon-cyan: #00ffff;
  --neon-magenta: #ff00ff;
  --panel-bg: rgba(6, 6, 14, 0.9);
  --font-glow: 0 0 8px rgba(0, 255, 255, 0.6);
}

[data-theme="matrix-core"] {
  --neon-cyan: #00ff00;
  --neon-magenta: #004400;
  --panel-bg: rgba(0, 8, 2, 0.95);
  --font-glow: 0 0 8px rgba(0, 255, 0, 0.6);
}

[data-theme="tokyo-drive"] {
  --neon-cyan: #ff5500;
  --neon-magenta: #00ffaa;
  --panel-bg: rgba(15, 5, 5, 0.9);
  --font-glow: 0 0 8px rgba(255, 85, 0, 0.6);
}

/* FIGYELMEZTETÉS: Cseréld ki a régi fix színeidet (pl. border: 1px solid #00ffff) 
   a megfelelő helyeken erre: border: 1px solid var(--neon-cyan); */

/* --- ÚJ ELEMEK STÍLUSA --- */
.folder-path-indicator {
  font-size: 10px;
  color: var(--neon-cyan);
  opacity: 0.7;
  padding: 6px 12px;
  background: rgba(0, 0, 0, 0.4);
  border-bottom: 1px solid rgba(0, 255, 255, 0.1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 6px;
}

.pulse-dot {
  width: 4px;
  height: 4px;
  background: var(--neon-cyan);
  border-radius: 50%;
  box-shadow: var(--font-glow);
}

.settings-panel-content {
  display: flex;
  flex-direction: column;
  padding: 10px;
  height: 100%;
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 15px 10px;
}

/* CYBERPUNK CHECKBOX */
.cyber-checkbox-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  letter-spacing: 1px;
  color: #fff;
  cursor: pointer;
  user-select: none;
}

.cyber-checkbox-label input {
  display: none;
}

.checkbox-custom {
  width: 14px;
  height: 14px;
  border: 1px solid var(--neon-cyan);
  background: #000;
  position: relative;
  transition: all 0.2s;
}

.cyber-checkbox-label input:checked + .checkbox-custom {
  box-shadow: var(--font-glow);
}

.cyber-checkbox-label input:checked + .checkbox-custom::after {
  content: '';
  position: absolute;
  top: 3px; left: 3px; width: 6px; height: 6px;
  background: var(--neon-cyan);
}

/* CYBERPUNK SELECT / LENYÍLÓ */
.settings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 5px;
}

.setting-label {
  font-size: 11px;
  letter-spacing: 1px;
}

.cyber-select {
  background: #000;
  border: 1px solid var(--neon-cyan);
  color: #fff;
  font-family: monospace;
  padding: 4px 8px;
  outline: none;
  cursor: pointer;
  font-size: 11px;
}

.cyber-select:focus {
  box-shadow: var(--font-glow);
}

.neon-toggle-btn {
  border: 1px solid rgba(255,255,255,0.2) !important;
  padding: 2px 8px !important;
  font-size: 10px !important;
}

.neon-toggle-btn.active-btn {
  border-color: var(--neon-cyan) !important;
  color: var(--neon-cyan) !important;
  box-shadow: var(--font-glow);
}


/* --- AZ ELŐZŐ STÍLUSOK MEGMTARTÁSA + AZ ÚJ ELEMEK FORMÁZÁSA --- */
:root {
  --neon-cyan: #00ffff;
  --neon-magenta: #ff00ff;
  --neon-blue: #0066ff;
  --bg-dark: #030307;
  --panel-bg: rgba(13, 13, 25, 0.75);
  --font-main: 'Share Tech Mono', monospace;
}

@import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');

body {
  margin: 0;
  padding: 0;
  background: transparent !important; /* Így nem lesz fehér/fekete háttér az asztalon! */
  overflow: hidden;
  font-family: var(--font-main);
}

/* 2. A lejátszó fix szélességű és körbeöleli a dizájnt */
/* A legkülső konténer követi az ablak méretét, de korlátozzuk a belső elemek torzulását */
.cyber-player {
  width: 410px;
  height: 100vh; /* Mindig pontosan akkora, mint az Electron ablak */
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 10px;
  box-sizing: border-box;
  position: relative;
  overflow: hidden; /* Megakadályozza a felesleges görgetősávokat a főablakon */
}

/* 3. AZ ABLAK MOZGATHATÓSÁGA */
.window-drag-area {
  -webkit-app-region: drag; /* EZZEL MONDJUK MEG AZ ELECTRONNAK, HOGY EZT MEG LEHET FOGNI ÉS HÚZNI! */
}

/* A gombok viszont NE legyenek megfoghatók, különben nem lehetne rájuk kattintani! */
.header-action-buttons, .cyber-btn, .neon-slider, .volume-slider, .playlist-content, .search-container input {
  -webkit-app-region: no-drag; 
}

/* --- ÚJ ABLAKVEZÉRLŐ GOMBOK STÍLUSAI --- */
.window-controls-separator {
  width: 1px;
  height: 16px;
  background: rgba(0, 255, 255, 0.2);
  margin: 0 4px;
}

.window-btn {
  background: transparent;
  border: 1px solid #515167;
  color: #515167;
  font-family: var(--font-main);
  font-size: 11px;
  font-weight: bold;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: 2px;
  transition: all 0.2s;
}

.min-btn:hover {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  box-shadow: 0 0 8px var(--neon-cyan);
}

.close-btn:hover {
  border-color: #ff3333;
  color: #ff3333;
  box-shadow: 0 0 8px #ff3333;
}

/* A TE EREDETI KÓDOD (VÁLTOZATLANUL MEGMINTÁZVA) */
.player-main, .player-playlist {
  flex-grow: 0;   
  flex-shrink: 0; 
  background: var(--panel-bg);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(0, 255, 255, 0.25);
  border-radius: 6px;
  padding: 18px;
  box-shadow: 0 0 20px rgba(0, 102, 255, 0.25);
  position: relative;
  
  /* JAVÍTÁS: Garantáljuk, hogy a doboz NE vágja le a saját árnyékát és sarokdíszeit */
  overflow: visible !important; 
}

/* A TE EREDETI SAROKDÍSZEID (VÁLTOZATLAN) */
.player-main::before, .player-playlist::before {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 12px; height: 12px;
  border-top: 2px solid var(--neon-cyan);
  border-left: 2px solid var(--neon-cyan);
}

.neon-header {
  -webkit-app-region: drag; /* Ezzel válik az egész léc fogantyúvá */
  display: flex;
  justify-content: space-between;
  align-items: center;
  
  /* Biztosítsunk fix magasságot, hogy a gombok között is legyen szabad felület a fogáshoz */
  height: 35px; 
  width: 100%;
}

/* A gombok csoportja természetesen szintén no-drag kell legyen, hogy lehessen őket kattintani */
.header-action-buttons {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
}

.glitch-text {
  color: var(--neon-cyan);
  font-size: 15px;
  letter-spacing: 2px;
  text-shadow: 0 0 6px var(--neon-cyan);
  font-weight: bold;
}

.neon-add-btn {
  background: transparent;
  border: 1px solid var(--neon-magenta);
  color: var(--neon-magenta);
  font-size: 14px;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 3px;
  box-shadow: 0 0 6px rgba(255, 0, 255, 0.3);
  transition: all 0.2s;
}

.neon-add-btn:hover {
  background: var(--neon-magenta);
  box-shadow: 0 0 15px var(--neon-magenta);
  color: black;
}

.folder-btn {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  box-shadow: 0 0 6px rgba(0, 255, 255, 0.3);
}

.folder-btn:hover {
  background: var(--neon-cyan);
  box-shadow: 0 0 15px var(--neon-cyan);
  color: black;
}

.visualizer-panel {
  background: #040408;
  border: 1px solid rgba(0, 255, 255, 0.25);
  height: 85px; /* <-- ÚJ: Magasabb doboz a skáláknak és értékeknek */
  margin-bottom: 15px;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  box-shadow: 
    inset 0 0 20px rgba(0, 0, 0, 1),
    0 0 10px rgba(0, 102, 255, 0.1);
  cursor: pointer;
  position: relative;
}

/* Egy kis finom rács-háttér effekt magának a panelnek */
.visualizer-panel::before {
  content: '';
  position: absolute;
  top: 0; left: 0; width: 100%; height: 100%;
  background-image: linear-gradient(rgba(0, 255, 255, 0.03) 1px, transparent 1px);
  background-size: 100% 4px;
  pointer-events: none;
}

.visualizer-panel canvas {
  width: 100%;
  height: 100%;
}

.track-display {
  display: flex;
  gap: 15px;
  align-items: center;
  margin-bottom: 15px;
  background: rgba(0, 0, 0, 0.4);
  padding: 8px;
  border-radius: 4px;
}

.neon-cover-border {
  width: 55px;
  height: 55px;
  background: #020205;
  border: 2px solid var(--neon-blue);
  box-shadow: 0 0 10px rgba(0, 102, 255, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  overflow: hidden;
}

.neon-cover-border img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.no-cover {
  font-size: 20px;
  color: var(--neon-blue);
}

.track-details {
  flex-grow: 1;
  overflow: hidden;
}

/* MARQUEE HELYETTI JAVÍTÁS */
.track-title-container {
  overflow: hidden;
  white-space: nowrap;
  width: 100%;
}

.track-title-scroll {
  display: inline-block;     /* Visszaállítjuk, hogy a szöveg hossza határozza meg a méretét */
  padding-left: 0;           /* Nem kell kezdő eltolás, az elejéről akarjuk indítani */
  
  /* LÉNYEGES VÁLTOZÁS: 12 másodperces ciklus, ami oda-vissza mozog (alternate) */
  animation: marquee-delayed 12s ease-in-out infinite alternate;
  
  /* MEGLÉVŐ DESIGN (VÁLTOZATLAN) */
  color: #fff;
  font-size: 15px;
  font-weight: bold;
  text-shadow: 0 0 4px rgba(255, 255, 255, 0.5);
  
  /* Hardveres gyorsítás a korábbi renderelési bug és szellemkép ellen */
  will-change: transform;
  transform: translateZ(0);
}

/* ÚJ, IDŐZÍTETT ANIMÁCIÓS LOGIKA */
@keyframes marquee-delayed {
  /* 0% és 20% között (a teljes idő 20%-ában, kb. 2.4 másodpercig) FIXEN ÁLL AZ ELEJÉN */
  0%, 20% { 
    transform: translate3d(0, 0, 0); 
  }
  
  /* 20% és 80% között finoman elgördül a szöveg végéig */
  /* A -50% egy biztonságos becslés, de ha fixen le akarod fedni, használhatod a -100%-ot a konténerhez mérten */
  80%, 100% { 
    transform: translate3d(-50%, 0, 0); 
  }
}

.track-title.waiting { color: #444855; }
.track-artist { color: var(--neon-cyan); font-size: 12px; margin-top: 2px; }

.progress-section {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}

.time-display { font-size: 12px; color: #6c6c84; width: 38px; text-align: center; }

.neon-slider {
  flex-grow: 1;
  -webkit-appearance: none;
  background: #090911;
  height: 5px;
  border-radius: 3px;
  outline: none;
}

.neon-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 14px;
  background: #fff;
  border: 1px solid var(--neon-cyan);
  box-shadow: 0 0 8px var(--neon-cyan);
  cursor: pointer;
}

.bottom-controls { 
  display: flex; 
  flex-direction: column; /* Egymás alá kerülnek */
  gap: 12px; /* Távolság a gombok és a hangerő sáv között */
  align-items: center; 
}

.buttons-group { 
  display: flex; 
  gap: 6px; 
  width: 100%;
  justify-content: center; /* Középre igazítja a gombokat */
}

.cyber-btn {
  background: transparent;
  border: 2px solid var(--neon-cyan);
  color: var(--neon-cyan);
  font-family: var(--font-main);
  font-size: 14px;
  font-weight: bold;
  padding: 6px 16px;
  cursor: pointer;
  text-shadow: 0 0 4px var(--neon-cyan);
}

.cyber-btn:hover { background: rgba(0, 255, 255, 0.08); box-shadow: 0 0 12px rgba(0, 255, 255, 0.4); }
.play-btn { border-color: var(--neon-magenta); color: var(--neon-magenta); text-shadow: 0 0 4px var(--neon-magenta); }
.play-btn:hover { background: rgba(255, 0, 255, 0.08); box-shadow: 0 0 12px rgba(255, 0, 255, 0.4); }

/* FRISSÍTETT HANGERŐ ÉS MUTE STÍLUS */
.volume-group {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(0, 0, 0, 0.4);
  padding: 6px 15px;
  border-radius: 4px;
  border: 1px solid rgba(0, 102, 255, 0.15);
  transition: all 0.3s;
  width: 100%; /* Kitölti a rendelkezésre álló szélességet */
  box-sizing: border-box;
}

.volume-group.is-muted-ui {
  border-color: var(--neon-magenta);
  box-shadow: 0 0 8px rgba(255, 0, 255, 0.2);
}

.mute-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 0;
  display: flex;
  align-items: center;
  transition: transform 0.1s;
}

.mute-btn:active {
  transform: scale(0.85);
}

.volume-slider {
  -webkit-appearance: none;
  background: #090911;
  flex-grow: 1; /* Kitölti a gomb melletti üres helyet */
  height: 4px;
  outline: none;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 8px;
  height: 12px;
  background: var(--neon-blue);
  cursor: pointer;
  box-shadow: 0 0 6px var(--neon-blue);
}

.volume-group.is-muted-ui .volume-slider::-webkit-slider-thumb {
  background: #444;
  box-shadow: none;
}

/* CSAK A LEJÁTSZÁSI LISTA PANELJE MÉRETEZHETŐ */
/* 1. A KÜLSŐ PANELDODOZ (A te meglévő kódod kiegészítése) */
/* 1. A KÜLSŐ PANELDODOZ: Engedjük neki, hogy kövesse az ablak magasságát */
.player-playlist {
  flex-grow: 1;       /* JAVÍTÁS: Most már MEGNYÚLHAT le-fel, ha nagyobb az ablak! */
  flex-shrink: 1;     /* JAVÍTÁS: ÖSSZEZSUGORODHAT, ha kisebb az ablak! */
  background: var(--panel-bg);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(0, 255, 255, 0.25);
  border-radius: 6px;
  padding: 18px;
  box-shadow: 0 0 20px rgba(0, 102, 255, 0.25);
  position: relative;
  overflow: visible !important; /* Ragyogás megtartása */
  
  display: flex;
  flex-direction: column; /* Függőleges elrendezés a belső elemeknek */
  
  /* Opcionális biztonsági korlátok, hogy ne lehessen túlzottan összenyomni */
  min-height: 200px; 
}

.playlist-header {
  background: rgba(0, 0, 0, 0.4);
  color: var(--neon-blue);
  font-size: 13px;
  padding: 10px 15px;
  letter-spacing: 2px;
  font-weight: bold;
  border-bottom: 1px solid rgba(0, 102, 255, 0.2);

  /* ÚJ: SZOFTVERES KÖZÉPRE ZÁRÁS */
  display: flex;
  justify-content: center; /* Vízszintesen középre teszi a szöveget/ikont */
  align-items: center;     /* Függőlegesen is tökéletesen középre igazítja */
  gap: 8px;                /* Ha teszel be ikont a szöveg mellé, ez tartja köztük a cyberpunk távolságot */
}

/* A lista belső tartalma dinamikusan követi a panelt */
/* 2. A BELSŐ TARTALMI DOBOZ: Ez fogja végezni a tiszta görgetést */
/* 2. A BELSŐ TARTALMI DOBOZ: Kitölti a rendelkezésre álló rugalmas helyet */
.playlist-content {
  flex-grow: 1;       /* JAVÍTÁS: Kitölti a .player-playlist teljes megmaradt magasságát */
  flex-shrink: 1;
  min-height: 0;      /* KRITIKUS Flexbox szabály: Engedi a belső listát zsugorodni, különben nem görgetne! */
  
  width: 100%;
  overflow-y: auto;   /* Ha a zenék nem férnek el az épp aktuális méretben, megjelenik a görgetősáv */
  overflow-x: hidden;
  padding-right: 4px;
  margin-top: 10px;
  /* Kényszerített rétegképzés a konténerre is */
  will-change: scroll-position;
  -webkit-overflow-scrolling: touch;
}
/* A láthatatlan széthúzó sáv az ablak legalsó élén */
.window-resize-handle {
  position: absolute;
  bottom: -8px;
  left: 0;
  width: 100%;
  height: 8px;
  cursor: ns-resize;
  z-index: 9999;
  background: transparent;
}
/* Opcionális: Cyberpunk neon görgetősáv a belső tartalomhoz, hogy passzoljon a designhoz */
.playlist-content::-webkit-scrollbar {
  width: 4px;
}
.playlist-content::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.1);
}
.playlist-content::-webkit-scrollbar-thumb {
  background: var(--neon-cyan);
  box-shadow: 0 0 8px var(--neon-cyan);
  border-radius: 2px;
}

/* új */
/* ÚJ BELSŐ GÖRGETŐ KONTÉNER */
.playlist-scroll-container {
  width: 100%;
  max-height: 320px;          /* Beállíthatod a neked tetsző fix magasságra */
  overflow-y: auto;           /* Csak ez a belső rész fog görgetni! */
  overflow-x: hidden;
  padding-right: 4px;         /* Hely a görgetősávnak */
}

/* Opcionális: Cyberpunk neon görgetősáv (scrollbar), hogy illeszkedjen a szoftverhez */
.playlist-scroll-container::-webkit-scrollbar {
  width: 4px;
}
.playlist-scroll-container::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.1);
}
.playlist-scroll-container::-webkit-scrollbar-thumb {
  background: var(--neon-cyan);
  box-shadow: 0 0 8px var(--neon-cyan);
  border-radius: 2px;
}
.playlist-item { 
  display: flex; 
  gap: 12px; 
  padding: 0 15px;               
  height: 32px;                  
  cursor: pointer; 
  font-size: 13px; 
  color: #9292a4; 
  align-items: center; 
  
  /* JAVÍTÁS: Kivettük az overflow: hidden-t innen, hogy a ragyogás és a keret kilátszódjon! */
  position: relative;
  contain: layout;
  
  /* Ha az alsó csíkot borderrel vagy box-shadow-val oldottad meg, az most már meg fog jelenni */
  border-bottom: 1px solid rgba(0, 255, 255, 0.1); 
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
  /* KRITIKUS JAVÍTÁS: Hardveres GPU gyorsítás kényszerítése a renderelési bug ellen */
  transform: translateZ(0);
  backface-visibility: hidden;
  perspective: 1000px;

  /* Biztosítjuk, hogy a hover átmenet sima legyen, de ne ragadjon be */
  will-change: transform, background-color, box-shadow;
}
/* Hover állapot: Itt már biztonságosan hozzáadhatod a neon ragyogást */
.playlist-item:hover { 
  background: rgba(0, 255, 255, 0.04); 
  color: #fff; 
  /* Kifejezett neon ragyogás effekt az egész elem körül */
  box-shadow: 0 0 10px rgba(0, 255, 255, 0.2), inset 0 0 5px rgba(0, 255, 255, 0.1);
  border-bottom-color: rgba(0, 255, 255, 0.4);
}
.playlist-item.active { 
  background: rgba(0, 102, 255, 0.12); 
  color: var(--neon-cyan); 
  border-left: 3px solid var(--neon-cyan); 
  /* Aktív állapot neon ragyogása */
  box-shadow: 0 0 12px rgba(0, 102, 255, 0.3);
}
.playlist-item .index { 
  color: #444855; 
  font-size: 11px; 
}
.playlist-item.active .index { 
  color: var(--neon-magenta); 
}
/* A SZÖVEG DOBOZA: Ez veszi át a vágást, így a szöveg nem úszik rá az indexre vagy a dur-ra! */
/* A részletek tárolója a listán belül (Nem bántja az úszást) */
.playlist-item .details { 
  flex-grow: 1; 
  white-space: nowrap; 
  overflow: hidden;              
  min-width: 0;                  
  height: 100%;                  
  display: flex;
  align-items: center;
}
.playlist-item .dur { 
  font-size: 11px; 
  color: #515167; 
}

.empty-list { 
  font-size: 12px; 
  color: #444855; 
  text-align: center; 
  padding: 35px; 
}
/* STOP GOMB STÍLUS */
.stop-btn {
  border-color: #ff3333 !important;
  color: #ff3333 !important;
  text-shadow: 0 0 4px #ff3333 !important;
}
.stop-btn:hover {
  background: rgba(255, 51, 51, 0.1) !important;
  box-shadow: 0 0 12px rgba(255, 51, 51, 0.4) !important;
}

/* ISMÉTLÉS GOMB ÉS BADGE STÍLUSOK */
.repeat-btn {
  font-size: 12px !important;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px !important;
  border-color: #515167;
  color: #515167;
  text-shadow: none;
}

.mode-badge {
  font-size: 10px;
  font-weight: bold;
  background: #141423;
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid #333;
}

/* Aktív ismétlési módok neon fényei */
.repeat-btn.track {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  text-shadow: 0 0 4px var(--neon-cyan);
}
.repeat-btn.track .mode-badge {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
}

.repeat-btn.list {
  border-color: #aa00ff;
  color: #aa00ff;
  text-shadow: 0 0 4px #aa00ff;
}
.repeat-btn.list .mode-badge {
  border-color: #aa00ff;
  color: #aa00ff;
}

/* KERESŐMEZŐ KONTÉNER ÉS INPUT */
.search-container {
  position: relative;
  padding: 8px 15px;
  background: rgba(0, 0, 0, 0.2);
  border-bottom: 1px solid rgba(0, 102, 255, 0.1);
  display: flex;
  align-items: center;
}

.cyber-search-input {
  width: 100%;
  background: #06060c;
  border: 1px solid rgba(0, 255, 255, 0.2);
  padding: 6px 30px 6px 10px;
  color: #fff;
  font-family: var(--font-main);
  font-size: 13px;
  border-radius: 3px;
  outline: none;
  transition: all 0.3s;
}

.cyber-search-input:focus {
  border-color: var(--neon-cyan);
  box-shadow: 0 0 8px rgba(0, 255, 255, 0.3);
}

.cyber-search-input::placeholder {
  color: #444855;
}

/* TÖRLŐ GOMB AZ INPUTON BELÜL */
.search-clear-btn {
  position: absolute;
  right: 22px;
  background: transparent;
  border: none;
  color: var(--neon-magenta);
  cursor: pointer;
  font-family: var(--font-main);
  font-weight: bold;
  font-size: 11px;
  text-shadow: 0 0 4px var(--neon-magenta);
}

.search-clear-btn:hover {
  color: #fff;
}

.bottom-panel-container {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

/* BEÁLLÍTÁSOK PANEL (Ha aktív) */
.cyber-settings-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel-bg);
  backdrop-filter: blur(12px);
  border: 1px solid var(--neon-cyan);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 0 15px rgba(0, 255, 255, 0.1);
}
/* playlist scroll txt */
.details {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  min-width: 0; /* KRITIKUS: Engedi a flexbox-nak, hogy összenyomja a dobozt, ha hosszú a szöveg */
}

/* BELSŐ SZÖVEG STILIZÁLÁS */
.scroll-text {
  display: inline-block;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;       
  will-change: transform;
  transform: translate3d(0, 0, 0);
  backface-visibility: hidden;
}

/* Amikor a JS elindítja az úszást */
.scroll-text.is-scrolling {
  overflow: visible;
  text-overflow: clip;
  max-width: none;
  width: auto;
  /* Felemeljük 6 másodpercre az időt, hogy a várakozással együtt is kényelmes tempója legyen */
  animation: dynamicMarquee 6s linear infinite;
}
/* Varázslatosan sima 3D-s animáció */
/* A javított animáció olvashatósági szünettel az elején és a végén */
@keyframes dynamicMarquee {
  0% {
    transform: translate3d(0, 0, 0);
  }
  20% {
    /* EDDIG VÁR: A teljes időtartam első 20%-ában (kb. 1.2 másodpercig) a startvonalon marad */
    transform: translate3d(0, 0, 0); 
  }
  85% {
    /* Elúszik a JavaScript által kiszámolt pontos pixel értékig */
    transform: translate3d(var(--scroll-dist, 0), 0, 0);
  }
  100% {
    /* Egy pici szünet a legvégén is, mielőtt hirtelen visszaugrik a legelejére */
    transform: translate3d(var(--scroll-dist, 0), 0, 0);
  }
}

/* Technikai specifikációk sávja az előadó alatt */
.track-tech-specs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
  font-family: 'Courier New', Courier, monospace;
  font-size: 0.7rem;
  letter-spacing: 1px;
}

/* Az információs kis címkék alapstílusa */
.spec-badge {
  padding: 1px 5px;
  border: 1px solid rgba(0, 242, 254, 0.25);
  background: rgba(0, 242, 254, 0.03);
  color: #00f2fe;
  border-radius: 2px;
  text-shadow: 0 0 4px rgba(0, 242, 254, 0.5);
  text-transform: uppercase;
}

/* Külön kiemelés a formátumnak (pl. MP3, FLAC) magenta színnel */
.spec-badge.format {
  color: #ff007f;
  border-color: rgba(255, 0, 127, 0.3);
  text-shadow: 0 0 4px rgba(255, 0, 127, 0.5);
  font-weight: bold;
}

/* A dupla perjelek stílusa */
.spec-divider {
  color: rgba(255, 255, 255, 0.2);
  font-weight: normal;
}

/* Adjunk hozzá transition szabályt a meglévő panelekhez, hogy simán váltson át */
.player-main, .player-playlist, .cyber-settings-panel {
  transition: background 0.25s ease, backdrop-filter 0.25s ease;
}

/* ÚJ OSZTÁLY: HA AZ ÁTLÁTSZÓSÁG KI VAN KAPCSOLVA (Csekkbox nincs kipipálva) */
.player-main.solid-bg, 
.player-playlist.solid-bg, 
.cyber-settings-panel.solid-bg {
  background: #0d0e15 !important;   /* Tömör, mély sötét cyberpunk háttérszín */
  backdrop-filter: none !important; /* Elmosási effekt kikapcsolása a jobb teljesítményért */
}

/* Kattintható verziószám a fejlécben */
.copyright-trigger {
  cursor: pointer;
  transition: color 0.2s ease, text-shadow 0.2s ease;
  
  /* Kiszabadítjuk az Electron drag alól, de CSAK a szöveg területét */
  -webkit-app-region: no-drag; 
  
  /* JAVÍTÁS: Nem engedjük, hogy a span szélesebb legyen a kelleténél */
  display: inline-block;
  width: auto;
  
  /* Biztonságos elkülönítés */
  position: relative;
  z-index: 10;
  padding-right: 10px;
}

.copyright-trigger:hover {
  color: var(--neon-cyan) !important;
  text-shadow: 0 0 8px var(--neon-cyan);
}

/* Új copyright panel fő konténere */
.cyber-copyright-panel {
  flex-grow: 1;
  flex-shrink: 1;
  min-height: 0;
  width: 100%;
  background: var(--panel-bg);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(0, 255, 255, 0.25);
  border-radius: 6px;
  padding: 18px;
  box-shadow: 0 0 20px rgba(0, 102, 255, 0.25);
  position: relative;
  overflow: visible !important;
  display: flex;
  flex-direction: column;
  transition: background 0.25s ease, backdrop-filter 0.25s ease;
}

/* Beállítások kikapcsolásakor ez is teli sötét lesz */
.cyber-copyright-panel.solid-bg {
  background: #0d0e15 !important;
  backdrop-filter: none !important;
}

/* Belső szöveges tartalom */
.copyright-content {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 10px 5px;
  color: #9292a4;
  font-size: 12px;
}

.copyright-brand {
  font-size: 16px;
  font-weight: bold;
  color: #fff;
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(255, 255, 255, 0.2);
}

.copyright-version {
  font-size: 10px;
  color: var(--neon-blue);
  margin-top: 4px;
  letter-spacing: 1px;
}

.cyber-divider {
  width: 60%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(0, 255, 255, 0.3), transparent);
  margin: 15px 0;
}

.copyright-text {
  line-height: 1.6;
  max-width: 300px;
  margin-bottom: 15px;
}

/* Kis adatrács a verzióinformációknak */
.specs-table {
  width: 100%;
  max-width: 280px;
  margin-bottom: 20px;
  background: rgba(0, 0, 0, 0.2);
  padding: 8px;
  border-radius: 4px;
  border: 1px solid rgba(0, 102, 255, 0.1);
}

.spec-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 11px;
}

.spec-row .label {
  color: #515167;
}

.spec-row .val {
  color: var(--neon-cyan);
  font-weight: bold;
}

/* Visszalépés gomb */
.close-copyright-btn {
  width: 100%;
  max-width: 200px;
  padding: 8px;
  background: rgba(0, 255, 255, 0.05);
  border: 1px solid var(--neon-cyan);
  color: var(--neon-cyan);
  cursor: pointer;
  font-size: 11px;
  font-weight: bold;
  letter-spacing: 1px;
  transition: all 0.2s ease;
}

.close-copyright-btn:hover {
  background: var(--neon-cyan);
  color: #000;
  box-shadow: 0 0 12px var(--neon-cyan);
}

/* Képes logó konténere */
.copyright-image-container {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 15px; /* Távolság a CPAP AUDIO PLAYER felirattól */
}

/* A konkrét logó kép stíluslapja */
.copyright-neon-logo {
  width: 120px;        /* Fix, ideális szélesség a panelen belül */
  height: 120px;       /* Fix magasság, hogy tökéletesen kerek maradjon */
  object-fit: contain; /* Biztosítja, hogy a kép ne torzuljon el */
  border-radius: 50%;  /* Mivel a generált logó kerek, a széleit finoman lekerekítjük */
  
  /* Cyberpunk neonos ragyogás a kép köré, ami illeszkedik a lejátszó stílusához */
  box-shadow: 0 0 15px rgba(0, 255, 255, 0.3), inset 0 0 10px rgba(0, 102, 255, 0.2);
  border: 1px solid rgba(0, 255, 255, 0.2);
  
  /* Sima átmenet, ha esetleg hover effektet kapna */
  transition: transform 0.3s ease, box-shadow 0.3s ease;
  user-select: none;
  -webkit-user-drag: none; /* Megakadályozza, hogy a képet véletlenül "kihúzzák" az ablakból */
}

.copyright-neon-logo:hover {
  transform: scale(1.03);
  /* JAVÍTÁS: Pontosvesszővel lezárva a box-shadow, és külön sorba téve a border */
  box-shadow: 0 0 22px rgba(0, 255, 255, 0.5);
  border: 1px solid rgba(0, 255, 255, 0.4);
}
</style>