import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ImageTracker, extractFrame } from '../ar/tracker'
import { poseFromHomography, smoothCorners } from '../ar/pose'
import { createAnimationController } from '../ar/animation'
import { createMediaPanel } from '../ar/mediaPanel'
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

// Exact 4-point homography from target corners → (smoothed) frame corners, so
// the pose actually benefits from corner smoothing instead of raw H jitter.
const poseFromCorners = (targetW, targetH, corners, frameW, frameH, fovDeg) => {
  const tw = Math.max(targetW - 1, 1)
  const th = Math.max(targetH - 1, 1)
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, tw, 0, tw, th, 0, th])
  const dst = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    [corners[0][0], corners[0][1], corners[1][0], corners[1][1],
     corners[2][0], corners[2][1], corners[3][0], corners[3][1]]
  )
  const H = cv.findHomography(src, dst, 0)
  src.delete()
  dst.delete()
  if (!H) return null
  const f = H.data64F
  const m = poseFromHomography(
    [f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]],
    frameW,
    frameH,
    fovDeg
  )
  H.delete()
  return m
}

export default function Viewer() {
  const { publicId } = useParams()
  const videoRef = useRef(null)
  const glRef = useRef(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('loading experience…')

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

        // Scene content: prefer the multi-item payload, fall back to the
        // legacy single target/model pair.
        const items =
          Array.isArray(exp.items) && exp.items.length
            ? exp.items
            : exp.target && exp.model
              ? [{
                  id: 'legacy',
                  name: exp.name,
                  target: exp.target,
                  model: exp.model,
                  transform: exp.transform,
                }]
              : []
        if (!items.length) {
          throw new Error('Experience has no target image or model.')
        }

        // One tracker + one anchor per distinct target image; items sharing a
        // marker become siblings under the same anchor.
        const groups = new Map()
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
        }
        // `resize` fires on the video element when videoWidth/Height change
        // (e.g. orientation change); loadedmetadata has already fired by now.
        video.addEventListener('resize', syncVideoSize)
        window.addEventListener('resize', syncVideoSize)
        syncVideoSize()

        const anims = []
        const mediaPanels = []
        let pendingModels = items.length
        const doneOne = (message) => {
          pendingModels--
          if (pendingModels === 0 && !disposed) setStatus(message)
        }

        // Anchors: one per distinct target image.
        for (const g of groups.values()) {
          const anchor = new THREE.Object3D()
          anchor.matrixAutoUpdate = false
          anchor.visible = false
          scene.add(anchor)
          g.anchor = anchor

          const targetAspect = g.tracker.targetH / g.tracker.targetW
          const content = new THREE.Group()
          content.position.set(0.5, -targetAspect / 2, 0)
          content.scale.setScalar(g.target.width)
          anchor.add(content)
          g.content = content
        }

        // Content: each item gets its own fit group carrying its transform.
        setStatus(
          `loading ${items.length} model${items.length > 1 ? 's' : ''}…`
        )
        for (const item of items) {
          const fit = new THREE.Group()
          const transform = item.transform
          fit.position.set(...transform.position)
          fit.rotation.set(
            THREE.MathUtils.degToRad(transform.rotation[0]),
            THREE.MathUtils.degToRad(transform.rotation[1]),
            THREE.MathUtils.degToRad(transform.rotation[2])
          )
          fit.scale.set(...(transform.scale_xyz || Array(3).fill(transform.scale)))
          groups.get(item.target.image_url).content.add(fit)

          if (['mp4', 'webm', 'gif'].includes(item.model.format)) {
            createMediaPanel(rel(item.model.url), item.model.format)
              .then((panel) => {
                if (disposed) {
                  panel.dispose()
                  return
                }
                mediaPanels.push(panel)
                fit.add(panel.mesh)
                doneOne('point your camera at the target image')
              })
              .catch(() => doneOne('target ready — media failed to load'))
          } else {
            new GLTFLoader().load(rel(item.model.url), (gltf) => {
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
              if (gltf.animations?.length) {
                const ctl = createAnimationController(gltf)
                if (item.animation) ctl.applySettings(item.animation)
                else ctl.play()
                anims.push(ctl)
              }
              doneOne('point your camera at the target image')
            }, undefined, () => {
              doneOne('target ready — model failed to load (check format)')
            })
          }
        }

        let raf = 0
        const clock = new THREE.Clock()

        const loop = () => {
          raf = requestAnimationFrame(loop)
          const dt = clock.getDelta()
          for (const ctl of anims) ctl.update(dt)
          for (const panel of mediaPanels) panel.update()
          const now = performance.now()

          // One ORB extraction per frame, matched against every marker.
          const frame = extractFrame(video)
          if (frame) {
            for (const g of groups.values()) {
              const r = g.tracker.matchFrame(frame)
              if (r.found) {
                g.smooth = smoothCorners(g.smooth, r.corners, 0.4)
                const m = poseFromCorners(
                  g.tracker.targetW,
                  g.tracker.targetH,
                  g.smooth,
                  glCanvas.width,
                  glCanvas.height,
                  60
                )
                if (m) {
                  g.anchor.matrix.fromArray(m)
                  g.anchor.matrixWorldNeedsUpdate = true
                  g.anchor.visible = true
                  g.lastFound = now
                }
              } else if (now - g.lastFound > 300) {
                g.smooth = null
                g.anchor.visible = false
              }
            }
            frame.dispose()
          }
          renderer.render(scene, camera)
        }
        loop()

        stop = () => {
          cancelAnimationFrame(raf)
          for (const ctl of anims) ctl.dispose()
          anims.length = 0
          for (const panel of mediaPanels) panel.dispose()
          mediaPanels.length = 0
          video.removeEventListener('resize', syncVideoSize)
          window.removeEventListener('resize', syncVideoSize)
          stream.getTracks().forEach((t) => t.stop())
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
      {/* Only while loading or on error — clean view once ready. */}
      {(error || status !== 'ready') && (
        <div className="viewer-hud">
          {error ? (
            <div className="lost">{error}</div>
          ) : (
            <div className="muted">{status}</div>
          )}
        </div>
      )}
    </div>
  )
}
