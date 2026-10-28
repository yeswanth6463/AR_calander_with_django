import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import {
  ImageTracker,
  extractFrame,
  paddedRoiFromCorners,
  noteTrackerTiming,
  releaseTrackerRuntime,
  getTrackerDiagnostics,
  TRACK_CONFIG,
} from '../ar/tracker'
import {
  poseFromHomography,
  poseTranslation,
  smoothCorners,
  getQuadHomography,
} from '../ar/pose'
import { attachContentToTargetAnchor, applyARItemTransform, fitModelToMarker } from '../ar/sceneTransform'
import { createAnimationController } from '../ar/animation'
import { createMediaPanel } from '../ar/mediaPanel'
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

const LOSS_GRACE_MS = 1000
const SMOOTH_ALPHA = 0.45

const playChime = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
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

export default function Viewer() {
  const { publicId } = useParams()
  const videoRef = useRef(null)
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

  useEffect(() => {
    let disposed = false
    const groups = new Map()
    let cameraStream = null
    let stop = () => {
      for (const g of groups.values()) g.tracker?.dispose?.()
      releaseTrackerRuntime()
      cameraStream?.getTracks().forEach((t) => t.stop())
    }
    // JS scroll-lock fallback for browsers without :has() support.
    document.body.classList.add('viewer-mode')

    ;(async () => {
      try {
        const exp = await api(`/public/${publicId}/`)
        if (disposed) return

        setStatus('loading tracker…')
        await waitForCv()
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
        for (const g of groups.values()) {
          const targetImg = await loadImage(rel(g.target.image_url))
          if (disposed) return
          g.tracker = new ImageTracker()
          g.tracker.compile(targetImg)
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
        glCanvas.width = video.videoWidth
        glCanvas.height = video.videoHeight

        const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true })
        renderer.setClearColor(0x000000, 0)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.setPixelRatio(1)
        renderer.setSize(glCanvas.width, glCanvas.height, false)

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(60, glCanvas.width / glCanvas.height, 0.01, 1000)
        scene.add(camera)
        scene.add(new THREE.AmbientLight(0xffffff, 1.15))
        const key = new THREE.DirectionalLight(0xffffff, 1.35)
        key.position.set(0.4, 0.8, 1)
        camera.add(key)
        const fill = new THREE.DirectionalLight(0x88aaff, 0.55)
        fill.position.set(-0.6, -0.2, 0.4)
        camera.add(fill)

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
        const syncVideoSize = () => {
          const vw = video.videoWidth
          const vh = video.videoHeight
          if (!vw || !vh) return
          if (glCanvas.width !== vw || glCanvas.height !== vh) {
            glCanvas.width = vw
            glCanvas.height = vh
            renderer.setSize(vw, vh, false)
            // Old smoothed corners are in pre-rotation frame coords — drop them.
            for (const g of groups.values()) g.smooth = null
          }
          camera.aspect = vw / vh
          camera.updateProjectionMatrix()
          applyCoverLayout(video, vw, vh)
          applyCoverLayout(glCanvas, vw, vh)
        }
        // `resize` fires on the video element when videoWidth/Height change
        // (e.g. orientation change); loadedmetadata has already fired by now.
        video.addEventListener('resize', syncVideoSize)
        window.addEventListener('resize', syncVideoSize)
        syncVideoSize()

        const anims = []
        const mediaPanels = []
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

        const gltfLoader = new GLTFLoader()
        const gltfCache = new Map()
        const loadGltf = (url) => {
          if (!gltfCache.has(url)) {
            gltfCache.set(
              url,
              new Promise((resolve, reject) => {
                gltfLoader.load(url, resolve, undefined, reject)
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

          if (['mp4', 'webm', 'gif'].includes(item.model.format)) {
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
              .then((gltf) => {
                if (disposed) return
                const model = cloneSkinned(gltf.scene)
                const size = fitModelToMarker(model)
                fit.add(model)
                group.modelReady = true
                if (renderDebug()) {
                  const wp = new THREE.Vector3()
                  fit.getWorldPosition(wp)
                  console.info('[AR viewer] model loaded', {
                    id: item.id,
                    url: modelPath,
                    bbox: size.toArray(),
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
                    ctl.applySettings(item.animation)
                    if (item.animation.loop === 'once') {
                      ctl.setLoop('once')
                    } else {
                      ctl.setLoop('repeat')
                    }
                  } else {
                    ctl.setLoop('repeat')
                    ctl.play()
                  }
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

        let raf = 0
        let lastTrackingState = false
        let trackBusy = false
        let lastTrackAt = 0
        let lastHintAt = 0
        let acquireStartedAt = 0
        let lastPoseLogAt = 0
        const clock = new THREE.Clock()

        const applyDetection = (g, r, now) => {
          if (!g.anchor) return false
          const wasLocked = !!g.smooth && now - g.lastFound <= LOSS_GRACE_MS
          g.smooth = smoothCorners(g.smooth, r.corners, SMOOTH_ALPHA)
          const m = poseFromCorners(
            g.tracker.targetW,
            g.tracker.targetH,
            g.smooth,
            glCanvas.width,
            glCanvas.height,
            60
          )
          if (!m) {
            if (renderDebug() && now - lastPoseLogAt > 2000) {
              lastPoseLogAt = now
              console.warn('[AR viewer] pose rejected', {
                corners: g.smooth,
                frame: [glCanvas.width, glCanvas.height],
                targetPx: [g.tracker.targetW, g.tracker.targetH],
                modelReady: g.modelReady,
                modelError: g.modelError,
              })
            }
            return false
          }
          g.anchor.matrix.fromArray(m)
          g.anchor.updateMatrixWorld(true)
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

        const matchAll = (frame, now, lockedIds) => {
          let anyFound = false
          for (const g of groups.values()) {
            const locked = lockedIds.has(g)
            const r = g.tracker.matchFrame(frame, { locked })
            if (r.found && applyDetection(g, r, now)) {
              anyFound = true
            } else if (now - g.lastFound > LOSS_GRACE_MS) {
              g.smooth = null
              g.anchor.visible = false
            } else if (g.anchor.visible) {
              anyFound = true
            }
          }
          return anyFound
        }

        const loop = () => {
          raf = requestAnimationFrame(loop)
          const dt = clock.getDelta()
          for (const entry of anims) {
            if (entry.group?.anchor?.visible) {
              entry.ctl.update(dt)
            }
          }
          for (const panel of mediaPanels) panel.update()
          renderer.render(scene, camera)

          if (disposed || trackBusy || !video.videoWidth) return
          const now = performance.now()
          if (now - lastTrackAt < 28) return
          trackBusy = true
          lastTrackAt = now
          const t0 = performance.now()
          let anyFound = false
          let frame = null
          try {
            const locked = [...groups.values()].filter(
              (g) => g.smooth && now - g.lastFound <= LOSS_GRACE_MS
            )
            const lockedSet = new Set(locked)

            if (groups.size === 1 && locked.length === 1) {
              const roi = paddedRoiFromCorners(
                locked[0].smooth,
                video.videoWidth,
                video.videoHeight
              )
              if (roi) {
                frame = extractFrame(video, { roi })
                const r = frame && locked[0].tracker.matchFrame(frame, { locked: true })
                if (r?.found && applyDetection(locked[0], r, now)) {
                  anyFound = true
                } else {
                  frame?.dispose()
                  frame = extractFrame(video)
                  anyFound = frame ? matchAll(frame, now, lockedSet) : false
                }
              } else {
                frame = extractFrame(video)
                anyFound = frame ? matchAll(frame, now, lockedSet) : false
              }
            } else {
              frame = extractFrame(video)
              anyFound = frame ? matchAll(frame, now, lockedSet) : false
            }

            if (!anyFound && !acquireStartedAt) acquireStartedAt = now
            if (anyFound) acquireStartedAt = 0

            if (anyFound !== lastTrackingState) {
              lastTrackingState = anyFound
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
              const d = getTrackerDiagnostics()
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
            noteTrackerTiming(performance.now() - t0, anyFound ? 'tracking' : 'scanning')
          } finally {
            frame?.dispose()
            trackBusy = false
          }
        }
        loop()

        stop = () => {
          cancelAnimationFrame(raf)
          raf = 0
          trackBusy = false
          if (alertTimerRef.current) clearTimeout(alertTimerRef.current)
          for (const entry of anims) entry.ctl.dispose()
          anims.length = 0
          for (const panel of mediaPanels) panel.dispose()
          mediaPanels.length = 0
          for (const g of groups.values()) g.tracker?.dispose?.()
          releaseTrackerRuntime()
          video.removeEventListener('resize', syncVideoSize)
          window.removeEventListener('resize', syncVideoSize)
          stream.getTracks().forEach((t) => t.stop())
          if (video.srcObject) video.srcObject = null
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
  }, [publicId])

  return (
    <div className="viewer-root">
      <video ref={videoRef} className="viewer-camera" autoPlay muted playsInline />
      <canvas ref={glRef} className="gl" />
      <Link to="/" className="viewer-back">← AR Studio</Link>

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
