import { useEffect, useRef, useState, useCallback } from 'react'
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
  const [error, setError] = useState('')
  const [status, setStatus] = useState('loading experience…')
  const [trackState, setTrackState] = useState('idle')
  const [activeTargetName, setActiveTargetName] = useState('')
  const [fps, setFps] = useState(0)

  // Interactive Manipulation State & References
  const [manipMode, setManipMode] = useState('drag') // 'drag' | 'rotate' | 'scale'
  const [rotateAxis, setRotateAxis] = useState('y') // 'x' | 'y' | 'z'
  const [availableModels, setAvailableModels] = useState([])
  const [activeModelId, setActiveModelId] = useState(null)
  const [projectId, setProjectId] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)

  // References for live 3D controls & switching
  const activeFitRef = useRef(null)
  const activeAnimCtlRef = useRef(null)
  const userTransformRef = useRef({
    pos: [0, 0, 0],
    rot: [0, 0, 0], // radians
    scale: 1.0,
    basePos: [0, 0, 0],
    baseRot: [0, 0, 0],
    baseScale: 1.0,
  })

  // Pointer gesture tracker
  const gestureRef = useRef({
    pointers: new Map(),
    lastPanX: 0,
    lastPanY: 0,
    initialPinchDist: 0,
    initialPinchAngle: 0,
    startScale: 1.0,
  })

  const applyUserTransform = useCallback(() => {
    const fit = activeFitRef.current
    if (!fit) return
    const t = userTransformRef.current
    fit.position.set(
      t.basePos[0] + t.pos[0],
      t.basePos[1] + t.pos[1],
      t.basePos[2] + t.pos[2]
    )
    fit.rotation.set(
      t.baseRot[0] + t.rot[0],
      t.baseRot[1] + t.rot[1],
      t.baseRot[2] + t.rot[2]
    )
    fit.scale.setScalar(Math.max(0.05, t.baseScale * t.scale))
  }, [])

  const resetTransform = useCallback(() => {
    const t = userTransformRef.current
    t.pos = [0, 0, 0]
    t.rot = [0, 0, 0]
    t.scale = 1.0
    applyUserTransform()
  }, [applyUserTransform])

  // Load and swap a 3D model into an entry's fit group
  const loadModelIntoEntry = useCallback(
    (entry, modelUrl) => {
      if (!entry || !entry.fit) return
      const fit = entry.fit

      // Clean up previous model children & animation
      if (entry.animCtl) {
        entry.animCtl.dispose()
        entry.animCtl = null
      }
      while (fit.children.length > 0) {
        const child = fit.children[0]
        fit.remove(child)
        child.traverse?.((o) => {
          o.geometry?.dispose?.()
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            mats.forEach((m) => m.dispose?.())
          }
        })
      }

      new GLTFLoader().load(
        rel(modelUrl),
        (gltf) => {
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
            ctl.play()
            entry.animCtl = ctl
            if (activeFitRef.current === fit) {
              activeAnimCtlRef.current = ctl
            }
          }
        },
        undefined,
        (err) => {
          console.warn('[Viewer] Model loading failed:', err)
        }
      )
    },
    []
  )

  // Switch model handler
  const handleSelectModel = useCallback(
    (model) => {
      setActiveModelId(model.id)
      const currentEntry = activeFitRef.current?.__entry
      if (currentEntry) {
        loadModelIntoEntry(currentEntry, model.url)
      }
    },
    [loadModelIntoEntry]
  )

  // Upload new model directly from AR Viewer
  const handleModelUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()
    if (!['glb', 'gltf'].includes(ext)) {
      setError('Please upload a valid .glb or .gltf 3D model')
      return
    }

    if (!projectId) {
      setError('Project ID not found for this experience.')
      return
    }

    setIsUploading(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('project', projectId)
      fd.append('name', file.name.replace(/\.[^.]+$/, ''))
      fd.append('model_file', file)
      fd.append('format', ext)

      const newAsset = await api('/assets/', { method: 'POST', formData: fd })
      const assetObj = {
        id: String(newAsset.id),
        name: newAsset.name,
        url: newAsset.model_file,
        format: newAsset.format,
      }
      setAvailableModels((prev) => [...prev, assetObj])
      handleSelectModel(assetObj)
    } catch (err) {
      setError(err.message || 'Failed to upload 3D model')
    } finally {
      setIsUploading(false)
      e.target.value = ''
    }
  }

  // Pointer event handlers for touch/mouse interaction
  const onPointerDown = (e) => {
    const pointers = gestureRef.current.pointers
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    gestureRef.current.lastPanX = e.clientX
    gestureRef.current.lastPanY = e.clientY

    if (pointers.size === 2) {
      const pts = Array.from(pointers.values())
      const dx = pts[1].x - pts[0].x
      const dy = pts[1].y - pts[0].y
      gestureRef.current.initialPinchDist = Math.hypot(dx, dy)
      gestureRef.current.initialPinchAngle = Math.atan2(dy, dx)
      gestureRef.current.startScale = userTransformRef.current.scale
    }
  }

  const onPointerMove = (e) => {
    const pointers = gestureRef.current.pointers
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.size === 2) {
      // 2-finger multi-touch gesture: Pinch to scale + twist to rotate Y
      const pts = Array.from(pointers.values())
      const dx = pts[1].x - pts[0].x
      const dy = pts[1].y - pts[0].y
      const dist = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)

      if (gestureRef.current.initialPinchDist > 0) {
        const factor = dist / gestureRef.current.initialPinchDist
        userTransformRef.current.scale = Math.max(
          0.05,
          gestureRef.current.startScale * factor
        )
      }

      const deltaAngle = angle - gestureRef.current.initialPinchAngle
      userTransformRef.current.rot[1] += deltaAngle * 0.4
      gestureRef.current.initialPinchAngle = angle

      applyUserTransform()
      return
    }

    if (pointers.size === 1) {
      const dx = e.clientX - gestureRef.current.lastPanX
      const dy = e.clientY - gestureRef.current.lastPanY
      gestureRef.current.lastPanX = e.clientX
      gestureRef.current.lastPanY = e.clientY

      const t = userTransformRef.current
      if (manipMode === 'drag') {
        // Move along marker plane
        t.pos[0] += dx * 0.0015
        t.pos[1] -= dy * 0.0015
      } else if (manipMode === 'rotate') {
        const speed = 0.015
        if (rotateAxis === 'x') t.rot[0] += dy * speed
        else if (rotateAxis === 'y') t.rot[1] += dx * speed
        else if (rotateAxis === 'z') t.rot[2] += dx * speed
      } else if (manipMode === 'scale') {
        const factor = 1 - dy * 0.005
        t.scale = Math.max(0.05, t.scale * factor)
      }
      applyUserTransform()
    }
  }

  const onPointerUp = (e) => {
    gestureRef.current.pointers.delete(e.pointerId)
  }

  const onWheel = (e) => {
    const factor = e.deltaY < 0 ? 1.05 : 0.95
    userTransformRef.current.scale = Math.max(
      0.05,
      userTransformRef.current.scale * factor
    )
    applyUserTransform()
  }

  useEffect(() => {
    let disposed = false
    let stop = () => {}
    document.body.classList.add('viewer-mode')

    ;(async () => {
      try {
        const exp = await api(`/public/${publicId}/`)
        if (disposed) return

        if (exp.project_id) setProjectId(exp.project_id)
        if (Array.isArray(exp.available_models)) {
          setAvailableModels(exp.available_models)
          if (exp.model?.id) setActiveModelId(exp.model.id)
        }

        const items =
          Array.isArray(exp.items) && exp.items.length > 0
            ? exp.items
            : [
                {
                  id: 'default',
                  name: exp.name || 'Target',
                  target: exp.target,
                  model: exp.model,
                  transform: exp.transform,
                  animation: exp.animation,
                },
              ]

        setStatus('loading tracker…')
        await waitForCv()
        if (disposed) return

        const tracker = new ImageTracker()
        for (let i = 0; i < items.length; i++) {
          const it = items[i]
          setStatus(
            items.length > 1
              ? `loading target ${i + 1}/${items.length}…`
              : 'loading target image…'
          )
          const targetImg = await loadImage(rel(it.target.image_url))
          if (disposed) return
          tracker.compile(targetImg, it.id)
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

        const renderer = new THREE.WebGLRenderer({
          canvas: glCanvas,
          alpha: true,
          antialias: true,
        })
        renderer.setPixelRatio(1)
        renderer.setSize(glCanvas.width, glCanvas.height, false)

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(
          60,
          glCanvas.width / glCanvas.height,
          0.01,
          100
        )
        scene.add(new THREE.AmbientLight(0xffffff, 0.85))
        const dir = new THREE.DirectionalLight(0xffffff, 1.1)
        dir.position.set(1, 2, 3)
        scene.add(dir)

        const anchor = new THREE.Object3D()
        anchor.matrixAutoUpdate = false
        anchor.visible = false
        scene.add(anchor)

        const itemContainers = new Map()
        let loadedModels = 0

        setStatus(items.length > 1 ? 'loading 3D models…' : 'loading 3D model…')

        items.forEach((item) => {
          const targetWorldWidth = item.target.width > 0 ? item.target.width : 1
          const targetInfo = tracker.targets.get(item.id)
          const targetAspect =
            targetInfo && targetInfo.targetW > 0
              ? targetInfo.targetH / targetInfo.targetW
              : 1

          const itemGroup = new THREE.Group()
          itemGroup.visible = false

          const content = new THREE.Group()
          content.position.set(
            0.5 * targetWorldWidth,
            (targetAspect / 2) * targetWorldWidth,
            0
          )
          itemGroup.add(content)

          const modelOrientation = new THREE.Group()
          modelOrientation.rotation.x = Math.PI
          modelOrientation.scale.setScalar(targetWorldWidth)
          content.add(modelOrientation)

          const fit = new THREE.Group()
          const transform = item.transform || {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: 1,
          }
          const basePos = [...transform.position]
          const baseRot = [
            THREE.MathUtils.degToRad(transform.rotation[0]),
            THREE.MathUtils.degToRad(transform.rotation[1]),
            THREE.MathUtils.degToRad(transform.rotation[2]),
          ]
          const baseScale = transform.scale || 1

          fit.position.set(...basePos)
          fit.rotation.set(...baseRot)
          fit.scale.setScalar(baseScale)
          modelOrientation.add(fit)

          anchor.add(itemGroup)

          const entry = {
            id: item.id,
            name: item.name || 'Target',
            group: itemGroup,
            fit,
            targetWorldWidth,
            animCtl: null,
            basePos,
            baseRot,
            baseScale,
          }
          fit.__entry = entry
          itemContainers.set(item.id, entry)

          // Load initial model
          loadModelIntoEntry(entry, item.model.url)
          loadedModels++
          if (loadedModels >= items.length && !disposed) {
            setStatus(
              items.length > 1
                ? 'point camera at any target image'
                : 'point camera at target image'
            )
          }
        })

        // Set default active entry
        const firstEntry = itemContainers.values().next().value
        if (firstEntry) {
          activeFitRef.current = firstEntry.fit
          userTransformRef.current.basePos = firstEntry.basePos
          userTransformRef.current.baseRot = firstEntry.baseRot
          userTransformRef.current.baseScale = firstEntry.baseScale
        }

        let smoothed = null
        let lastFound = 0
        let frames = 0
        let fpsClock = performance.now()
        let raf = 0
        let lastTrackState = 'idle'
        let lastTrackWarning = 0
        let currentTargetId = null
        const clock = new THREE.Clock()
        const trackerRef = { current: tracker }

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

          for (const entry of itemContainers.values()) {
            entry.animCtl?.update(dt)
          }

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
            r = { found: false, reason: 'tracking error' }
            if (now - lastTrackWarning >= 5000) {
              lastTrackWarning = now
              console.warn('[Viewer] tracking frame failed:', err)
            }
          }

          if (r.found) {
            try {
              const activeEntry =
                itemContainers.get(r.targetId) || itemContainers.values().next().value
              const targetWorldWidth = activeEntry?.targetWorldWidth || 1

              if (currentTargetId !== r.targetId) {
                currentTargetId = r.targetId
                for (const [id, entry] of itemContainers) {
                  entry.group.visible = id === r.targetId
                }
                if (activeEntry) {
                  activeFitRef.current = activeEntry.fit
                  activeAnimCtlRef.current = activeEntry.animCtl
                  userTransformRef.current.basePos = activeEntry.basePos
                  userTransformRef.current.baseRot = activeEntry.baseRot
                  userTransformRef.current.baseScale = activeEntry.baseScale
                  applyUserTransform()
                }
                hasPose = false
                smoothed = null
                if (activeEntry?.name) {
                  setActiveTargetName(activeEntry.name)
                }
              }

              const m = poseFromHomography(
                r.H,
                glCanvas.width,
                glCanvas.height,
                60,
                r.targetW,
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
          for (const entry of itemContainers.values()) {
            entry.animCtl?.dispose()
          }
          itemContainers.clear()
          tracker.dispose()
          stream.getTracks().forEach((t) => t.stop())
          video.srcObject = null
          renderer.dispose()
          scene.traverse((o) => {
            o.geometry?.dispose?.()
            if (o.material) {
              const mats = Array.isArray(o.material) ? o.material : [o.material]
              mats.forEach((m) => m.dispose?.())
            }
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
  }, [publicId, applyUserTransform, loadModelIntoEntry])

  return (
    <div
      className="viewer-root"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <video ref={videoRef} autoPlay muted playsInline />
      <canvas ref={glRef} className="gl" />
      <Link to="/" className="viewer-back">
        ← AR Studio
      </Link>

      <div className="viewer-hud">
        <div>fps: {fps || '–'}</div>
        <div>
          tracking:{' '}
          <span className={trackState === 'found' ? 'found' : 'lost'}>
            {trackState}
          </span>
        </div>
        {activeTargetName && trackState === 'found' && (
          <div>
            target: <span className="found">{activeTargetName}</span>
          </div>
        )}
        {error ? (
          <div className="lost">{error}</div>
        ) : (
          status !== 'ready' && <div className="muted">{status}</div>
        )}
      </div>

      {/* Floating AR Manipulation Toolbar */}
      <div className="viewer-controls">
        <div className="control-tabs">
          <button
            className={`ctl-btn ${manipMode === 'drag' ? 'active' : ''}`}
            onClick={() => setManipMode('drag')}
            title="Move / Drag"
          >
            Move
          </button>
          <button
            className={`ctl-btn ${manipMode === 'rotate' ? 'active' : ''}`}
            onClick={() => setManipMode('rotate')}
            title="Rotate"
          >
            Rotate
          </button>
          <button
            className={`ctl-btn ${manipMode === 'scale' ? 'active' : ''}`}
            onClick={() => setManipMode('scale')}
            title="Scale"
          >
            Scale
          </button>
          <button
            className="ctl-btn ghost"
            onClick={resetTransform}
            title="Reset position, rotation and scale"
          >
            Reset
          </button>
          <button
            className={`ctl-btn ${showModelPicker ? 'active' : ''}`}
            onClick={() => setShowModelPicker((prev) => !prev)}
            title="Switch or Upload 3D Model"
          >
            Models ({availableModels.length})
          </button>
        </div>

        {manipMode === 'rotate' && (
          <div className="control-subrow">
            <span className="tiny muted">Axis:</span>
            {['x', 'y', 'z'].map((axis) => (
              <button
                key={axis}
                className={`axis-btn ${rotateAxis === axis ? 'active' : ''}`}
                onClick={() => setRotateAxis(axis)}
              >
                {axis.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Model Switcher & Direct Upload Overlay */}
      {showModelPicker && (
        <div className="model-picker-modal">
          <div className="model-picker-header">
            <h3>Select or Upload 3D Model</h3>
            <button
              className="btn ghost small"
              onClick={() => setShowModelPicker(false)}
            >
              ✕
            </button>
          </div>
          <div className="model-list">
            {availableModels.map((m) => (
              <div
                key={m.id}
                className={`model-card ${activeModelId === m.id ? 'active' : ''}`}
                onClick={() => handleSelectModel(m)}
              >
                <div className="model-name">{m.name}</div>
                <div className="tiny muted">{m.format?.toUpperCase()}</div>
              </div>
            ))}
          </div>
          <div className="model-upload-row">
            <label className={`btn small ${isUploading ? 'ghost' : ''}`}>
              {isUploading ? 'Uploading…' : '+ Upload New Model (.glb / .gltf)'}
              <input
                type="file"
                accept=".glb,.gltf"
                hidden
                onChange={handleModelUpload}
                disabled={isUploading}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
