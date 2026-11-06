/**
 * Camera feed + transparent three.js overlay, laid out with "cover" so the
 * video and the 3D canvas crop identically. Shared by face tracking and
 * object detection (studio live preview and public viewer).
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

export async function openCamera(facingMode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera not available. Open this page over HTTPS in a modern browser.')
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
    })
  } catch (err) {
    if (err?.name === 'NotAllowedError') throw new Error('Camera permission was denied.')
    throw new Error(err?.message || 'Could not start the camera.')
  }
}

/**
 * @param {HTMLElement} container  positioned element the stage fills
 * @param {{ facingMode: 'user'|'environment', mirror?: boolean, fov?: number,
 *           near?: number, far?: number, onFrame(now, dt, stage): void }} opts
 */
export async function createCameraStage(container, opts) {
  const { facingMode, mirror = facingMode === 'user', onFrame } = opts
  const layer = document.createElement('div')
  layer.className = 'camstage-layer'
  if (mirror) layer.style.transform = 'scaleX(-1)'
  const video = document.createElement('video')
  video.className = 'camstage-video'
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  const canvas = document.createElement('canvas')
  canvas.className = 'camstage-gl'
  layer.append(video, canvas)
  container.append(layer)

  let stream = null
  let disposed = false
  let raf = 0
  try {
    stream = await openCamera(facingMode)
    if (disposed) throw new Error('disposed')
    video.srcObject = stream
    await video.play()
    if (!video.videoWidth) {
      await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }))
    }
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop())
    layer.remove()
    throw err
  }

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envTexture
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 63, 1, opts.near ?? 0.01, opts.far ?? 1000)
  scene.add(camera)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 0.7))
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(1, 2, 3)
  camera.add(key)

  // Extra { scene, camera } layers: underlays draw before the main scene
  // (e.g. face masks under glasses), overlays after it (e.g. face markers).
  const stage = { video, canvas, renderer, scene, camera, width: 0, height: 0, mirror, underlays: [], overlays: [] }
  renderer.autoClear = false

  const layout = () => {
    const vw = video.videoWidth
    const vh = video.videoHeight
    const cw = container.clientWidth
    const ch = container.clientHeight
    if (!vw || !vh || !cw || !ch) return
    const scale = Math.max(cw / vw, ch / vh)
    const w = vw * scale
    const h = vh * scale
    for (const el of [video, canvas]) {
      el.style.width = `${w}px`
      el.style.height = `${h}px`
      el.style.left = `${(cw - w) / 2}px`
      el.style.top = `${(ch - h) / 2}px`
    }
    if (stage.width !== vw || stage.height !== vh) {
      stage.width = vw
      stage.height = vh
      renderer.setSize(vw, vh, false)
      camera.aspect = vw / vh
      camera.updateProjectionMatrix()
    }
  }
  const resizeObserver = new ResizeObserver(layout)
  resizeObserver.observe(container)
  video.addEventListener('resize', layout)
  layout()

  /** Screen (client) point → normalised video coords [0..1], honouring mirror + cover crop. */
  stage.clientToVideo = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect()
    let u = (clientX - r.left) / r.width
    const v = (clientY - r.top) / r.height
    if (mirror) u = 1 - u // bounding rect is not flipped by the CSS transform
    return { u, v }
  }

  let last = performance.now()
  const loop = () => {
    if (disposed) return
    raf = requestAnimationFrame(loop)
    const now = performance.now()
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    if (video.readyState >= 2) {
      if (stage.width !== video.videoWidth) layout()
      try {
        onFrame?.(now, dt, stage)
      } catch (err) {
        console.warn('[camera stage] frame failed', err)
      }
    }
    renderer.clear()
    for (const layer of stage.underlays) renderer.render(layer.scene, layer.camera)
    renderer.clearDepth()
    renderer.render(scene, camera)
    for (const layer of stage.overlays) {
      renderer.clearDepth()
      renderer.render(layer.scene, layer.camera)
    }
  }
  loop()

  stage.dispose = () => {
    disposed = true
    cancelAnimationFrame(raf)
    resizeObserver.disconnect()
    video.removeEventListener('resize', layout)
    stream?.getTracks().forEach((t) => t.stop())
    video.srcObject = null
    pmrem.dispose()
    envTexture.dispose()
    renderer.dispose()
    layer.remove()
  }
  return stage
}
