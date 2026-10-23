import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { createAnimationController } from '../ar/animation'
import { createMediaPanel } from '../ar/mediaPanel'
import { createRectGizmo } from './RectGizmo'
import UnityGizmoToolbar from './UnityGizmoToolbar'

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

export default function PreviewViewport({
  target,
  asset,
  transform,
  onAnimationController,
  onTransformChange,
}) {
  const mountRef = useRef(null)
  const worldRef = useRef(null)
  const modelGroupRef = useRef(null)
  const animCtlRef = useRef(null)
  const mediaPanelRef = useRef(null)
  const transformControlsRef = useRef(null)
  const rotateControlsRef = useRef(null)
  const rectGizmoRef = useRef(null)
  const [aspect, setAspect] = useState(0.75)
  const [modelState, setModelState] = useState('')
  const [transformMode, setTransformMode] = useState('translate')
  const [space, setSpace] = useState('world')
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [gizmoSize, setGizmoSize] = useState(1)
  const [modelReady, setModelReady] = useState(false)
  const [rectOrientation, setRectOrientation] = useState('horizontal')
  const aspectRef = useRef(aspect)
  const onTransformChangeRef = useRef(onTransformChange)

  useEffect(() => {
    aspectRef.current = aspect
  }, [aspect])

  useEffect(() => {
    onTransformChangeRef.current = onTransformChange
  }, [onTransformChange])

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
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85)
    scene.add(ambientLight)
    const key = new THREE.DirectionalLight(0xffffff, 1.25)
    key.position.set(2, 4, 2)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4)
    fill.position.set(-2, 1, -2)
    scene.add(fill)

    const isLight = () => document.documentElement.dataset.theme === 'light'
    const applyTheme = () => {
      const light = isLight()
      scene.background = new THREE.Color(light ? 0xf5f7fb : 0x0e1119)
      scene.fog = new THREE.Fog(scene.background, 5, 15)
      ambientLight.intensity = light ? 1.05 : 0.75
      key.intensity = light ? 1.35 : 1.2
      fill.intensity = light ? 0.55 : 0.4
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

    // 1. Translation / Scale TransformControls
    const transformControls = new TransformControls(camera, renderer.domElement)
    transformControls.setSpace('world')
    // Vibrant colors: X = Red, Y = Green, Z = Electric Blue, Active/Hover = Yellow
    transformControls.setColors(0xff385c, 0x22cc55, 0x2988ff, 0xffea00)
    transformControls.size = 1.15
    transformControls.showXY = true
    transformControls.showYZ = true
    transformControls.showXZ = true
    transformControls.showXYZE = false

    // Clean up gizmo handles:
    // - Move mode: 3 ARROWS (Red X, Green Y, Blue Z) + silver/grey center cube for simultaneous XYZ translation
    // - Scale mode: 3 CUBES (Red X, Green Y, Blue Z) + silver/grey center cube (Screenshot 2)
    // - Planar boxes & negative handles removed
    const helper = transformControls.getHelper()
    const toRemove = []
    helper.traverse((child) => {
      if (!child.isMesh && !child.isLine) return

      // Remove planar translation handles so only 3 clean arrows/axes show
      if (child.name === 'XY' || child.name === 'YZ' || child.name === 'XZ') {
        toRemove.push(child)
        return
      }

      // Remove negative / opposite direction arrows & boxes on X, Y, Z
      if (child.name === 'X' || child.name === 'Y' || child.name === 'Z') {
        if (child.geometry) {
          child.geometry.computeBoundingBox()
          const box = child.geometry.boundingBox
          if (box) {
            const center = new THREE.Vector3()
            box.getCenter(center)
            if (
              (child.name === 'X' && center.x < -0.05) ||
              (child.name === 'Y' && center.y < -0.05) ||
              (child.name === 'Z' && center.z < -0.05)
            ) {
              toRemove.push(child)
              return
            }
          }
        }

        // Render remaining 3 axes on top of all models and surfaces
        if (child.material) {
          child.material.depthTest = false
          child.material.depthWrite = false
          child.material.transparent = true
          child.renderOrder = 9999
        }
      }

      // Center cube for Move mode & Scale mode:
      // Replaces default octahedron with a sleek silver cube (Screenshot 1 & Screenshot 2)
      if (child.name === 'XYZ') {
        if (child.material?.visible === false) {
          // Generous raycast picker hitbox
          child.geometry?.dispose?.()
          child.geometry = new THREE.BoxGeometry(0.3, 0.3, 0.3)
        } else if (child.isMesh) {
          child.geometry?.dispose?.()
          child.geometry = new THREE.BoxGeometry(0.18, 0.18, 0.18)
          const silverMat = new THREE.MeshBasicMaterial({
            color: 0xdcdcdc,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            opacity: 0.95,
          })
          silverMat._color = new THREE.Color(0xdcdcdc)
          silverMat._opacity = 0.95
          child.material = silverMat
          child.renderOrder = 10001
        }
      }
    })

    toRemove.forEach((child) => {
      if (child.parent) {
        child.parent.remove(child)
      }
      child.geometry?.dispose?.()
    })

    // 2. Rotation TransformControls (for Rotate tool & Universal multi-tool mode)
    const rotateControls = new TransformControls(camera, renderer.domElement)
    rotateControls.setSpace('world')
    rotateControls.setMode('rotate')
    rotateControls.setColors(0xff385c, 0x22cc55, 0x2988ff, 0xffea00)
    rotateControls.size = 1.05
    rotateControls.showX = true
    rotateControls.showY = true
    rotateControls.showZ = true
    rotateControls.showXYZE = false
    rotateControls.showE = false

    const rotateHelper = rotateControls.getHelper()
    rotateHelper.traverse((child) => {
      if (child.material) {
        child.material.depthTest = false
        child.material.depthWrite = false
        child.material.transparent = true
        child.renderOrder = 9998
      }
    })
    scene.add(rotateHelper)
    rotateControlsRef.current = rotateControls

    const scaleStart = new THREE.Vector3(1, 1, 1)
    const onDraggingChanged = (event) => {
      controls.enabled = !event.value
    }
    transformControls.addEventListener('dragging-changed', onDraggingChanged)
    rotateControls.addEventListener('dragging-changed', onDraggingChanged)

    transformControls.addEventListener('mouseDown', () => {
      if (transformControls.getMode() === 'scale') {
        scaleStart.copy(modelGroupRef.current?.scale ?? new THREE.Vector3(1, 1, 1))
      }
    })

    const reportTransform = (commit) => {
      const group = modelGroupRef.current
      if (!group) return

      // In scale mode: enforce equal scaling across all axes (Screenshot 2 requirement)
      if (transformControls.getMode() === 'scale') {
        let factor = 1
        const axis = transformControls.axis
        if (axis === 'X') {
          factor = group.scale.x / (scaleStart.x || 1)
        } else if (axis === 'Y') {
          factor = group.scale.y / (scaleStart.y || 1)
        } else if (axis === 'Z') {
          factor = group.scale.z / (scaleStart.z || 1)
        } else {
          const fx = group.scale.x / (scaleStart.x || 1)
          const fy = group.scale.y / (scaleStart.y || 1)
          const fz = group.scale.z / (scaleStart.z || 1)
          const dx = Math.abs(fx - 1)
          const dy = Math.abs(fy - 1)
          const dz = Math.abs(fz - 1)
          factor = dx > dy ? (dx > dz ? fx : fz) : (dy > dz ? fy : fz)
        }
        if (Number.isFinite(factor) && factor > 0.001) {
          group.scale.copy(scaleStart).multiplyScalar(factor)
        }
      }

      onTransformChangeRef.current?.(
        {
          position_x: group.position.x - 0.5,
          position_y: aspectRef.current / 2 - group.position.z,
          position_z: group.position.y,
          rotation_x: THREE.MathUtils.radToDeg(group.rotation.x),
          rotation_y: THREE.MathUtils.radToDeg(group.rotation.y),
          rotation_z: THREE.MathUtils.radToDeg(group.rotation.z),
          scale: (group.scale.x + group.scale.y + group.scale.z) / 3,
          scale_x: group.scale.x,
          scale_y: group.scale.y,
          scale_z: group.scale.z,
        },
        commit
      )
    }

    transformControls.addEventListener('objectChange', () => reportTransform(false))
    transformControls.addEventListener('mouseUp', () => reportTransform(true))
    rotateControls.addEventListener('objectChange', () => reportTransform(false))
    rotateControls.addEventListener('mouseUp', () => reportTransform(true))

    transformControlsRef.current = transformControls
    scene.add(transformControls.getHelper())

    // 3. Rect Gizmo (Screenshot 3: corner scale handles & center translate handle)
    const rectGizmo = createRectGizmo({
      scene,
      camera,
      domElement: renderer.domElement,
      getModelGroup: () => modelGroupRef.current,
      onTransformChange: (commit) => reportTransform(commit),
      orbitControls: controls,
    })
    rectGizmoRef.current = rectGizmo

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
      mediaPanelRef.current?.update()
      rectGizmoRef.current?.update()
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
      mediaPanelRef.current?.dispose()
      mediaPanelRef.current = null
      rectGizmo.dispose()
      rectGizmoRef.current = null
      rotateControls.detach()
      rotateControls.dispose()
      rotateControlsRef.current = null
      transformControls.detach()
      transformControls.dispose()
      transformControlsRef.current = null
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
  }, [onAnimationController])

  // Synchronize active gizmo tools with transformMode, space, snaps, and model state
  useEffect(() => {
    const tc = transformControlsRef.current
    const rc = rotateControlsRef.current
    const rg = rectGizmoRef.current
    const model = modelGroupRef.current
    if (!tc) return

    tc.setSpace(space)
    tc.setSize(gizmoSize * 1.15)
    if (rc) {
      rc.setSpace(space)
      rc.setSize(gizmoSize * 1.05)
    }

    if (snapEnabled) {
      tc.setTranslationSnap(0.1)
      tc.setRotationSnap(THREE.MathUtils.degToRad(15))
      tc.setScaleSnap(0.1)
      rc?.setRotationSnap(THREE.MathUtils.degToRad(15))
    } else {
      tc.setTranslationSnap(null)
      tc.setRotationSnap(null)
      tc.setScaleSnap(null)
      rc?.setRotationSnap(null)
    }

    if (!model || transformMode === 'view') {
      tc.detach()
      tc.enabled = false
      if (tc.getHelper()) tc.getHelper().visible = false
      rc?.detach()
      if (rc) {
        rc.enabled = false
        if (rc.getHelper()) rc.getHelper().visible = false
      }
      rg?.setVisible(false)
      return
    }

    if (transformMode === 'translate') {
      // 1. Move Tool (Screenshot 1): 3 arrows + center cube (controls XYZ)
      tc.enabled = true
      tc.setMode('translate')
      tc.showX = true
      tc.showY = true
      tc.showZ = true
      tc.showXY = true
      tc.showYZ = true
      tc.showXZ = true
      tc.showXYZE = false
      if (tc.object !== model) tc.attach(model)
      if (tc.getHelper()) tc.getHelper().visible = true

      rc?.detach()
      if (rc) {
        rc.enabled = false
        if (rc.getHelper()) rc.getHelper().visible = false
      }
      rg?.setVisible(false)
    } else if (transformMode === 'rotate') {
      // 2. Rotate Tool: 3 colored rotation rings
      tc.detach()
      tc.enabled = false
      if (tc.getHelper()) tc.getHelper().visible = false

      if (rc) {
        rc.enabled = true
        if (rc.object !== model) rc.attach(model)
        if (rc.getHelper()) rc.getHelper().visible = true
      }
      rg?.setVisible(false)
    } else if (transformMode === 'scale') {
      // 3. Scale Tool (Screenshot 2 reference): 3 colored boxes + silver center cube, equal scaling
      tc.enabled = true
      tc.setMode('scale')
      tc.showX = true
      tc.showY = true
      tc.showZ = true
      tc.showXY = true
      tc.showYZ = true
      tc.showXZ = true
      tc.showXYZE = false
      if (tc.object !== model) tc.attach(model)
      if (tc.getHelper()) tc.getHelper().visible = true

      rc?.detach()
      if (rc) {
        rc.enabled = false
        if (rc.getHelper()) rc.getHelper().visible = false
      }
      rg?.setVisible(false)
    } else if (transformMode === 'rect') {
      // 4. Rect Tool (Screenshot 3 reference): oriented 2D frame with 4 corner scale handles & center move
      tc.detach()
      tc.enabled = false
      if (tc.getHelper()) tc.getHelper().visible = false
      rc?.detach()
      if (rc) {
        rc.enabled = false
        if (rc.getHelper()) rc.getHelper().visible = false
      }
      if (rg) {
        rg.setOrientation(rectOrientation)
        rg.setUniversal(false)
        rg.setVisible(true)
      }
    } else if (transformMode === 'universal') {
      // 5. Transform Tool: Move arrows + center cube & Rotate rings (Rect tool removed)
      tc.enabled = true
      tc.setMode('translate')
      tc.showX = true
      tc.showY = true
      tc.showZ = true
      tc.showXY = true
      tc.showYZ = true
      tc.showXZ = true
      tc.showXYZE = false
      if (tc.object !== model) tc.attach(model)
      if (tc.getHelper()) tc.getHelper().visible = true

      if (rc) {
        rc.enabled = true
        if (rc.object !== model) rc.attach(model)
        if (rc.getHelper()) rc.getHelper().visible = true
      }

      rg?.setVisible(false)
    }
  }, [transformMode, space, snapEnabled, gizmoSize, modelReady])

  const handleReset = (type) => {
    if (type === 'pos') {
      onTransformChangeRef.current?.({ position_x: 0, position_y: 0, position_z: 0 }, true)
    } else if (type === 'rot') {
      onTransformChangeRef.current?.({ rotation_x: 0, rotation_y: 0, rotation_z: 0 }, true)
    } else if (type === 'scale') {
      onTransformChangeRef.current?.({ scale_x: 1, scale_y: 1, scale_z: 1, scale: 1 }, true)
    } else {
      onTransformChangeRef.current?.({
        position_x: 0,
        position_y: 0,
        position_z: 0,
        rotation_x: 0,
        rotation_y: 0,
        rotation_z: 0,
        scale_x: 1,
        scale_y: 1,
        scale_z: 1,
        scale: 1,
      }, true)
    }
  }

  // Rebuild scene contents when target / model changes
  useEffect(() => {
    const world = worldRef.current
    if (!world) return

    modelGroupRef.current = null
    transformControlsRef.current?.detach()
    rotateControlsRef.current?.detach()
    rectGizmoRef.current?.setVisible(false)
    setModelReady(false)
    animCtlRef.current?.dispose()
    animCtlRef.current = null
    mediaPanelRef.current?.dispose()
    mediaPanelRef.current = null
    onAnimationController?.(null)

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
      const isMedia = ['mp4', 'webm', 'gif'].includes(asset.format)
      setModelState(isMedia ? 'loading media…' : 'loading model…')
      if (isMedia) {
        createMediaPanel(rel(asset.model_file), asset.format)
          .then((panel) => {
            if (modelGroupRef.current !== modelGroup) {
              panel.dispose()
              return
            }
            modelGroup.add(panel.mesh)
            mediaPanelRef.current = panel
            transformControlsRef.current?.attach(modelGroup)
            setModelReady(true)
            setModelState('')
          })
          .catch((err) => {
            console.error('Could not load media asset:', err)
            if (modelGroupRef.current === modelGroup) {
              setModelState('media failed to load')
            }
          })
      } else {
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
          transformControlsRef.current?.attach(modelGroup)
          if (gltf.animations?.length) {
            const ctl = createAnimationController(gltf)
            ctl.play()
            animCtlRef.current = ctl
            onAnimationController?.(ctl)
          }
          setModelReady(true)
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
      }
    } else {
      setModelState('')
    }
  }, [target, asset, aspect, onAnimationController])

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
    if (Array.isArray(transform.scale)) {
      g.scale.set(...transform.scale)
    } else {
      g.scale.setScalar(transform.scale)
    }
  }, [transform, target, aspect])

  return (
    <div className="viewport">
      {/* Canvas host must stay childless: React must not reconcile away the
          imperatively-appended WebGL canvas when the badge toggles below. */}
      <div className="viewport-canvas" ref={mountRef} />
      {modelState && <div className="viewport-badge">{modelState}</div>}
      {modelReady && (
        <UnityGizmoToolbar
          mode={transformMode}
          onModeChange={setTransformMode}
          space={space}
          onSpaceChange={setSpace}
          snapEnabled={snapEnabled}
          onToggleSnap={() => setSnapEnabled((s) => !s)}
          gizmoSize={gizmoSize}
          onSizeChange={setGizmoSize}
          onReset={handleReset}
          rectOrientation={rectOrientation}
          onRectOrientationChange={(o) => {
            setRectOrientation(o)
            rectGizmoRef.current?.setOrientation(o)
          }}
        />
      )}
    </div>
  )
}
