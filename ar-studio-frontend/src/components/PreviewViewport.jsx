import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createAnimationController } from '../ar/animation'
import AnimationPanel from './AnimationPanel'

const deg = THREE.MathUtils.degToRad

// API returns absolute URLs on :8000 — strip origin so requests go through
// the Vite proxy (same-origin, no CORS).
const rel = (url) => {
  try {
    return new URL(url, window.location.origin).pathname
  } catch {
    return url
  }
}

export default function PreviewViewport({ target, asset, transform }) {
  const mountRef = useRef(null)
  const worldRef = useRef(null)
  const modelGroupRef = useRef(null)
  const animCtlRef = useRef(null)
  const [aspect, setAspect] = useState(0.75)
  const [modelState, setModelState] = useState('')
  const [animCtl, setAnimCtl] = useState(null)

  useEffect(() => {
    if (!target?.image) return
    const img = new Image()
    img.onload = () => {
      if (img.naturalWidth) setAspect(img.naturalHeight / img.naturalWidth)
    }
    img.src = rel(target.image)
  }, [target])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    try {

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const isLight = () => document.documentElement.dataset.theme === 'light'
    const applyTheme = () => {
      scene.background = new THREE.Color(isLight() ? 0xe9edf5 : 0x0e1119)
      scene.fog = new THREE.Fog(scene.background, 4, 12)
    }
    applyTheme()

    const camera = new THREE.PerspectiveCamera(
      50,
      mount.clientWidth / mount.clientHeight,
      0.01,
      100
    )
    camera.position.set(1.4, 1.1, 1.8)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0.5, 0.1, 0.4)
    controls.maxPolarAngle = Math.PI / 2.05

    scene.add(new THREE.AmbientLight(0xffffff, 0.75))
    const key = new THREE.DirectionalLight(0xffffff, 1.2)
    key.position.set(2, 4, 2)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4)
    fill.position.set(-2, 1, -2)
    scene.add(fill)

    const grid = new THREE.GridHelper(8, 32, 0x2a3145, 0x1a1f2e)
    const gridLight = new THREE.GridHelper(8, 32, 0xaab4c8, 0xd3d9e5)
    const applyGridTheme = () => {
      grid.visible = !isLight()
      gridLight.visible = isLight()
    }
    scene.add(grid, gridLight)
    applyGridTheme()

    const axes = new THREE.AxesHelper(0.6)
    axes.position.set(0, 0.002, 0)
    scene.add(axes)

    const themeObserver = new MutationObserver(() => {
      applyTheme()
      applyGridTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    const world = new THREE.Group()
    scene.add(world)
    worldRef.current = world

    let raf = 0
    const clock = new THREE.Clock()
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = clock.getDelta()
      animCtlRef.current?.update(dt)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      animCtlRef.current?.dispose()
      animCtlRef.current = null
      setAnimCtl(null)
      window.removeEventListener('resize', onResize)
      themeObserver.disconnect()
      controls.dispose()
      renderer.dispose()
      world.traverse((o) => {
        o.geometry?.dispose?.()
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          mats.forEach((m) => {
            m.map?.dispose?.()
            m.dispose?.()
          })
        }
      })
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
    } catch (err) {
      console.error('[VP] renderer effect THREW:', err)
    }
  }, [])

  // Rebuild scene contents when target / model changes
  useEffect(() => {
    const world = worldRef.current
    if (!world) return

    while (world.children.length) {
      const child = world.children[0]
      world.remove(child)
      child.traverse?.((o) => {
        o.geometry?.dispose?.()
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          mats.forEach((m) => {
            m.map?.dispose?.()
            m.dispose?.()
          })
        }
      })
    }
    modelGroupRef.current = null
    animCtlRef.current?.dispose()
    animCtlRef.current = null
    setAnimCtl(null)
    if (!target) return

    const planeGeo = new THREE.PlaneGeometry(1, aspect)
    planeGeo.rotateX(-Math.PI / 2)
    const tex = new THREE.TextureLoader().load(rel(target.image))
    tex.colorSpace = THREE.SRGBColorSpace
    const plane = new THREE.Mesh(
      planeGeo,
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 })
    )
    plane.position.set(0.5, 0.001, aspect / 2)
    world.add(plane)

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, aspect).rotateX(-Math.PI / 2)),
      new THREE.LineBasicMaterial({ color: 0x3b6ef5 })
    )
    edge.position.set(0.5, 0.002, aspect / 2)
    world.add(edge)

    const modelGroup = new THREE.Group()
    world.add(modelGroup)
    modelGroupRef.current = modelGroup

    if (asset?.model_file) {
      setModelState('loading model…')
      new GLTFLoader().load(
        rel(asset.model_file),
        (gltf) => {
          if (modelGroupRef.current !== modelGroup) return
          const model = gltf.scene
          const box = new THREE.Box3().setFromObject(model)
          const size = box.getSize(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z) || 1
          const s = 0.5 / maxDim
          model.scale.setScalar(s)
          const box2 = new THREE.Box3().setFromObject(model)
          const c = box2.getCenter(new THREE.Vector3())
          model.position.set(-c.x, -box2.min.y, -c.z)
          modelGroup.add(model)
          if (gltf.animations?.length) {
            const ctl = createAnimationController(gltf)
            ctl.play()
            animCtlRef.current = ctl
            setAnimCtl(ctl)
          }
          setModelState('')
        },
        (evt) => {
          if (evt.total) {
            const pct = Math.round((evt.loaded / evt.total) * 100)
            setModelState(`loading model… ${pct}%`)
          }
        },
        () => setModelState('model failed to load')
      )
    } else {
      setModelState('')
    }
  }, [target, asset, aspect])

  // Live transform
  useEffect(() => {
    const g = modelGroupRef.current
    if (!g || !transform) return
    const [px, py, pz] = transform.position
    const [rx, ry, rz] = transform.rotation
    // preview mapping: AR frame (x right, y down-image, z out-of-plane)
    // -> ground plane (x right, z depth, y up); origin at plane center
    g.position.set(0.5 + px, pz, aspect / 2 - py)
    g.rotation.set(deg(rx), deg(ry), deg(rz))
    g.scale.setScalar(transform.scale)
  }, [transform, target, aspect])

  return (
    <div className="viewport">
      {/* Canvas host must stay childless: React must not reconcile away the
          imperatively-appended WebGL canvas when the badge toggles below. */}
      <div className="viewport-canvas" ref={mountRef} />
      {modelState && <div className="viewport-badge">{modelState}</div>}
      {animCtl && <AnimationPanel controller={animCtl} />}
    </div>
  )
}
