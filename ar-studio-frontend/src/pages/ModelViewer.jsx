import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as THREE from 'three'
import { createGltfLoader } from '../ar/gltfLoader'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { startCamera, waitForVideo } from '../ar/camera'
import { createAnimationController } from '../ar/animation'
import { createManipulation } from '../ar/manipulation'
import { relUrl } from '../ar/contentLoader'
import {
  centerAndFitModel,
  disposeObject3D,
  friendlyUploadError,
  localCenterOf,
  prepareModel,
  uploadModelFile,
  validateModelFile,
} from '../ar/modelAssets'
import { ModelSwitcherDrawer, ViewerManipulationHud } from '../components/ModelManipulator'
import { useAuth } from '../auth'

/** Distance in front of the camera and normalised longest-axis size. */
const MODEL_DISTANCE = 1.05
const MODEL_SIZE = 0.6

/**
 * Public viewer for marker-less "user model" experiences: the uploaded 3D
 * model floats in front of the camera and can be moved, rotated and scaled
 * with touch or mouse. Models can be switched or uploaded without reloading.
 */
export default function ModelViewer({ exp }) {
  const { publicId } = useParams()
  const { user } = useAuth()
  const videoRef = useRef(null)
  const glRef = useRef(null)
  const apiRef = useRef(null)

  const seedModels = useMemo(() => {
    const list = Array.isArray(exp.available_models)
      ? exp.available_models.filter((m) => m?.url)
      : []
    if (
      exp.model?.url &&
      !list.some((m) => m.url === exp.model.url)
    ) {
      list.unshift({
        id: `published:${exp.model.url}`,
        name: exp.model.name || 'Published model',
        url: exp.model.url,
        format: exp.model.format || 'glb',
      })
    }
    return list
  }, [exp])

  const initialModel = useMemo(
    () => seedModels.find((m) => m.url === exp.model?.url) || seedModels[0] || null,
    [seedModels, exp.model]
  )

  const [started, setStarted] = useState(false)
  const [status, setStatus] = useState('starting camera…')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  const [models, setModels] = useState(seedModels)
  const [activeId, setActiveId] = useState(initialModel?.id ?? null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadError, setUploadError] = useState('')

  const activeModel = models.find((m) => String(m.id) === String(activeId)) || initialModel

  useEffect(() => {
    if (!started) return undefined

    let disposed = false
    let raf = 0
    let stream = null
    let renderer = null
    let pmrem = null
    let envTexture = null
    let scene = null
    let camera = null
    let videoEl = null
    let userGroup = null
    let manipulation = null
    let currentRoot = null
    let currentCtl = null
    let loadToken = 0
    let resize = null

    const clearModel = () => {
      currentCtl?.dispose()
      currentCtl = null
      if (currentRoot) {
        disposeObject3D(currentRoot)
        currentRoot = null
      }
    }

    const stopStream = () => {
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
      if (videoEl?.srcObject) videoEl.srcObject = null
    }

    apiRef.current = {
      reset: () => manipulation?.reset(),
      swap: null,
    }

    ;(async () => {
      try {
        document.body.classList.add('viewer-mode')

        stream = await startCamera()
        if (disposed) {
          stopStream()
          return
        }
        const video = videoRef.current
        if (!video) throw new Error('Camera view is unavailable.')
        videoEl = video
        video.playsInline = true
        video.autoplay = true
        video.muted = true
        video.srcObject = stream
        await waitForVideo(video)
        if (disposed) {
          stopStream()
          return
        }
        await video.play().catch(() => {})

        const glCanvas = glRef.current
        const rootEl = glCanvas.parentElement
        renderer = new THREE.WebGLRenderer({
          canvas: glCanvas,
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance',
        })
        renderer.setClearColor(0x000000, 0)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.05

        scene = new THREE.Scene()
        pmrem = new THREE.PMREMGenerator(renderer)
        pmrem.compileEquirectangularShader()
        const roomEnv = new RoomEnvironment()
        envTexture = pmrem.fromScene(roomEnv, 0.04).texture
        roomEnv.dispose?.()
        scene.environment = envTexture

        camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000)
        scene.add(camera)

        scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 0.65))
        const key = new THREE.DirectionalLight(0xffffff, 1.45)
        key.position.set(0.5, 1.0, 1.2)
        camera.add(key)
        const fill = new THREE.DirectionalLight(0x90b4d6, 0.5)
        fill.position.set(-0.8, 0.1, 0.5)
        camera.add(fill)
        const rim = new THREE.DirectionalLight(0xffeedd, 0.45)
        rim.position.set(0, -0.6, -1.0)
        camera.add(rim)

        const resizeToScreen = () => {
          if (!renderer || !camera) return
          const w = rootEl?.clientWidth || window.innerWidth
          const h = rootEl?.clientHeight || window.innerHeight
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
          renderer.setSize(w, h, false)
          camera.aspect = w / Math.max(h, 1)
          camera.updateProjectionMatrix()
        }
        resize = resizeToScreen
        window.addEventListener('resize', resizeToScreen)
        resizeToScreen()

        // The user-manipulation group is persistent: swapping a model only
        // replaces its child, so move/rotate/scale survive the switch.
        userGroup = new THREE.Group()
        userGroup.position.set(0, 0, -MODEL_DISTANCE)
        scene.add(userGroup)

        manipulation = createManipulation({
          root: rootEl,
          canvas: glCanvas,
          camera,
        })
        manipulation.setTarget(userGroup)
        // No tracking gate here: the model always floats in front of the
        // camera, so gestures are live as soon as the viewer is ready.
        manipulation.setEnabled(true)

        const loader = createGltfLoader()

        const swap = async (model) => {
          if (!model?.url) throw new Error('No model selected.')
          const token = ++loadToken
          setSwapping(true)
          try {
            const gltf = await loader.loadAsync(relUrl(model.url))
            if (disposed || token !== loadToken) return
            gltf.parser = null

            const nextRoot = cloneSkinned(gltf.scene)
            centerAndFitModel(nextRoot, MODEL_SIZE)

            try {
              await prepareModel(nextRoot, { renderer, camera, scene })
            } catch (err) {
              console.warn('[AR model viewer] model preparation skipped', err)
            }
            if (disposed || token !== loadToken) {
              disposeObject3D(nextRoot)
              return
            }

            const previousRoot = currentRoot
            currentCtl?.dispose()
            currentCtl = null
            currentRoot = null
            userGroup.add(nextRoot)
            currentRoot = nextRoot
            manipulation?.setPivot(localCenterOf(userGroup, nextRoot))

            if (gltf.animations?.length) {
              currentCtl = createAnimationController({ scene: nextRoot, animations: gltf.animations })
              currentCtl.setLoop(currentCtl.defaultLoop)
              currentCtl.play()
            }

            // The old model is off the scene graph now, free its GPU memory.
            if (previousRoot) disposeObject3D(previousRoot)

            if (!disposed && token === loadToken) {
              setReady(true)
              setStatus('ready')
            }
          } finally {
            if (!disposed && token === loadToken) setSwapping(false)
          }
        }
        apiRef.current.swap = swap

        if (initialModel) {
          setStatus(`loading ${initialModel.name || 'model'}…`)
          try {
            await swap(initialModel)
          } catch (err) {
            if (!disposed) setError(err?.message || 'Could not load the 3D model.')
            return
          }
        } else {
          setStatus('ready')
          setReady(true)
        }
        if (disposed) return

        const clock = new THREE.Clock()
        const loop = () => {
          raf = requestAnimationFrame(loop)
          const dt = clock.getDelta()
          currentCtl?.update(dt)
          renderer.render(scene, camera)
        }
        loop()
      } catch (err) {
        if (!disposed) setError(err?.message || 'Could not start the camera.')
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      apiRef.current = null
      clearModel()
      manipulation?.dispose()
      manipulation = null
      if (userGroup?.parent) userGroup.parent.remove(userGroup)
      stopStream()
      if (resize) window.removeEventListener('resize', resize)
      pmrem?.dispose()
      envTexture?.dispose()
      renderer?.dispose()
      scene?.traverse((obj) => {
        obj.geometry?.dispose?.()
        if (obj.material) {
          ;(Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose?.())
        }
      })
      document.body.classList.remove('viewer-mode')
    }
    // `resize` is only referenced inside the async block; keep the effect tied
    // to the selected entry so a new experience re-initialises the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, initialModel])

  const handleReset = () => apiRef.current?.reset()

  const selectModel = async (model) => {
    if (!model || swapping || uploading) return
    if (String(model.id) === String(activeId)) return
    setUploadError('')
    setSwapping(true)
    try {
      await apiRef.current?.swap?.(model)
      setActiveId(model.id)
    } catch (err) {
      setUploadError(err?.message || 'Could not load that model.')
    } finally {
      setSwapping(false)
    }
  }

  const uploadModel = async (file) => {
    const { error: invalid, warning } = validateModelFile(file)
    if (invalid) {
      setUploadError(invalid)
      return
    }
    if (warning && typeof window !== 'undefined' && !window.confirm(warning)) return
    if (!exp.project_id) {
      setUploadError('This experience is not linked to a project.')
      return
    }
    setUploadError('')
    setUploading(true)
    setUploadPct(0)
    try {
      const model = await uploadModelFile(exp.project_id, file, { onProgress: setUploadPct })
      setModels((prev) => [...prev.filter((m) => String(m.id) !== String(model.id)), model])
      await apiRef.current?.swap?.(model)
      setActiveId(model.id)
    } catch (err) {
      setUploadError(friendlyUploadError(err))
    } finally {
      setUploading(false)
      setUploadPct(0)
    }
  }

  return (
    <div className="viewer-root">
      <video ref={videoRef} className="viewer-camera viewer-camera-cover" autoPlay muted playsInline />
      <canvas ref={glRef} className="gl" />
      <Link to="/" className="viewer-back">← AR Studio</Link>

      {!started && (
        <div className="viewer-game-overlay">
          <div className="viewer-game-card">
            <div className="viewer-game-icon" aria-hidden="true">🧊</div>
            <h2 className="viewer-game-title">{exp.name || exp.project || 'Custom 3D model'}</h2>
            <p className="viewer-game-text">
              Your 3D model appears in front of the camera. Move, rotate and scale it with touch
              or mouse — no target image needed.
            </p>
            {!initialModel && (
              <p className="viewer-game-hint">
                No 3D model has been uploaded to this project yet. Start the camera and use
                the “3D models” drawer to upload a .glb, or add one in AR Studio.
              </p>
            )}
            <button
              type="button"
              className="btn primary viewer-game-btn"
              onClick={() => setStarted(true)}
            >
              Start camera
            </button>
          </div>
        </div>
      )}

      {started && ready && !error && (
        <>
          <button
            type="button"
            className={`viewer-models-toggle ${drawerOpen ? 'active' : ''}`}
            onClick={() => setDrawerOpen((open) => !open)}
            aria-expanded={drawerOpen}
            aria-controls="model-drawer"
          >
            <span aria-hidden="true">◆</span>
            <span>{activeModel?.name || '3D models'}</span>
          </button>

          <div id="model-drawer">
            <ModelSwitcherDrawer
              open={drawerOpen}
              onClose={() => setDrawerOpen(false)}
              models={models}
              activeId={activeId}
              onSelect={selectModel}
              onUpload={uploadModel}
              uploading={uploading}
              busy={swapping}
              uploadPct={uploadPct}
              error={uploadError}
              title="3D models"
              hint={
                swapping
                  ? 'Loading model…'
                  : 'Switch the model shown in front of the camera, or upload a new .glb.'
              }
            />
          </div>

          {activeModel && (
            <ViewerManipulationHud
              onReset={handleReset}
            />
          )}
        </>
      )}

      {started && ready && !error && !activeModel && (
        <div className="viewer-empty-model">
          <strong>No 3D model yet</strong>
          <span>Open “3D models” above to upload a .glb.</span>
        </div>
      )}

      {started && !ready && !error && (
        <div className="viewer-hud">
          <div className="muted">{swapping ? 'loading model…' : status}</div>
        </div>
      )}

      {error && (
        <div className="viewer-error-overlay">
          <div className="viewer-error-card">
            <div className="error-icon">⚠️</div>
            <h2>
              {/camera|permission|denied|not allowed|notallowed/i.test(error)
                ? 'Camera unavailable'
                : 'Could not open this experience'}
            </h2>
            <p>{error}</p>
            <div className="tiny muted" style={{ marginTop: 8 }}>
              Public ID: <code>{publicId}</code>
            </div>
            <Link to="/" className="btn btn-primary" style={{ marginTop: 16 }}>
              Return to AR Studio
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
