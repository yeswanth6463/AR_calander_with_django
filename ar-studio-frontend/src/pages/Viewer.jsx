import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ImageTracker } from '../ar/tracker'
import { poseFromHomography, smoothCorners } from '../ar/pose'
import { createAnimationController } from '../ar/animation'
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

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load target image'))
    img.src = src
  })

export default function Viewer() {
  const { publicId } = useParams()
  const videoRef = useRef(null)
  const glRef = useRef(null)
  const animRef = useRef(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('loading experience…')
  const [trackState, setTrackState] = useState('idle')
  const [fps, setFps] = useState(0)

  useEffect(() => {
    let disposed = false
    let stop = () => {}
    // JS scroll-lock fallback for browsers without :has() support.
    document.body.classList.add('viewer-mode')

    ;(async () => {
      try {
        const exp = await api(`/public/${publicId}/`)
        if (disposed) return

        setStatus('loading tracker…')
        await waitForCv()
        if (disposed) return

        setStatus('loading target image…')
        const targetImg = await loadImage(rel(exp.target.image_url))
        const tracker = new ImageTracker()
        tracker.compile(targetImg)

        setStatus('starting camera…')
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        })
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        video.srcObject = stream
        await video.play()

        const glCanvas = glRef.current
        glCanvas.width = video.videoWidth
        glCanvas.height = video.videoHeight

        const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true })
        renderer.setPixelRatio(1)
        renderer.setSize(glCanvas.width, glCanvas.height, false)

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(60, glCanvas.width / glCanvas.height, 0.01, 100)
        scene.add(new THREE.AmbientLight(0xffffff, 0.85))
        const dir = new THREE.DirectionalLight(0xffffff, 1.1)
        dir.position.set(1, 2, 3)
        scene.add(dir)

        const anchor = new THREE.Object3D()
        anchor.matrixAutoUpdate = false
        anchor.visible = false
        scene.add(anchor)

        const targetWorldWidth = exp.target.width > 0 ? exp.target.width : 1
        const targetAspect = tracker.targetH / tracker.targetW
        const content = new THREE.Group()
        content.position.set(
          0.5 * targetWorldWidth,
          (targetAspect / 2) * targetWorldWidth,
          0
        )
        anchor.add(content)

        // Dedicated model-orientation group: converts anchor frame (+X right, +Y down, +Z into target)
        // to natural model frame (+X right, +Y upright, +Z toward camera) without rotating tracking anchor.
        const modelOrientation = new THREE.Group()
        modelOrientation.rotation.x = Math.PI
        modelOrientation.scale.setScalar(targetWorldWidth)
        content.add(modelOrientation)

        const fit = new THREE.Group()
        modelOrientation.add(fit)

        const { transform } = exp
        fit.position.set(...transform.position)
        fit.rotation.set(
          THREE.MathUtils.degToRad(transform.rotation[0]),
          THREE.MathUtils.degToRad(transform.rotation[1]),
          THREE.MathUtils.degToRad(transform.rotation[2])
        )
        fit.scale.setScalar(transform.scale)

        setStatus('loading 3D model…')
        new GLTFLoader().load(rel(exp.model.url), (gltf) => {
          if (disposed) return
          const model = gltf.scene
          const box = new THREE.Box3().setFromObject(model)
          const size = box.getSize(new THREE.Vector3())
          const center = box.getCenter(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z) || 1
          const s = 0.5 / maxDim
          model.scale.setScalar(s)
          model.position.sub(center.multiplyScalar(s))
          fit.add(model)
          if (!disposed && gltf.animations?.length) {
            animRef.current?.dispose()
            const ctl = createAnimationController(gltf)
            if (exp.animation) ctl.applySettings(exp.animation)
            else ctl.play()
            animRef.current = ctl
          }
          setStatus('point your camera at the target image')
        }, undefined, () => {
          if (!disposed) setStatus('target ready — model failed to load (check format)')
        })

        let smoothed = null
        let lastFound = 0
        let frames = 0
        let fpsClock = performance.now()
        let raf = 0
        let lastTrackState = 'idle'
        let lastTrackWarning = 0
        const clock = new THREE.Clock()
        const trackerRef = { current: null }
        trackerRef.current = tracker

        const targetPos = new THREE.Vector3()
        const targetQuat = new THREE.Quaternion()
        const targetScale = new THREE.Vector3()
        const poseMat = new THREE.Matrix4()
        let hasPose = false

        const publishTrackState = (next) => {
          if (next === lastTrackState) return
          lastTrackState = next
          setTrackState(next)
        }

        const loop = () => {
          raf = requestAnimationFrame(loop)
          const dt = clock.getDelta()
          animRef.current?.update(dt)
          frames++
          const now = performance.now()
          if (now - fpsClock >= 1000) {
            setFps(frames)
            frames = 0
            fpsClock = now
          }

          let r
          try {
            r = trackerRef.current.track(video)
          } catch (err) {
            // A failed frame is just a lost frame; never let it stop rendering.
            r = { found: false, reason: 'tracking error' }
            if (now - lastTrackWarning >= 5000) {
              lastTrackWarning = now
              console.warn('[Viewer] tracking frame failed:', err)
            }
          }

          if (r.found) {
            try {
              const m = poseFromHomography(
                r.H,
                glCanvas.width,
                glCanvas.height,
                60,
                trackerRef.current.targetW,
                targetWorldWidth
              )
              smoothed = smoothCorners(smoothed, r.corners, 0.4)

              poseMat.fromArray(m)
              poseMat.decompose(targetPos, targetQuat, targetScale)

              if (!hasPose || !anchor.visible) {
                anchor.position.copy(targetPos)
                anchor.quaternion.copy(targetQuat)
                anchor.scale.copy(targetScale)
                hasPose = true
              } else {
                anchor.position.lerp(targetPos, 0.35)
                anchor.quaternion.slerp(targetQuat, 0.35)
                anchor.scale.lerp(targetScale, 0.35)
              }

              anchor.matrix.compose(anchor.position, anchor.quaternion, anchor.scale)
              anchor.matrixWorldNeedsUpdate = true
              anchor.visible = true
              lastFound = now
              publishTrackState('found')
            } catch (err) {
              r = { found: false, reason: 'pose failed' }
              if (now - lastTrackWarning >= 5000) {
                lastTrackWarning = now
                console.warn('[Viewer] pose calculation failed:', err)
              }
            }
          }

          if (!r.found && now - lastFound > 300) {
            smoothed = null
            hasPose = false
            anchor.visible = false
            publishTrackState(`lost (${r.reason})`)
          }
          renderer.render(scene, camera)
        }
        loop()

        stop = () => {
          cancelAnimationFrame(raf)
          animRef.current?.dispose()
          animRef.current = null
          stream.getTracks().forEach((t) => t.stop())
          video.srcObject = null
          renderer.dispose()
          scene.traverse((o) => {
            o.geometry?.dispose?.()
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.())
          })
        }
        setStatus('ready')
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
      <video ref={videoRef} autoPlay muted playsInline />
      <canvas ref={glRef} className="gl" />
      <Link to="/" className="viewer-back">← AR Studio</Link>
      <div className="viewer-hud">
        <div>fps: {fps || '–'}</div>
        <div>
          tracking:{' '}
          <span className={trackState === 'found' ? 'found' : 'lost'}>{trackState}</span>
        </div>
        {error ? <div className="lost">{error}</div> : status !== 'ready' && <div className="muted">{status}</div>}
      </div>
    </div>
  )
}
