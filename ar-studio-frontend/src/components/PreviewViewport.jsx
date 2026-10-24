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
  const scaleControlsRef = useRef(null)
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
  const onAnimationControllerRef = useRef(onAnimationController)
  const transformModeRef = useRef(transformMode)

  useEffect(() => {
    transformModeRef.current = transformMode
  }, [transformMode])

  useEffect(() => {
    aspectRef.current = aspect
  }, [aspect])

  useEffect(() => {
    onTransformChangeRef.current = onTransformChange
  }, [onTransformChange])

  useEffect(() => {
    onAnimationControllerRef.current = onAnimationController
  }, [onAnimationController])

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

    // Precision-fix TransformControls picking: stock scale pickers are fat 0.6-long
    // cones that overlap every axis in screen space — clicking the X cube often
    // ray-hits the Y/Z cone or the center box first, so the wrong axis scales.
    // Replace them with small boxes sitting exactly on the visible cubes, slim the
    // translate cones, and enlarge the tiny stock scale cubes (0.08 -> 0.12).
    const sharpenPickers = (controls, hideCenterCube = false) => {
      const gz = controls._gizmo
      if (!gz) return

      const axisDirs = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }

      const scalePicker = gz.picker?.scale
      if (scalePicker) {
        Object.entries(axisDirs).forEach(([name, d]) => {
          const holder = scalePicker.getObjectByName(name)
          if (!holder?.isGroup) return
          const mat = holder.children.find((c) => c.isMesh)?.material
          holder.children.slice().forEach((c) => {
            holder.remove(c)
            c.geometry?.dispose?.()
          })
          const box = new THREE.BoxGeometry(0.2, 0.2, 0.2)
          ;[1, -1].forEach((sign) => {
            const m = new THREE.Mesh(box, mat)
            m.name = name
            m.position.set(d[0] * 0.5 * sign, d[1] * 0.5 * sign, d[2] * 0.5 * sign)
            holder.add(m)
          })
        })
        scalePicker.getObjectByName('XYZ')?.traverse((c) => {
          if (!c.isMesh) return
          c.geometry?.dispose?.()
          c.geometry = new THREE.BoxGeometry(0.16, 0.16, 0.16)
        })
      }

      const translatePicker = gz.picker?.translate
      if (translatePicker) {
        Object.keys(axisDirs).forEach((name) => {
          const holder = translatePicker.getObjectByName(name)
          if (!holder?.isGroup) return
          holder.children.forEach((c) => {
            if (!c.isMesh || c.geometry?.type !== 'CylinderGeometry') return
            c.geometry.dispose()
            c.geometry = new THREE.CylinderGeometry(0.08, 0, 0.6, 4)
          })
        })
      }

      const scaleGizmo = gz.gizmo?.scale
      if (scaleGizmo) {
        Object.keys(axisDirs).forEach((name) => {
          scaleGizmo.getObjectByName(name)?.children.slice().forEach((c) => {
            if (!c.isMesh || c.geometry?.type !== 'BoxGeometry') return
            c.geometry.dispose()
            c.geometry = new THREE.BoxGeometry(0.12, 0.12, 0.12)
          })
        })
        if (hideCenterCube) {
          scaleGizmo.getObjectByName('XYZ')?.traverse((c) => {
            if (c.isMesh) c.visible = false
          })
        }
      }
    }

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

    sharpenPickers(transformControls, false)

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

    // 3. Scale TransformControls (used by Scale tool & Universal multi-tool mode)
    const scaleControls = new TransformControls(camera, renderer.domElement)
    scaleControls.setSpace('world')
    scaleControls.setMode('scale')
    scaleControls.setColors(0xff385c, 0x22cc55, 0x2988ff, 0xffea00)
    scaleControls.size = 1.05
    scaleControls.showX = true
    scaleControls.showY = true
    scaleControls.showZ = true
    scaleControls.showXY = false
    scaleControls.showYZ = false
    scaleControls.showXZ = false
    scaleControls.showXYZE = false
    scaleControls.showE = false

    const scaleHelper = scaleControls.getHelper()
    scaleHelper.traverse((child) => {
      if (child.material) {
        child.material.depthTest = false
        child.material.depthWrite = false
        child.material.transparent = true
        child.renderOrder = 9997
      }
    })
    sharpenPickers(scaleControls, true)
    scene.add(scaleHelper)
    scaleControlsRef.current = scaleControls

    // In Universal mode all three controls share the canvas and their picker
    // volumes overlap — disable the others while one is dragging so a press on
    // an outer arrow can't start translate AND rotate AND scale at the same time.
    const beginExclusive = (self) => {
      controls.enabled = false
      if (transformModeRef.current !== 'universal') return
      if (self !== transformControls) transformControls.enabled = false
      if (self !== rotateControls) rotateControls.enabled = false
      if (self !== scaleControls) scaleControls.enabled = false
    }
    const endExclusive = () => {
      controls.enabled = true
      if (transformModeRef.current !== 'universal') return
      transformControls.enabled = true
      rotateControls.enabled = true
      scaleControls.enabled = true
    }
    transformControls.addEventListener('dragging-changed', (event) => {
      if (event.value) beginExclusive(transformControls)
      else endExclusive()
    })
    rotateControls.addEventListener('dragging-changed', (event) => {
      if (event.value) beginExclusive(rotateControls)
      else endExclusive()
    })
    scaleControls.addEventListener('dragging-changed', (event) => {
      if (event.value) beginExclusive(scaleControls)
      else endExclusive()
    })

    const reportTransform = (commit) => {
      const group = modelGroupRef.current
      if (!group) return

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
    scaleControls.addEventListener('objectChange', () => reportTransform(false))
    scaleControls.addEventListener('mouseUp', () => reportTransform(true))

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
      scaleControls.detach()
      scaleControls.dispose()
      scaleControlsRef.current = null
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
    // Scene setup is once-per-mount; callback identity changes go through the ref.
  }, [])

  // Synchronize active gizmo tools with transformMode, space, snaps, and model state
  useEffect(() => {
    const tc = transformControlsRef.current
    const rc = rotateControlsRef.current
    const sc = scaleControlsRef.current
    const rg = rectGizmoRef.current
    const model = modelGroupRef.current
    if (!tc) return

    tc.setSpace(space)
    tc.setSize(gizmoSize * 1.15)
    if (rc) {
      rc.setSpace(space)
      rc.setSize(gizmoSize * 1.05)
    }
    if (sc) {
      sc.setSpace(space)
      sc.setSize(gizmoSize * 1.55)
    }

    if (snapEnabled) {
      tc.setTranslationSnap(0.1)
      tc.setRotationSnap(THREE.MathUtils.degToRad(15))
      tc.setScaleSnap(0.1)
      rc?.setRotationSnap(THREE.MathUtils.degToRad(15))
      sc?.setScaleSnap(0.1)
    } else {
      tc.setTranslationSnap(null)
      tc.setRotationSnap(null)
      tc.setScaleSnap(null)
      rc?.setRotationSnap(null)
      sc?.setScaleSnap(null)
    }

    const hideScale = () => {
      sc?.detach()
      if (sc) {
        sc.enabled = false
        if (sc.getHelper()) sc.getHelper().visible = false
      }
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
      hideScale()
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
      hideScale()
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
      hideScale()
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
      hideScale()
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
      hideScale()
      if (rg) {
        rg.setOrientation(rectOrientation)
        rg.setUniversal(false)
        rg.setVisible(true)
      }
    } else if (transformMode === 'universal') {
      // 5. Transform Tool: Move arrows + center cube, Rotate rings & Scale handles
      // Scale cubes sized larger than the rings so they sit outside them
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

      if (sc) {
        sc.enabled = true
        if (sc.object !== model) sc.attach(model)
        if (sc.getHelper()) sc.getHelper().visible = true
      }

      rg?.setVisible(false)
    }
  }, [transformMode, space, snapEnabled, gizmoSize, modelReady, rectOrientation])

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
    scaleControlsRef.current?.detach()
    rectGizmoRef.current?.setVisible(false)
    setModelReady(false)
    animCtlRef.current?.dispose()
    animCtlRef.current = null
    mediaPanelRef.current?.dispose()
    mediaPanelRef.current = null
    onAnimationControllerRef.current?.(null)

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
            rectGizmoRef.current?.invalidateBounds?.()
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
          rectGizmoRef.current?.invalidateBounds?.()
          if (gltf.animations?.length) {
            const ctl = createAnimationController(gltf)
            ctl.play()
            animCtlRef.current = ctl
            onAnimationControllerRef.current?.(ctl)
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
  }, [target, asset, aspect])

  // Live transform
  useEffect(() => {
    if (rectGizmoRef.current?.isDragging?.()) return
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
