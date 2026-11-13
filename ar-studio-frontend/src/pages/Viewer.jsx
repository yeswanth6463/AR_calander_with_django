import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as THREE from 'three'
import { createGltfLoader } from '../ar/gltfLoader'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import {
  ImageTracker,
  loadTargetBundle,
  extractFrame,
  grabGray,
  paddedRoiFromCorners,
  validateProjectedQuad,
  noteTrackerTiming,
  releaseTrackerRuntime,
  getTrackerDiagnostics,
  TRACK_CONFIG,
} from '../ar/tracker'
import {
  FlowTracker,
  FLOW_CONFIG,
  flowSupported,
  quadFromH,
  quadDistance,
  releaseFlowRuntime,
} from '../ar/flowTracker'
import {
  poseFromHomography,
  poseTranslation,
  filterCorners,
  ONE_EURO,
  ONE_EURO_FLOW,
  verticalFovForFrame,
  getQuadHomography,
} from '../ar/pose'
import {
  attachContentToTargetAnchor,
  applyARItemTransform,
  fitModelToMarker,
  createContactShadow,
  CONTACT_SHADOW_ENABLED,
} from '../ar/sceneTransform'
import { createAnimationController } from '../ar/animation'
import { applyTextureBudget } from '../ar/textureBudget'
import { createMediaPanel } from '../ar/mediaPanel'
import { isFlatMedia } from '../ar/anchors'
import { createGameEngine } from '../ar/gameEngine'
import { relUrl } from '../ar/contentLoader'
import { loadOpenCvOnPage } from '../ar/opencvRuntime'
import { startTrackingWorkers, trackingWorkersSupported } from '../ar/trackingWorkers'
import TrackingViewer from './TrackingViewer'
import ModelViewer from './ModelViewer'
import { createTapInteraction } from '../ar/interaction'
import { createManipulation } from '../ar/manipulation'
import {
  disposeObject3D,
  friendlyUploadError,
  localCenterOf,
  prepareModel,
  uploadModelFile,
  validateModelFile,
} from '../ar/modelAssets'
import { ModelSwitcherDrawer, ViewerManipulationHud } from '../components/ModelManipulator'
import { playSound, runTapActions, tapActionsOf, usesScore } from '../ar/behaviors'
import { describeGoal, formatTime, gameUsesScore, hasWon, isCollectible } from '../ar/game'
import AnimationPanel from '../components/AnimationPanel'
import { api } from '../api'

const rel = (url) => {
  try {
    return new URL(url, window.location.origin).pathname
  } catch {
    return url
  }
}

const cvReady = (cv) =>
  typeof cv?.Mat === 'function' &&
  typeof cv?.imread === 'function' &&
  typeof cv?.findHomography === 'function' &&
  (typeof cv?.ORB_create === 'function' || typeof cv?.ORB === 'function')

const waitForCv = () =>
  new Promise((resolve, reject) => {
    const t0 = performance.now()
    let waiting = false
    const tick = setInterval(() => {
      const cv = window.cv
      if (!cv) return
      if (cvReady(cv)) {
        clearInterval(tick)
        resolve()
        return
      }
      // Emscripten's then() resolves with the ready module — which can be a
      // *different object* than the one assigned to window.cv. Rebind it.
      if (!waiting && typeof cv.then === 'function') {
        waiting = true
        cv.then((mod) => {
          if (cvReady(mod)) window.cv = mod
          if (cvReady(window.cv)) {
            clearInterval(tick)
            resolve()
          } else {
            waiting = false
          }
        }).catch(() => {
          waiting = false
        })
      }
      if (performance.now() - t0 > 25000) {
        clearInterval(tick)
        reject(new Error('OpenCV failed to load — check your network / CDN'))
      }
    }, 100)
  })

const LOSS_GRACE_MS = 1200
/** Max WebGL drawing-buffer pixels for the AR overlay (~1280×860). */
const MAX_RENDER_PIXELS = 1_100_000

/**
 * Upload a freshly loaded model's textures and compile its shaders now,
 * while the loading screen is up, instead of on the first frame it becomes
 * visible (which froze the viewer for up to seconds on big models).
 */
async function warmUpModel(renderer, model, camera, scene) {
  try {
    await renderer.compileAsync(model, camera, scene)
  } catch {
    /* compileAsync unsupported: shaders compile on first draw */
  }
  const seen = new Set()
  model.traverse((child) => {
    const mats = Array.isArray(child.material) ? child.material : child.material ? [child.material] : []
    for (const mat of mats) {
      for (const value of Object.values(mat)) {
        if (value?.isTexture && !seen.has(value)) {
          seen.add(value)
          renderer.initTexture(value)
        }
      }
    }
  })
}
/** Targets matched per camera frame while searching (nothing locked). */
const SEARCH_TARGETS_PER_TICK = 2

/** Debug switch: localStorage.arTrackerMainThread = '1' → old main-thread tracking. */
const forceMainThreadTracking = () => {
  try {
    return localStorage.getItem('arTrackerMainThread') === '1'
  } catch {
    return false
  }
}

/** RGBA pixels of an image, long edge capped (for compiling a target in a worker). */
const imageDataOf = (img, maxEdge = 2048) => {
  const k = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.naturalWidth * k))
  c.height = Math.max(1, Math.round(img.naturalHeight * k))
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, c.width, c.height)
  return ctx.getImageData(0, 0, c.width, c.height)
}
// While optical flow holds the target, re-run ORB this often to catch drift.
const REDETECT_EVERY_TICKS = 12
// Reseed flow when ORB disagrees by more than this fraction of the quad size.
const DRIFT_FRAC = 0.02
const DRIFT_MIN_PX = 5

let chimeCtx = null
const playChime = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) return
    // One shared context: creating one per chime is slow and browsers cap them.
    if (!chimeCtx || chimeCtx.state === 'closed') chimeCtx = new AudioCtx()
    const ctx = chimeCtx
    if (ctx.state === 'suspended') ctx.resume?.()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.connect(gain)
    gain.connect(ctx.destination)
    const now = ctx.currentTime
    osc.frequency.setValueAtTime(587.33, now) // D5
    osc.frequency.setValueAtTime(880.0, now + 0.08) // A5
    gain.gain.setValueAtTime(0.14, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35)
    osc.start(now)
    osc.stop(now + 0.35)
  } catch {
    /* safely ignore if autoplay policy blocks chime */
  }
}

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load target image'))
    img.src = src
  })

const waitForVideo = (video) =>
  new Promise((resolve, reject) => {
    if (video.videoWidth && video.videoHeight) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Camera timed out before producing a frame'))
    }, 8000)
    const onReady = () => {
      cleanup()
      if (video.videoWidth && video.videoHeight) resolve()
      else reject(new Error('Camera produced an empty video stream'))
    }
    const onError = () => {
      cleanup()
      reject(new Error('Camera failed to start'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onReady)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('loadedmetadata', onReady)
    video.addEventListener('error', onError)
  })

async function applySupportedFocus(track) {
  if (!track) return
  try {
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
    const modes = caps.focusMode
    if (Array.isArray(modes) && modes.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
    }
  } catch {
    // Autofocus is device/browser specific; tracking continues without it.
  }
}

async function startCamera() {
  const video = {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { ...video, advanced: [{ focusMode: 'continuous' }] },
      audio: false,
    })
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
  }
  await applySupportedFocus(stream.getVideoTracks()[0])
  return stream
}

const renderDebug = () => {
  try {
    return localStorage.getItem('arTrackerDebug') === '1'
  } catch {
    return false
  }
}

// Closed-form 4-point homography from target corners → (smoothed) frame corners.
// Bypasses OpenCV matrix allocations for instant computation with zero GC pauses.
const poseFromCorners = (targetW, targetH, corners, frameW, frameH, fovDeg) => {
  const arr = getQuadHomography(targetW, targetH, corners)
  if (!arr) return null
  return poseFromHomography(arr, frameW, frameH, fovDeg, targetW)
}

/**
 * Public viewer entry: loads the published experience once and hands it to
 * the viewer for its project type (image target / face / object).
 */
export default function Viewer() {
  const { publicId } = useParams()
  const [loaded, setLoaded] = useState({ id: null, exp: null, error: '' })

  useEffect(() => {
    let cancelled = false
    api(`/public/${publicId}/`)
      .then((exp) => !cancelled && setLoaded({ id: publicId, exp, error: '' }))
      .catch((err) => !cancelled && setLoaded({ id: publicId, exp: null, error: err.message || 'Experience not found.' }))
    return () => {
      cancelled = true
    }
  }, [publicId])

  const current = loaded.id === publicId ? loaded : { exp: null, error: '' }
  const exp = current.exp
  const loadError = current.error

  if (loadError) {
    return (
      <div className="viewer-root">
        <div className="viewer-error-overlay">
          <div className="viewer-error-card">
            <div className="error-icon">⚠️</div>
            <div>{loadError}</div>
            <Link to="/" className="btn btn-primary" style={{ marginTop: 16 }}>
              Back to AR Studio
            </Link>
          </div>
        </div>
      </div>
    )
  }
  if (!exp) {
    return (
      <div className="viewer-root">
        <div className="camstage-msg">loading experience…</div>
      </div>
    )
  }
  if (exp.project_type === 'face' || exp.project_type === 'object') {
    return <TrackingViewer key={publicId} exp={exp} />
  }
  if (
    exp.project_type === 'image_ar' &&
    (exp.mode === 'user_model' || exp.type_settings?.mode === 'user_model')
  ) {
    return <ModelViewer key={publicId} exp={exp} />
  }
  return <ImageViewer key={publicId} preloaded={exp} />
}

function ImageViewer({ preloaded }) {
  const { publicId } = useParams()
  const videoRef = useRef(null)
  const camRef = useRef(null)
  const glRef = useRef(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('loading experience…')
  const [isReady, setIsReady] = useState(false)
  const [targetFound, setTargetFound] = useState(false)
  const [foundAlert, setFoundAlert] = useState(false)
  const [hintText, setHintText] = useState('Point camera directly at target image')
  const [animController, setAnimController] = useState(null)
  const [showAnimPanel, setShowAnimPanel] = useState(false)
  const alertTimerRef = useRef(null)
  const [score, setScore] = useState(null) // null = this experience has no scoring
  const [toast, setToast] = useState(null) // { text, key }
  const toastTimerRef = useRef(null)
  // Game mode (Project.game_settings, only when enabled on the published link)
  const [game, setGame] = useState(null) // { settings, title, goalText }
  const [gamePhase, setGamePhase] = useState(null) // 'intro' | 'playing' | 'won' | 'lost' | 'over'
  const [timeLeft, setTimeLeft] = useState(null) // seconds, null = no clock
  const [endText, setEndText] = useState('') // custom win/lose text from game logic
  const gameApiRef = useRef(null) // { start() } — set by the viewer effect

  // 3D model manipulation + model switcher (marker experience with a 3D item)
  const modelApiRef = useRef(null) // { swap, reset }
  const [manipReady, setManipReady] = useState(false)
  const [models, setModels] = useState([])
  const [activeModelId, setActiveModelId] = useState(null)
  const [showModels, setShowModels] = useState(false)
  const [swappingModel, setSwappingModel] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadError, setUploadError] = useState('')

  useEffect(() => {
    let disposed = false
    const groups = new Map()
    let cameraStream = null
    let trackingClient = null // Web Worker tracking (null = main-thread fallback)
    let stop = () => {
      trackingClient?.dispose()
      for (const g of groups.values()) {
        g.tracker?.dispose?.()
        g.flow?.dispose?.()
      }
      releaseTrackerRuntime()
      releaseFlowRuntime()
      cameraStream?.getTracks().forEach((t) => t.stop())
    }
    // JS scroll-lock fallback for browsers without :has() support.
    document.body.classList.add('viewer-mode')

    ;(async () => {
      try {
        const exp = preloaded || (await api(`/public/${publicId}/`))
        if (disposed) return

        setStatus('loading tracker…')
        // Tracking (OpenCV) runs in Web Workers so it never blocks rendering;
        // OpenCV is only loaded on the page for the main-thread fallback.
        const useWorkers = trackingWorkersSupported() && !forceMainThreadTracking()
        if (!useWorkers) {
          await loadOpenCvOnPage()
          await waitForCv()
        }
        if (disposed) return

        let sourceItems = []
        if (Array.isArray(exp.scenes) && exp.scenes.length) {
          for (const s of exp.scenes) {
            if (Array.isArray(s.items)) {
              sourceItems.push(...s.items)
            }
          }
        }
        if (!sourceItems.length && Array.isArray(exp.items) && exp.items.length) {
          sourceItems = exp.items
        }
        if (!sourceItems.length && exp.target && exp.model) {
          sourceItems = [
            {
              id: 'legacy',
              name: exp.name,
              target: exp.target,
              model: exp.model,
              transform: exp.transform,
            },
          ]
        }
        const items = sourceItems.filter(
          (item) => item?.target?.image_url && item?.model?.url && item.is_active !== false
        )
        if (!items.length) {
          throw new Error('Experience has no target image or model.')
        }

        // One tracker + one anchor per distinct target image; items sharing a
        // marker become siblings under the same anchor.
        for (const item of items) {
          const key = item.target.image_url
          if (!groups.has(key)) groups.set(key, { target: item.target, items: [] })
          groups.get(key).items.push(item)
        }

        setStatus(
          `loading ${groups.size} target image${groups.size > 1 ? 's' : ''}…`
        )
        // Server-compiled bundle (one file for all targets); any target
        // missing from it is compiled here from its image as a fallback.
        let bundle = null
        try {
          bundle = await loadTargetBundle(exp.compiled_targets?.url ? rel(exp.compiled_targets.url) : null)
        } catch (err) {
          console.warn('[AR] compiled targets unavailable, compiling locally', err)
        }
        if (disposed) return

        if (useWorkers) {
          for (const g of groups.values()) g.key = String(g.target.id || g.target.image_url)
          try {
            trackingClient = await startTrackingWorkers({
              targets: [...groups.values()].map((g) => ({
                key: g.key,
                entry: bundle?.get(String(g.target.id || '')) || null,
                imageUrl: rel(g.target.image_url),
              })),
              loadImageData: async (url) => imageDataOf(await loadImage(url)),
              drift: { minPx: DRIFT_MIN_PX, frac: DRIFT_FRAC },
            })
          } catch (err) {
            console.warn('[AR] tracking workers unavailable, tracking on the main thread', err)
            trackingClient = null
            await loadOpenCvOnPage()
            await waitForCv()
          }
          if (disposed) {
            trackingClient?.dispose()
            return
          }
        }

        for (const g of groups.values()) {
          if (trackingClient) {
            // Matching + flow live in the workers; the page only needs the
            // compiled target size (pose solve, content aspect).
            const size = trackingClient.sizes.get(g.key)
            g.tracker = { targetW: size.width, targetH: size.height, dispose() {} }
            g.flow = { reset() {}, dispose() {} }
            g.smooth = null
            g.lastFound = 0
            continue
          }
          g.tracker = new ImageTracker()
          const entry = bundle?.get(String(g.target.id || ''))
          let loaded = false
          if (entry) {
            try {
              g.tracker.loadCompiled(entry)
              loaded = true
            } catch (err) {
              console.warn('[AR] bad compiled target, compiling locally', err)
            }
          }
          if (!loaded) {
            const targetImg = await loadImage(rel(g.target.image_url))
            if (disposed) return
            g.tracker.compile(targetImg)
          }
          g.flow = new FlowTracker()
          g.smooth = null
          g.lastFound = 0
        }

        setStatus('starting camera…')
        const stream = await startCamera()
        cameraStream = stream
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        video.playsInline = true
        video.autoplay = true
        video.muted = true
        video.srcObject = stream
        await waitForVideo(video)
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        await video.play()

        const glCanvas = glRef.current
        // Frame-locked camera background: every tracked frame is drawn here and
        // the model is rendered with that same frame's pose, so the model can't
        // slide against a newer frame shown by the <video> element.
        const camCanvas = camRef.current
        // GPU-backed: this canvas is only drawn and displayed. Pixel reads happen
        // on the small processing canvases in tracker.js (willReadFrequently there).
        const camCtx = camCanvas.getContext('2d', { alpha: false })
        const useFlow = trackingClient ? trackingClient.flow : flowSupported()
        if (renderDebug()) console.info('[AR viewer] optical flow', useFlow ? 'enabled' : 'unavailable → detection only')
        const renderer = new THREE.WebGLRenderer({
          canvas: glCanvas,
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance',
        })
        renderer.setClearColor(0x000000, 0)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.05
        // Drawing buffer sized to what is actually shown on screen (cover
        // layout × device pixels), capped at MAX_RENDER_PIXELS. It used to be
        // camera resolution × DPR (e.g. 3840×2160 for a 1080p camera).
        let lastBufW = 0
        let lastBufH = 0
        const sizeRenderer = (vw, vh) => {
          const root = glCanvas.parentElement
          const cover = root?.clientWidth ? Math.max(root.clientWidth / vw, root.clientHeight / vh) : 1
          const deviceScale = Math.min(window.devicePixelRatio || 1, 2)
          const w = vw * cover * deviceScale
          const h = vh * cover * deviceScale
          const k = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (w * h)))
          const bw = Math.max(1, Math.round(w * k))
          const bh = Math.max(1, Math.round(h * k))
          if (bw === lastBufW && bh === lastBufH) return
          lastBufW = bw
          lastBufH = bh
          renderer.setPixelRatio(1)
          renderer.setSize(bw, bh, false)
        }
        sizeRenderer(video.videoWidth, video.videoHeight)

        const scene = new THREE.Scene()
        const pmremGenerator = new THREE.PMREMGenerator(renderer)
        pmremGenerator.compileEquirectangularShader()
        const roomEnv = new RoomEnvironment()
        const envTexture = pmremGenerator.fromScene(roomEnv, 0.04).texture
        scene.environment = envTexture

        const camera = new THREE.PerspectiveCamera(50, video.videoWidth / video.videoHeight, 0.01, 1000)
        scene.add(camera)

        // Soft hemisphere ambient light (same rig as the studio preview, so a
        // model does not change brightness between the editor and the phone).
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334455, 0.65)
        scene.add(hemiLight)

        // Key light (camera relative: illuminates front-right face crisp and bright)
        const key = new THREE.DirectionalLight(0xffffff, 1.45)
        key.position.set(0.5, 1.0, 1.2)
        camera.add(key)

        // Fill light (camera relative: fills shadows with subtle sky tone)
        const fill = new THREE.DirectionalLight(0x90b4d6, 0.5)
        fill.position.set(-0.8, 0.1, 0.5)
        camera.add(fill)

        // Rim / Back light (camera relative: adds depth separation against real room background)
        const rim = new THREE.DirectionalLight(0xffeedd, 0.45)
        rim.position.set(0, -0.6, -1.0)
        camera.add(rim)

        const applyCoverLayout = (el, vw, vh) => {
          const root = el?.parentElement
          if (!root || !vw || !vh) return
          const cw = root.clientWidth
          const ch = root.clientHeight
          const scale = Math.max(cw / vw, ch / vh)
          const w = vw * scale
          const h = vh * scale
          el.style.position = 'absolute'
          el.style.width = `${w}px`
          el.style.height = `${h}px`
          el.style.left = `${(cw - w) / 2}px`
          el.style.top = `${(ch - h) / 2}px`
          el.style.right = 'auto'
          el.style.bottom = 'auto'
          el.style.objectFit = 'fill'
        }

        // Orientation / video-size changes: keep drawing-buffer aspect in sync
        // with the camera feed so the pose matrix matches the frame.
        let lastSyncW = 0
        let lastSyncH = 0
        const syncVideoSize = () => {
          const vw = video.videoWidth
          const vh = video.videoHeight
          if (!vw || !vh) return
          if (lastSyncW !== vw || lastSyncH !== vh) {
            lastSyncW = vw
            lastSyncH = vh
            camCanvas.width = vw
            camCanvas.height = vh
            // Old smoothed corners are in pre-rotation frame coords — drop them.
            for (const g of groups.values()) {
              g.smooth = null
              g.cornerFilter = null
              g.flow?.reset()
            }
          }
          // Same intrinsics as poseFromHomography, or the model drifts off the marker.
          camera.fov = verticalFovForFrame(vw, vh)
          camera.aspect = vw / vh
          camera.updateProjectionMatrix()
          sizeRenderer(vw, vh)
          applyCoverLayout(video, vw, vh)
          applyCoverLayout(camCanvas, vw, vh)
          applyCoverLayout(glCanvas, vw, vh)
        }
        // `resize` fires on the video element when videoWidth/Height change
        // (e.g. orientation change); loadedmetadata has already fired by now.
        video.addEventListener('resize', syncVideoSize)
        window.addEventListener('resize', syncVideoSize)
        syncVideoSize()

        const anims = []
        const mediaPanels = []

        // Tap-to-interact: tapping a tracked model pops it and runs the
        // item's tap behaviours (default: play/pause its animation). Also
        // emits `ar-item-tap` on window for game logic.
        const itemEntries = new Map() // item id -> { item, fit }
        let scoreValue = 0
        const gameSettings = exp.game?.enabled ? exp.game : null
        if (usesScore(items) || gameUsesScore(gameSettings)) setScore(0)

        // ---- Game loop: intro → playing → won / lost / over ----
        let phase = gameSettings ? 'intro' : null
        let deadline = 0 // performance.now() ms; 0 = clock not started
        let gameTimer = 0
        const setPhase = (next) => {
          phase = next
          if (!disposed) setGamePhase(next)
        }
        const endGame = (result, text = '') => {
          if (phase !== 'playing') return
          clearInterval(gameTimer)
          gameTimer = 0
          engine?.stop()
          if (!disposed) setEndText(text)
          setPhase(result)
          playSound(result === 'won' ? 'success' : result === 'lost' ? 'fail' : 'chime')
          try {
            navigator.vibrate?.(result === 'won' ? [80, 50, 80, 50, 160] : 200)
          } catch {
            /* ignore */
          }
        }
        const tickClock = () => {
          if (phase !== 'playing' || !gameSettings.time_limit) return
          // The clock starts on the first target lock, not while scanning.
          if (!deadline) {
            if (!lastTrackingState) return
            deadline = performance.now() + gameSettings.time_limit * 1000
          }
          const left = (deadline - performance.now()) / 1000
          if (!disposed) setTimeLeft(Math.max(0, left))
          if (left <= 0) endGame(gameSettings.goal === 'none' ? 'over' : 'lost')
        }
        if (gameSettings) {
          setGame({
            settings: gameSettings,
            title: exp.name || exp.project || 'AR Game',
            goalText: describeGoal(gameSettings, items.filter(isCollectible).length),
          })
          setGamePhase('intro')
          if (gameSettings.time_limit) setTimeLeft(gameSettings.time_limit)
          gameApiRef.current = {
            start: () => {
              // Reset the board to its published starting state.
              scoreValue = 0
              if (!disposed) setScore(gameUsesScore(gameSettings) || usesScore(items) ? 0 : null)
              for (const entry of itemEntries.values()) entry.fit.visible = !entry.item.behaviors?.start_hidden
              deadline = 0
              if (!disposed) setTimeLeft(gameSettings.time_limit || null)
              clearInterval(gameTimer)
              setPhase('playing')
              if (gameSettings.time_limit) gameTimer = setInterval(tickClock, 200)
              playSound('chime') // also unlocks audio on iOS (user gesture)
              engine?.start()
              if (lastTrackingState) engine?.emit('target_found')
            },
          }
        }
        const animOf = (item) => anims.find((a) => a.item === item)
        const behaviorCtx = {
          findItem: (id) => itemEntries.get(id) || null,
          toggleAnimation: (item) => {
            const entry = animOf(item)
            if (!entry) return
            entry.ctl.toggle()
            if (!disposed) setAnimController(entry.ctl)
          },
          playAnimation: (item) => {
            const entry = animOf(item)
            if (!entry) return
            entry.ctl.play()
            if (!disposed) setAnimController(entry.ctl)
          },
          setVisible: (entry, visible) => {
            entry.fit.visible = visible
          },
          addScore: (n) => {
            scoreValue += n
            if (!disposed) setScore(scoreValue)
          },
          playSound,
          showMessage: (text) => {
            if (disposed) return
            setToast({ text, key: performance.now() })
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
            toastTimerRef.current = setTimeout(() => {
              if (!disposed) setToast(null)
            }, 2200)
          },
        }
        // ---- AR Game logic (rule builder + sandboxed script) ----
        const soundCache = new Map()
        const sounds = Array.isArray(exp.sounds) ? exp.sounds : []
        const findEntry = (ref) => {
          if (ref == null) return null
          const key = String(ref)
          const byId = itemEntries.get(key)
          if (byId) return byId
          const lower = key.toLowerCase()
          for (const entry of itemEntries.values()) {
            const names = [entry.item.name, entry.item.model?.name].filter(Boolean).map((n) => n.toLowerCase())
            if (names.includes(lower)) return entry
          }
          return null
        }
        const logic = gameSettings?.logic
        const engine =
          gameSettings && logic
            ? createGameEngine({
                logic,
                adapter: {
                  findItem: findEntry,
                  itemNames: () => [...itemEntries.values()].map((e) => e.item.name || e.item.model?.name || ''),
                  setVisible: (entry, visible) => behaviorCtx.setVisible(entry, visible),
                  toggleAnimation: (entry) => behaviorCtx.toggleAnimation(entry.item),
                  playAnimation: (entry) => behaviorCtx.playAnimation(entry.item),
                  getScore: () => scoreValue,
                  addScore: (n) => behaviorCtx.addScore(n),
                  setScore: (n) => {
                    scoreValue = n
                    if (!disposed) setScore(scoreValue)
                  },
                  playSound,
                  playAssetSound: (ref) => {
                    const lower = String(ref).toLowerCase()
                    const sound = sounds.find((x) => x.id === ref || x.name?.toLowerCase() === lower)
                    if (!sound) return false
                    try {
                      let audio = soundCache.get(sound.id)
                      if (!audio) {
                        audio = new Audio(relUrl(sound.url))
                        audio.preload = 'auto'
                        soundCache.set(sound.id, audio)
                      }
                      audio.currentTime = 0
                      audio.play().catch(() => {})
                    } catch {
                      /* ignore */
                    }
                    return true
                  },
                  showMessage: (text) => behaviorCtx.showMessage(text),
                  win: (text) => endGame('won', text),
                  lose: (text) => endGame('lost', text),
                  isPlaying: () => phase === 'playing',
                },
                onError: (message) => {
                  console.warn('[AR game]', message)
                  behaviorCtx.showMessage(message)
                },
              })
            : null
        if (engine) {
          const ruleScores = (logic.rules || []).some((r) =>
            (r.actions || []).some((a) => a.action === 'add_score' || a.action === 'set_score')
          )
          if (ruleScores || logic.script_enabled) setScore(0)
        }

        const tap = createTapInteraction({ root: glCanvas.parentElement, canvas: glCanvas, camera })
        tap.onTap(({ item }) => {
          try {
            navigator.vibrate?.(25)
          } catch {
            /* ignore */
          }
          if (gameSettings && phase !== 'playing') return
          const self = itemEntries.get(String(item.id))
          if (self) runTapActions(tapActionsOf(item), { ...behaviorCtx, self })
          engine?.emit('tap', { itemId: String(item.id), itemName: item.name || item.model?.name || '' })
          if (gameSettings && hasWon(gameSettings, scoreValue, itemEntries.values())) endGame('won')
          if (renderDebug()) console.info('[AR viewer] tap', item.id, item.model?.name, tapActionsOf(item))
        })
        let pendingModels = items.length
        const doneOne = (_message) => {
          pendingModels--
          if (pendingModels === 0 && !disposed) {
            setStatus('ready')
            setIsReady(true)
          }
        }

        // Anchors: one per distinct target image.
        for (const g of groups.values()) {
          const anchor = new THREE.Object3D()
          anchor.matrixAutoUpdate = false
          anchor.visible = false
          scene.add(anchor)
          g.anchor = anchor

          const targetAspect = g.tracker.targetH / Math.max(g.tracker.targetW, 1)
          const content = new THREE.Group()
          attachContentToTargetAnchor(content, targetAspect)
          anchor.add(content)
          g.content = content
          g.modelReady = false
          g.modelError = ''

          if (renderDebug()) {
            const helper = new THREE.Mesh(
              new THREE.PlaneGeometry(1, targetAspect),
              new THREE.MeshBasicMaterial({
                color: 0x22d3ee,
                transparent: true,
                opacity: 0.22,
                side: THREE.DoubleSide,
                depthWrite: false,
              })
            )
            helper.position.set(0.5, targetAspect / 2, 0.001)
            anchor.add(helper)
          }
        }

        const gltfLoader = createGltfLoader()
        const gltfCache = new Map()
        const loadGltf = (url) => {
          if (!gltfCache.has(url)) {
            gltfCache.set(
              url,
              new Promise((resolve, reject) => {
                gltfLoader.load(
                  url,
                  (gltf) => {
                    // The parser keeps every decoded source image alive (hundreds
                    // of MB on studio models) and nothing needs it once the scene,
                    // animations and textures exist. Drop it so those bitmaps can
                    // be collected after the texture budget pass replaces them.
                    gltf.parser = null
                    resolve(gltf)
                  },
                  undefined,
                  reject
                )
              })
            )
          }
          return gltfCache.get(url)
        }

        // Content: each item gets its own fit group carrying its transform.
        setStatus(
          `loading ${items.length} model${items.length > 1 ? 's' : ''}…`
        )
        if (renderDebug()) {
          console.info('[AR viewer] experience', {
            publicId,
            itemCount: items.length,
            targets: [...groups.keys()],
          })
        }
        // Choose one 3D item as the model the manipulation HUD controls.
        const primaryItem =
          items.find((item) => item?.model?.url && !isFlatMedia(item.model.format)) || null
        const primaryGroup = primaryItem ? groups.get(primaryItem.target.image_url) : null
        let manipulation = null

        for (const item of items) {
          const group = groups.get(item.target.image_url)
          const fit = new THREE.Group()
          const transform = item.transform || {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: 1,
            scale_xyz: [1, 1, 1],
          }
          applyARItemTransform(fit, transform)
          group.content.add(fit)
          tap.register(fit, item, group.anchor)
          const entry = { item, fit, model: null, ctl: null }
          if (item.id != null) itemEntries.set(String(item.id), entry)
          if (item.behaviors?.start_hidden) fit.visible = false

          const modelUrl = item.model?.url
          const modelPath = modelUrl ? rel(modelUrl) : ''
          if (renderDebug()) {
            console.info('[AR viewer] item asset', {
              id: item.id,
              targetId: item.target?.id,
              target: item.target?.name,
              model: item.model?.name,
              url: modelPath,
              format: item.model?.format,
              transform,
              animation: item.animation || null,
            })
          }

          if (!modelPath) {
            group.modelError = 'Experience item has no model URL'
            console.warn('[AR viewer]', group.modelError, item)
            doneOne()
            continue
          }

          if (isFlatMedia(item.model.format)) {
            createMediaPanel(modelPath, item.model.format)
              .then((panel) => {
                if (disposed) {
                  panel.dispose()
                  return
                }
                mediaPanels.push(panel)
                fit.add(panel.mesh)
                group.modelReady = true
                doneOne()
              })
              .catch((err) => {
                group.modelError = err?.message || 'media failed to load'
                console.warn('[AR viewer] media load failed', modelPath, err)
                doneOne()
              })
          } else {
            loadGltf(modelPath)
              .then(async (gltf) => {
                if (disposed) return
                const model = cloneSkinned(gltf.scene)
                const size = fitModelToMarker(model)
                fit.add(model)
                entry.model = model
                if (primaryItem && item === primaryItem) {
                  manipulation?.setPivot(localCenterOf(fit, model))
                  if (!disposed) setManipReady(true)
                }

                if (CONTACT_SHADOW_ENABLED) {
                  const shadow = createContactShadow(size.x, size.z)
                  shadow.userData.noTap = true
                  const pz = Number(item.transform?.position?.[2] || 0)
                  shadow.position.set(0, -pz + 0.0015, 0)
                  fit.add(shadow)
                }

                // Keep GPU texture memory inside what a phone can allocate.
                // Must run before warmUpModel: the first upload is where an
                // over-budget model silently loses its maps. A failure here
                // must never stop the model from loading.
                let texBudget = null
                try {
                  texBudget = await applyTextureBudget(model, { renderer })
                } catch (err) {
                  console.warn('[AR viewer] texture budget skipped', err)
                }
                if (disposed) return

                // Enhance materials and textures with realistic IBL intensity and sRGB color space
                model.traverse((child) => {
                  if (child.isMesh) {
                    // Skinned meshes keep their bind-pose bounds, so culling
                    // can hide them mid-animation; everything else is culled.
                    child.frustumCulled = !child.isSkinnedMesh
                    const mats = Array.isArray(child.material) ? child.material : [child.material]
                    mats.forEach((mat) => {
                      if (!mat) return
                      mat.envMapIntensity = 1.15
                      if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace
                      if (mat.emissiveMap) mat.emissiveMap.colorSpace = THREE.SRGBColorSpace
                      mat.needsUpdate = true
                    })
                  }
                })

                await warmUpModel(renderer, model, camera, scene)
                if (disposed) return
                group.modelReady = true
                if (renderDebug()) {
                  const wp = new THREE.Vector3()
                  fit.getWorldPosition(wp)
                  console.info('[AR viewer] model loaded', {
                    id: item.id,
                    url: modelPath,
                    bbox: size.toArray(),
                    textures: texBudget,
                    local: {
                      position: fit.position.toArray(),
                      rotation: fit.rotation.toArray().slice(0, 3),
                      scale: fit.scale.toArray(),
                    },
                    world: wp.toArray(),
                  })
                }
                if (gltf.animations?.length) {
                  const ctl = createAnimationController({ scene: model, animations: gltf.animations })
                  // Default to continuous repeat in the AR viewer so models loop smoothly
                  ctl.setLoop('repeat')
                  if (item.animation) {
                    ctl.applySettings({
                      ...item.animation,
                      loop: 'repeat',
                      autoplay: true,
                    })
                  }
                  ctl.setLoop('repeat')
                  ctl.play()
                  entry.ctl = ctl
                  anims.push({ ctl, group, item })
                  if (!disposed) {
                    setAnimController((prev) => prev || ctl)
                  }
                }
                doneOne()
              })
              .catch((err) => {
                group.modelError = err?.message || 'model failed to load'
                console.warn('[AR viewer] GLB load failed', modelPath, err)
                doneOne()
              })
          }
        }

        // ---- 3D model manipulation + model switcher --------------------------
        // The fit group is the user-manipulation group: the tracker writes the
        // anchor above it, so gestures can never disturb tracking.
        const primaryEntry =
          primaryItem && primaryItem.id != null ? itemEntries.get(String(primaryItem.id)) : null
        if (primaryEntry) {
          manipulation = createManipulation({
            root: glCanvas.parentElement,
            canvas: glCanvas,
            camera,
          })
          manipulation.setTarget(primaryEntry.fit)
          if (primaryEntry.model) {
            manipulation.setPivot(localCenterOf(primaryEntry.fit, primaryEntry.model))
          }
        }

        // Available project models for the drawer (published item first).
        const modelList = Array.isArray(exp.available_models)
          ? exp.available_models.filter((m) => m?.url)
          : []
        if (
          primaryItem?.model?.url &&
          !modelList.some((m) => m.url === primaryItem.model.url)
        ) {
          modelList.unshift({
            id: `published:${primaryItem.model.url}`,
            name: primaryItem.model.name || 'Published model',
            url: primaryItem.model.url,
            format: primaryItem.model.format || 'glb',
          })
        }
        if (!disposed) {
          setModels(modelList)
          setActiveModelId(modelList.find((m) => m.url === primaryItem?.model?.url)?.id ?? null)
        }

        let primaryModelUrl = primaryItem?.model?.url ? rel(primaryItem.model.url) : ''
        let swapToken = 0

        const swapPrimaryModel = async (model) => {
          if (!primaryEntry || !model?.url) throw new Error('No model selected.')
          const token = ++swapToken
          if (!disposed) setSwappingModel(true)
          try {
            const oldUrl = primaryModelUrl
            const gltf = await loadGltf(rel(model.url))
            if (disposed || token !== swapToken) return

            const nextModel = cloneSkinned(gltf.scene)
            fitModelToMarker(nextModel)

            const oldModel = primaryEntry.model
            const oldCtl = primaryEntry.ctl
            primaryEntry.fit.add(nextModel)
            primaryEntry.model = nextModel
            primaryEntry.ctl = null

            if (oldCtl) {
              oldCtl.dispose()
              const index = anims.findIndex((a) => a.item === primaryEntry.item)
              if (index >= 0) anims.splice(index, 1)
            }
            if (oldModel) {
              const nextUrl = rel(model.url)
              // Another item may still render a clone of the same cached GLTF,
              // and re-selecting a duplicate asset shares it too: only dispose
              // when this URL is no longer referenced.
              const shared = [...itemEntries.values()].some(
                (e) => e !== primaryEntry && e.item?.model?.url && rel(e.item.model.url) === oldUrl
              )
              if (shared || nextUrl === oldUrl) oldModel.removeFromParent()
              else {
                disposeObject3D(oldModel)
                gltfCache.delete(oldUrl)
              }
            }
            primaryModelUrl = rel(model.url)

            try {
              await prepareModel(nextModel, { renderer, camera, scene })
            } catch (err) {
              console.warn('[AR viewer] model preparation skipped', err)
            }
            if (disposed || token !== swapToken) return

            if (gltf.animations?.length) {
              const ctl = createAnimationController({ scene: nextModel, animations: gltf.animations })
              ctl.setLoop('repeat')
              ctl.play()
              primaryEntry.ctl = ctl
              if (primaryGroup) anims.push({ ctl, group: primaryGroup, item: primaryEntry.item })
              if (!disposed) setAnimController(ctl)
            } else if (!disposed) {
              setAnimController(anims[0]?.ctl || null)
            }

            manipulation?.setPivot(localCenterOf(primaryEntry.fit, nextModel))
            if (!disposed) setManipReady(true)
          } finally {
            if (!disposed && token === swapToken) setSwappingModel(false)
          }
        }

        modelApiRef.current = {
          swap: swapPrimaryModel,
          reset: () => manipulation?.reset(),
        }

        let raf = 0
        let lastTrackingState = false
        let trackBusy = false
        let lastTrackAt = 0
        let lastHintAt = 0
        let acquireStartedAt = 0
        let lastPoseLogAt = 0
        const clock = new THREE.Clock()

        const applyDetection = (g, r, now, viaFlow = false) => {
          if (!g.anchor) return false
          const wasLocked = !!g.smooth && now - g.lastFound <= LOSS_GRACE_MS

          if (wasLocked && g.smooth) {
            // Reject sudden wild jump between consecutive frames to prevent ROI runaway drift
            let maxJump = 0
            for (let i = 0; i < 4; i++) {
              const d = Math.hypot(r.corners[i][0] - g.smooth[i][0], r.corners[i][1] - g.smooth[i][1])
              if (d > maxJump) maxJump = d
            }
            if (maxJump > 120) {
              g.jumpCount = (g.jumpCount || 0) + 1
              if (g.jumpCount < 3) return false
              // Rapid camera motion detected over multiple frames: reset smooth corners to snap
              g.smooth = null
            } else {
              g.jumpCount = 0
            }
          }

          // (Re)acquired → restart the filter so it snaps to the new quad.
          if (!wasLocked || !g.smooth) g.cornerFilter = null
          const filtered = filterCorners(g.cornerFilter, r.corners, now / 1000, viaFlow ? ONE_EURO_FLOW : ONE_EURO)
          g.cornerFilter = filtered.state
          g.smooth = filtered.corners
          // Pass video dimensions (NOT glCanvas which is scaled by DPR) so OpenCV K matches camera intrinsics
          const m = poseFromCorners(
            g.tracker.targetW,
            g.tracker.targetH,
            g.smooth,
            video.videoWidth,
            video.videoHeight,
            camera.fov
          )
          if (!m) {
            if (renderDebug() && now - lastPoseLogAt > 2000) {
              lastPoseLogAt = now
              console.warn('[AR viewer] pose rejected', {
                corners: g.smooth,
                frame: [video.videoWidth, video.videoHeight],
                targetPx: [g.tracker.targetW, g.tracker.targetH],
                modelReady: g.modelReady,
                modelError: g.modelError,
              })
            }
            return false
          }

          // Apply the filtered pose directly: the video frame and the model
          // update together, so the model stays glued to the marker instead
          // of lagging/sliding behind it.
          g.anchor.matrix.fromArray(m)
          g.anchor.matrixWorldNeedsUpdate = true
          g.anchor.visible = true
          g.lastFound = now
          if (renderDebug() && now - lastPoseLogAt > 2000) {
            lastPoseLogAt = now
            const t = poseTranslation(m)
            console.info('[AR viewer] pose', {
              visible: g.anchor.visible,
              modelReady: g.modelReady,
              modelError: g.modelError,
              translation: t,
              children: g.anchor.children.length,
            })
          }

          if (!wasLocked) {
            if (acquireStartedAt) {
              noteTrackerTiming(now - acquireStartedAt, 'acquired')
            }
            // Target acquired / re-acquired: ensure 3D model animation is active
            for (const entry of anims) {
              if (entry.group === g) {
                const st = entry.ctl.getState()
                if (st.finished || !st.playing) {
                  entry.ctl.play()
                }
                if (!disposed) {
                  setAnimController(entry.ctl)
                }
              }
            }
          }
          return true
        }

        /**
         * One tracking tick for one target group, on the captured frame `src`.
         *   1. Optical flow (sub-pixel, frame-to-frame) when it holds the target.
         *   2. ORB detection to acquire, recover, or periodically check drift
         *      (ROI around the last quad first, full frame only when lost).
         * Returns { found, corners, viaFlow }.
         */
        const trackGroup = (g, src, grab, getFullFrame, now) => {
          const tw = g.tracker.targetW
          const th = g.tracker.targetH
          const locked = !!g.smooth && now - g.lastFound <= LOSS_GRACE_MS
          g.ticks = (g.ticks || 0) + 1
          let res = null
          let viaFlow = false

          if (grab && g.flow.active) {
            const f = g.flow.track(grab.gray, grab.sx, grab.sy)
            if (f.found) {
              const corners = quadFromH(f.H, tw, th)
              if (validateProjectedQuad(corners, src.width, src.height, tw, th).ok) {
                res = { found: true, corners, H: f.H }
                viaFlow = true
              }
            }
            if (!viaFlow) g.flow.reset()
          }

          const needDetect = !viaFlow || g.ticks - (g.lastDetectTick || 0) >= REDETECT_EVERY_TICKS
          if (needDetect) {
            g.lastDetectTick = g.ticks
            let det = null
            const hint = res?.corners || (locked ? g.smooth : null)
            const roi = hint ? paddedRoiFromCorners(hint, src.width, src.height) : null
            if (roi) {
              const fr = extractFrame(src, { roi })
              try {
                det = fr ? g.tracker.matchFrame(fr, { locked: true }) : null
              } finally {
                fr?.dispose()
              }
            }
            if (!det?.found && !viaFlow) {
              const full = getFullFrame()
              det = full ? g.tracker.matchFrame(full, { locked }) : null
            }
            if (det?.found) {
              if (!viaFlow) {
                res = det
                if (grab) g.flow.reseed(grab.gray, det.H, tw, th, grab.sx, grab.sy)
              } else {
                const edge = Math.hypot(res.corners[1][0] - res.corners[0][0], res.corners[1][1] - res.corners[0][1])
                if (quadDistance(det.corners, res.corners) > Math.max(DRIFT_MIN_PX, DRIFT_FRAC * edge)) {
                  // Flow drifted off the true target: trust detection, restart flow.
                  res = det
                  viaFlow = false
                  g.flow.reseed(grab.gray, det.H, tw, th, grab.sx, grab.sy)
                }
              }
            }
          }

          if (viaFlow) {
            // Top up points lost to occlusion / leaving the frame, then advance.
            if (g.flow.count < FLOW_CONFIG.reseedBelow) {
              g.flow.seed(grab.gray, res.H, tw, th, grab.sx, grab.sy)
            }
            g.flow.commit(grab.gray)
          }
          return res?.found ? { ...res, viaFlow } : { found: false }
        }

        // Prefer one tracking tick per *new* camera frame.
        let newFrame = true
        let vfcHandle = 0
        const hasVfc = typeof video.requestVideoFrameCallback === 'function'
        if (hasVfc) {
          const onVideoFrame = () => {
            newFrame = true
            vfcHandle = video.requestVideoFrameCallback(onVideoFrame)
          }
          vfcHandle = video.requestVideoFrameCallback(onVideoFrame)
        }

        const loop = () => {
          raf = requestAnimationFrame(loop)
          const dt = clock.getDelta()
          for (const entry of anims) {
            entry.ctl.update(dt)
          }
          for (const panel of mediaPanels) panel.update()
          engine?.tick(dt)
          if (phase === 'playing' && gameSettings.goal !== 'none' && hasWon(gameSettings, scoreValue, itemEntries.values())) {
            endGame('won')
          }
          tap.update(dt)

          trackTick()
          if (manipulation) {
            const canManipulate =
              lastTrackingState && (!gameSettings || phase === 'playing')
            if (manipulation.isEnabled() !== canManipulate) {
              manipulation.setEnabled(canManipulate)
            }
          }
          // Render AFTER tracking: the model is drawn with the pose of the
          // exact frame now on the camera canvas.
          renderer.render(scene, camera)
        }

        const groupList = [...groups.values()]
        let searchCursor = 0

        /**
         * Apply one frame's tracking results (from the workers or the
         * main-thread fallback): pose update, loss grace, found/lost UI, hints.
         * Returns whether any target is currently shown.
         */
        const finishTick = (resultFor, now, diagnostics) => {
          let anyFound = false
          for (const g of groupList) {
            const r = resultFor(g)
            if (r?.found && applyDetection(g, r, now, r.viaFlow)) {
              anyFound = true
            } else if (now - g.lastFound > LOSS_GRACE_MS) {
              if (g.smooth || g.anchor.visible) {
                g.smooth = null
                g.cornerFilter = null
                g.flow.reset()
              }
              g.anchor.visible = false
            } else if (g.anchor.visible) {
              anyFound = true
            }
          }

          if (!anyFound && !acquireStartedAt) acquireStartedAt = now
          if (anyFound) acquireStartedAt = 0

          if (anyFound !== lastTrackingState) {
            lastTrackingState = anyFound
            engine?.emit(anyFound ? 'target_found' : 'target_lost')
            if (!disposed) {
              setTargetFound(anyFound)
              if (anyFound) {
                setFoundAlert(true)
                playChime()
                try {
                  navigator.vibrate?.([60, 40, 60])
                } catch {
                  /* ignore */
                }
                if (alertTimerRef.current) clearTimeout(alertTimerRef.current)
                alertTimerRef.current = setTimeout(() => {
                  if (!disposed) setFoundAlert(false)
                }, 2400)
              }
            }
          }

          if (!anyFound && now - lastHintAt > 350) {
            lastHintAt = now
            const d = diagnostics() || {}
            let hint = 'Point camera directly at target image'
            if (d.inliers > 0) {
              hint = `Locking on: ${d.inliers}/${TRACK_CONFIG.minInliers} inliers — keep steady`
            } else if (d.ratioMatches >= 3) {
              hint = `Target detected (${d.ratioMatches} matches) — hold steady`
            } else if (d.frameKps < 150) {
              hint = 'Low lighting — brighten the target image'
            }
            if (!disposed) setHintText(hint)
          }
          return anyFound
        }

        // ---- Worker tracking -------------------------------------------------
        // Per camera frame: grab a small RGBA copy for the flow worker and an
        // ImageBitmap of the full frame for display. When the flow result for
        // that frame comes back, the frame and its pose are shown together
        // (frame-locked). Detection runs alongside in the detect worker.
        const procCanvas = document.createElement('canvas')
        const procCtx = procCanvas.getContext('2d', { willReadFrequently: true })
        const cropCanvas = document.createElement('canvas')
        const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })
        const trackDebug = renderDebug() // localStorage.arTrackerDebug = '1' → window.__arTrackStats
        const frameBitmaps = new Map() // frameId → ImageBitmap | null (still decoding)
        let frameSeq = 0
        let presentQueue = null // newest flow result waiting to be shown
        let workerDiag = null
        const detectionOnly = new Map() // key → result (OpenCV builds without KLT)

        const captureFrame = () => {
          const vw = video.videoWidth
          const vh = video.videoHeight
          const scale = Math.min(1, FLOW_CONFIG.width / vw)
          const w = Math.max(1, Math.round(vw * scale))
          const h = Math.max(1, Math.round(vh * scale))
          const frameId = ++frameSeq
          frameBitmaps.set(frameId, null)
          const meta = { frameId, width: w, height: h, sx: vw / w, sy: vh / h, videoW: vw, videoH: vh }

          if (trackingClient.bitmaps) {
            // GPU path: both snapshots are taken now (same video frame); the
            // small one is scaled by the browser and read in the worker.
            trackingClient.reserveFrame()
            const full = createImageBitmap(video)
            const small = createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })
            full
              .then((bmp) => {
                if (frameBitmaps.has(frameId)) frameBitmaps.set(frameId, bmp)
                else bmp.close()
              })
              .catch(() => frameBitmaps.delete(frameId))
            small
              .then((bitmap) => {
                if (disposed) return bitmap.close()
                trackingClient.sendFrame({ ...meta, bitmap })
              })
              .catch(() => {
                frameBitmaps.delete(frameId)
                trackingClient.releaseFrame()
              })
            return
          }

          if (procCanvas.width !== w || procCanvas.height !== h) {
            procCanvas.width = w
            procCanvas.height = h
          }
          procCtx.drawImage(video, 0, 0, w, h)
          const image = procCtx.getImageData(0, 0, w, h)
          createImageBitmap(video)
            .then((bmp) => {
              if (frameBitmaps.has(frameId)) frameBitmaps.set(frameId, bmp)
              else bmp.close()
            })
            .catch(() => frameBitmaps.delete(frameId))
          trackingClient.sendFrame({ ...meta, image })
        }

        /** Returns a promise when it reads `source` asynchronously (keep it open until then). */
        const requestDetection = (frameId, source, now) => {
          if (trackingClient.detectBusy) return null
          const vw = video.videoWidth
          const vh = video.videoHeight
          const active = groupList.find((g) => g.smooth && now - g.lastFound <= LOSS_GRACE_MS)
          let keys
          let roi = null
          let locked = false
          if (active) {
            // While the flow holds the target, only re-check it now and then
            // (drift correction); detection-only builds check every frame.
            if (useFlow && active.flowing && frameId - (active.lastDetectFrame || 0) < REDETECT_EVERY_TICKS) return null
            active.lastDetectFrame = frameId
            keys = [active.key]
            locked = true
            if (active.flowing || !useFlow) roi = paddedRoiFromCorners(active.smooth, vw, vh)
          } else {
            const n = groupList.length
            const k = Math.min(SEARCH_TARGETS_PER_TICK, n)
            keys = []
            for (let i = 0; i < k; i++) keys.push(groupList[(searchCursor + i) % n].key)
            searchCursor = (searchCursor + k) % Math.max(n, 1)
          }
          const srcX = roi ? roi.x : 0
          const srcY = roi ? roi.y : 0
          const srcW = roi ? roi.w : vw
          const srcH = roi ? roi.h : vh
          const scale = Math.min(1, TRACK_CONFIG.processWidth / srcW)
          const w = Math.max(1, Math.round(srcW * scale))
          const h = Math.max(1, Math.round(srcH * scale))
          const req = { frameId, width: w, height: h, region: { srcX, srcY, srcW, srcH, videoW: vw, videoH: vh, roi }, keys, locked }
          if (trackingClient.bitmaps && source !== video) {
            trackingClient.reserveDetect()
            return createImageBitmap(source, srcX, srcY, srcW, srcH, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
              .then((bitmap) => {
                if (disposed) return bitmap.close()
                trackingClient.detect({ ...req, bitmap })
              })
              .catch(() => trackingClient.releaseDetect())
          }
          if (cropCanvas.width !== w || cropCanvas.height !== h) {
            cropCanvas.width = w
            cropCanvas.height = h
          }
          cropCtx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, w, h)
          trackingClient.detect({ ...req, image: cropCtx.getImageData(0, 0, w, h) })
          return null
        }

        if (trackingClient) {
          trackingClient.onFrame((msg) => {
            presentQueue = msg
            if (trackDebug) window.__arTrackStats = { ...msg.stats, flowMs: msg.ms }
          })
          trackingClient.onDetect((msg) => {
            workerDiag = msg.diag || workerDiag
            if (!msg.found) return
            if (useFlow) trackingClient.sendDetection(msg)
            else detectionOnly.set(msg.key, { found: true, corners: msg.corners, H: msg.H, viaFlow: false })
          })
          trackingClient.onError((message) => console.warn('[AR worker]', message))
        }

        const workerTick = () => {
          if (disposed || !video.videoWidth) return
          if (camCanvas.width !== video.videoWidth || camCanvas.height !== video.videoHeight) syncVideoSize()
          const now = performance.now()

          // 1. Show the newest tracked frame together with its pose.
          const msg = presentQueue
          if (msg) {
            presentQueue = null
            const bmp = frameBitmaps.get(msg.frameId) || null
            for (const [id, b] of frameBitmaps) {
              if (id >= msg.frameId) break
              b?.close?.()
              frameBitmaps.delete(id)
            }
            frameBitmaps.delete(msg.frameId)
            const source = bmp || video
            camCtx.drawImage(source, 0, 0, camCanvas.width, camCanvas.height)
            const results = new Map()
            for (const r of msg.results || []) results.set(r.key, r)
            for (const [key, r] of detectionOnly) results.set(key, r)
            detectionOnly.clear()
            for (const g of groupList) g.flowing = results.get(g.key)?.viaFlow === true
            const reading = requestDetection(msg.frameId, source, now)
            if (reading) reading.finally(() => bmp?.close())
            else bmp?.close()
            const anyFound = finishTick((g) => results.get(g.key) || null, now, () => workerDiag)
            noteTrackerTiming(msg.ms || 0, anyFound ? 'tracking' : 'scanning')
          }

          // 2. Hand the next camera frame to the flow worker (one in flight).
          if ((hasVfc ? newFrame : now - lastTrackAt >= 28) && !trackingClient.flowBusy) {
            newFrame = false
            lastTrackAt = now
            captureFrame()
          }
        }


        const trackTick = () => {
          if (trackingClient) return workerTick()
          if (disposed || trackBusy || !video.videoWidth) return
          const now = performance.now()
          if (hasVfc ? !newFrame : now - lastTrackAt < 28) return
          newFrame = false
          trackBusy = true
          lastTrackAt = now
          const t0 = performance.now()
          let anyFound = false
          let grab = null
          let fullFrame = null
          try {
            if (camCanvas.width !== video.videoWidth || camCanvas.height !== video.videoHeight) syncVideoSize()
            camCtx.drawImage(video, 0, 0, camCanvas.width, camCanvas.height)
            if (useFlow) grab = grabGray(camCanvas, FLOW_CONFIG.width)
            const getFullFrame = () => {
              if (!fullFrame) fullFrame = extractFrame(camCanvas)
              return fullFrame
            }

            // One target at a time (MindAR maxTrack = 1): follow only the
            // locked target; while nothing is locked, scan a few targets per
            // frame in rotation so cost stays flat as targets are added.
            const active = groupList.find((g) => g.smooth && now - g.lastFound <= LOSS_GRACE_MS)
            let toTrack
            if (active) {
              toTrack = [active]
            } else {
              const n = groupList.length
              const k = Math.min(SEARCH_TARGETS_PER_TICK, n)
              toTrack = []
              for (let i = 0; i < k; i++) toTrack.push(groupList[(searchCursor + i) % n])
              searchCursor = (searchCursor + k) % Math.max(n, 1)
            }

            anyFound = finishTick(
              (g) => (toTrack.includes(g) ? trackGroup(g, camCanvas, grab, getFullFrame, now) : null),
              now,
              getTrackerDiagnostics
            )
            noteTrackerTiming(performance.now() - t0, anyFound ? 'tracking' : 'scanning')
          } finally {
            grab?.dispose()
            fullFrame?.dispose()
            trackBusy = false
          }
        }
        loop()

        stop = () => {
          cancelAnimationFrame(raf)
          raf = 0
          if (hasVfc && vfcHandle) video.cancelVideoFrameCallback?.(vfcHandle)
          trackBusy = false
          if (alertTimerRef.current) clearTimeout(alertTimerRef.current)
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
          clearInterval(gameTimer)
          gameApiRef.current = null
          for (const entry of anims) entry.ctl.dispose()
          anims.length = 0
          for (const panel of mediaPanels) panel.dispose()
          mediaPanels.length = 0
          tap.dispose()
          manipulation?.dispose()
          manipulation = null
          modelApiRef.current = null
          engine?.dispose()
          for (const audio of soundCache.values()) audio.pause()
          for (const g of groups.values()) {
            g.tracker?.dispose?.()
            g.flow?.dispose?.()
          }
          releaseTrackerRuntime()
          releaseFlowRuntime()
          video.removeEventListener('resize', syncVideoSize)
          window.removeEventListener('resize', syncVideoSize)
          stream.getTracks().forEach((t) => t.stop())
          if (video.srcObject) video.srcObject = null
          pmremGenerator.dispose()
          envTexture.dispose()
          renderer.dispose()
          scene.traverse((o) => {
            o.geometry?.dispose?.()
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.())
          })
        }
        if (pendingModels === 0) {
          setStatus('ready')
          setIsReady(true)
        }
      } catch (err) {
        if (!disposed) setError(err.message)
      }
    })()

    return () => {
      disposed = true
      stop()
      document.body.classList.remove('viewer-mode')
    }
  }, [publicId, preloaded])

  const manipEnabled =
    isReady && !error && manipReady && targetFound && (!game || gamePhase === 'playing')

  const handleManipReset = () => modelApiRef.current?.reset()

  const selectViewerModel = async (model) => {
    if (!model || String(model.id) === String(activeModelId)) return
    setUploadError('')
    try {
      await modelApiRef.current?.swap?.(model)
      setActiveModelId(model.id)
    } catch (err) {
      setUploadError(err?.message || 'Could not load that model.')
    }
  }

  const uploadViewerModel = async (file) => {
    const { error: invalid, warning } = validateModelFile(file)
    if (invalid) {
      setUploadError(invalid)
      return
    }
    if (warning && !window.confirm(warning)) return
    if (!preloaded.project_id) {
      setUploadError('This experience is not linked to a project.')
      return
    }
    setUploadError('')
    setUploading(true)
    setUploadPct(0)
    try {
      const model = await uploadModelFile(preloaded.project_id, file, { onProgress: setUploadPct })
      setModels((prev) => [...prev.filter((m) => String(m.id) !== String(model.id)), model])
      await modelApiRef.current?.swap?.(model)
      setActiveModelId(model.id)
    } catch (err) {
      setUploadError(friendlyUploadError(err))
    } finally {
      setUploading(false)
      setUploadPct(0)
    }
  }

  return (
    <div className={`viewer-root ${manipEnabled ? 'has-manip' : ''}`}>
      <video ref={videoRef} className="viewer-camera" autoPlay muted playsInline />
      <canvas ref={camRef} className="viewer-camera-frame" />
      <canvas ref={glRef} className="gl" />
      <Link to="/" className="viewer-back">← AR Studio</Link>

      {/* 3D model controls: shown once the tracked model is on screen */}
      {isReady && !error && manipReady && (
        <>
          <button
            type="button"
            className={`viewer-models-toggle ${showModels ? 'active' : ''}`}
            onClick={() => setShowModels((open) => !open)}
            aria-expanded={showModels}
            aria-controls="viewer-model-drawer"
          >
            <span aria-hidden="true">◆</span>
            <span>Models</span>
          </button>
          <div id="viewer-model-drawer">
            <ModelSwitcherDrawer
              open={showModels}
              onClose={() => setShowModels(false)}
              models={models}
              activeId={activeModelId}
              onSelect={selectViewerModel}
              onUpload={uploadViewerModel}
              uploading={uploading}
              busy={swappingModel}
              uploadPct={uploadPct}
              error={uploadError}
              title="3D models"
              hint={
                swappingModel
                  ? 'Loading model…'
                  : 'Switch the model shown on the target, or upload a new .glb.'
              }
            />
          </div>
        </>
      )}

      {manipEnabled && (
        <ViewerManipulationHud
          onReset={handleManipReset}
        />
      )}

      {/* Target Found Alert Popup */}
      {foundAlert && (
        <div className="viewer-found-alert">
          <div className="found-alert-card">
            <span className="found-alert-icon">🎯</span>
            <div className="found-alert-text">
              <span className="found-alert-title">Target Found!</span>
              <span className="found-alert-sub">Showing 3D Model</span>
            </div>
          </div>
        </div>
      )}

      {/* AR Scanner */}
      {isReady && !error && (
        <div className={`ar-scanner-wrap ${targetFound ? 'tracked' : ''}`}>
          <img
            src="/images/scanner.gif"
            alt="Scanning target"
            className="ar-scanner-img"
          />
        </div>
      )}

      {/* Game HUD: score counter, clock, tap messages */}
      {(score !== null || (gamePhase === 'playing' && timeLeft !== null)) && !error && (
        <div className="viewer-score" aria-live="polite">
          {score !== null && (
            <>
              <span className="viewer-score-label">Score</span>
              <span key={score} className="viewer-score-value">
                {score}
                {game?.settings.goal === 'score' && (
                  <span className="viewer-score-goal">/{game.settings.target_score}</span>
                )}
              </span>
            </>
          )}
          {gamePhase === 'playing' && timeLeft !== null && (
            <span className={`viewer-clock ${timeLeft <= 10 ? 'low' : ''}`}>⏱ {formatTime(timeLeft)}</span>
          )}
        </div>
      )}
      {game && gamePhase && gamePhase !== 'playing' && isReady && !error && (
        <div className="viewer-game-overlay">
          <div className={`viewer-game-card ${gamePhase}`}>
            <div className="viewer-game-icon" aria-hidden="true">
              {gamePhase === 'intro' ? '🎮' : gamePhase === 'won' ? '🏆' : gamePhase === 'lost' ? '⌛' : '🏁'}
            </div>
            <h2 className="viewer-game-title">
              {gamePhase === 'intro'
                ? game.title
                : gamePhase === 'won'
                  ? endText || game.settings.win_message || 'You win!'
                  : gamePhase === 'lost'
                    ? endText || game.settings.lose_message || "Time's up!"
                    : "Time's up!"}
            </h2>
            {gamePhase === 'intro' && (
              <>
                {game.settings.intro && <p className="viewer-game-text">{game.settings.intro}</p>}
                <p className="viewer-game-goal">{game.goalText}</p>
                <p className="viewer-game-hint">Point your camera at the image, then tap the models.</p>
              </>
            )}
            {gamePhase !== 'intro' && score !== null && (
              <p className="viewer-game-goal">Score: {score}</p>
            )}
            <button type="button" className="btn primary viewer-game-btn" onClick={() => gameApiRef.current?.start()}>
              {gamePhase === 'intro' ? 'Start' : 'Play again'}
            </button>
          </div>
        </div>
      )}
      {toast && !error && (
        <div key={toast.key} className="viewer-toast" role="status">
          {toast.text}
        </div>
      )}

      {/* Real-time scanning guidance pill */}
      {isReady && !error && !targetFound && (
        <div className="viewer-hint-pill">
          <span className="hint-dot" />
          <span>{hintText}</span>
        </div>
      )}

      {/* Full error overlay if experience cannot be loaded */}
      {error && (
        <div className="viewer-error-overlay">
          <div className="viewer-error-card">
            <div className="error-icon">⚠️</div>
            <h2>Experience Not Found</h2>
            <p>{error}</p>
            <div className="tiny muted" style={{ marginTop: 8, wordBreak: 'break-all' }}>
              Public ID: <code>{publicId}</code>
            </div>
            <Link to="/" className="btn btn-primary" style={{ marginTop: 16 }}>
              Return to AR Studio
            </Link>
          </div>
        </div>
      )}

      {/* Floating Animation Toggle Button */}
      {isReady && !error && animController && (
        <button
          type="button"
          className={`viewer-anim-toggle ${showAnimPanel ? 'active' : ''}`}
          onClick={() => setShowAnimPanel((prev) => !prev)}
          title={showAnimPanel ? 'Hide animation controls' : 'Show animation controls'}
        >
          <span className="anim-toggle-icon">{showAnimPanel ? '✕' : '🎬'}</span>
          <span className="anim-toggle-label">{showAnimPanel ? 'Close' : 'Animations'}</span>
        </button>
      )}

      {/* Floating Animation Transport Panel */}
      {isReady && !error && animController && showAnimPanel && (
        <AnimationPanel controller={animController} />
      )}

      {/* Status HUD in top-right: only during loading */}
      {!error && !isReady && (
        <div className="viewer-hud">
          <div className="muted">{status}</div>
        </div>
      )}
    </div>
  )
}
