import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { createAnimationController } from '../ar/animation'
import { createMediaPanel } from '../ar/mediaPanel'
import { isFlatMedia } from '../ar/anchors'
import {
  applyARItemTransform,
  eulerDegreesFromObject,
  fitModelToMarker,
  createContactShadow,
} from '../ar/sceneTransform'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { createRectGizmo } from './RectGizmo'
import UnityGizmoToolbar from './UnityGizmoToolbar'
import { drawFeaturePreview } from '../ar/targetFeaturePreview'

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
  items = [],
  selectedItemId = null,
  onAnimationController,
  onTransformChange,
}) {
  const mountRef = useRef(null)
  const worldRef = useRef(null)
  const controlsRef = useRef(null)
  const modelGroupRef = useRef(null)
  const groupsRef = useRef(new Map())
  const animCtlsRef = useRef(new Map())
  const mediaPanelsRef = useRef(new Map())
  const transformControlsRef = useRef(null)
  const rotateControlsRef = useRef(null)
  const scaleControlsRef = useRef(null)
  const rectGizmoRef = useRef(null)
  const [aspectMap, setAspectMap] = useState({})
  const [modelState, setModelState] = useState('')
  const [transformMode, setTransformMode] = useState('translate')
  const [space, setSpace] = useState('world')
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [gizmoSize, setGizmoSize] = useState(1)
  const [modelReady, setModelReady] = useState(false)
  const [showTargetFeatures, setShowTargetFeatures] = useState(false)
  const targetPlanesRef = useRef(new Map())
  const [rectOrientation, setRectOrientation] = useState('horizontal')
  const onTransformChangeRef = useRef(onTransformChange)
  const onAnimationControllerRef = useRef(onAnimationController)
  const transformModeRef = useRef(transformMode)
  const selectedItemIdRef = useRef(selectedItemId)
  const layoutRef = useRef([])
  const draggingRef = useRef(false)

  // Row layout: distinct markers side by side, each item on its own marker.
  const targetsKey = items.map((i) => i.target?.id ?? '').join(',')
  const layout = []
  {
    const seen = new Map()
    let ox = 0
    for (const item of items) {
      if (!item.target?.id) continue
      if (!seen.has(item.target.id)) {
        seen.set(item.target.id, { ox, aspect: aspectMap[item.target.id] ?? 0.75 })
        ox += 1.4
      }
      const slot = seen.get(item.target.id)
      layout.push({ ...item, ox: slot.ox, aspect: slot.aspect })
    }
  }
  const layoutKey = layout.map((e) => `${e.id}|${e.target.id}|${e.asset?.id ?? ''}`).join(',')
  const aspectsKey = layout.map((e) => e.aspect.toFixed(3)).join(',')

  useEffect(() => {
    selectedItemIdRef.current = selectedItemId
    layoutRef.current = layout
  })

  useEffect(() => {
    transformModeRef.current = transformMode
  }, [transformMode])

  useEffect(() => {
    onTransformChangeRef.current = onTransformChange
  }, [onTransformChange])

  useEffect(() => {
    onAnimationControllerRef.current = onAnimationController
  }, [onAnimationController])

  // Load natural aspect ratios for every marker used in the scene.
  useEffect(() => {
    const ids = targetsKey ? targetsKey.split(',').filter(Boolean) : []
    let alive = true
    for (const id of ids) {
      const item = items.find((i) => i.target?.id === id)
      if (!item) continue
      const img = new Image()
      img.onload = () => {
        if (!alive || !img.naturalWidth) return
        const value = img.naturalHeight / img.naturalWidth
        setAspectMap((current) =>
          current[id] && Math.abs(current[id] - value) < 1e-6
            ? current
            : { ...current, [id]: value }
        )
      }
      img.src = rel(item.target.image)
    }
    return () => {
      alive = false
    }
  }, [targetsKey])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    try {

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const pmremGenerator = new THREE.PMREMGenerator(renderer)
    pmremGenerator.compileEquirectangularShader()
    const roomEnv = new RoomEnvironment()
    const envTexture = pmremGenerator.fromScene(roomEnv, 0.04).texture
    scene.environment = envTexture

    const ambientLight = new THREE.HemisphereLight(0xffffff, 0x334455, 0.65)
    scene.add(ambientLight)
    const key = new THREE.DirectionalLight(0xffffff, 1.45)
    key.position.set(2, 4, 2)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x90b4d6, 0.5)
    fill.position.set(-2, 1, -2)
    scene.add(fill)
    const rim = new THREE.DirectionalLight(0xffeedd, 0.45)
    rim.position.set(0, -2, -2)
    scene.add(rim)

    const isLight = () => document.documentElement.dataset.theme === 'light'
    const applyTheme = () => {
      const light = isLight()
      scene.background = new THREE.Color(light ? 0xd8dadd : 0x202226)
      scene.fog = new THREE.Fog(scene.background, 5, 15)
      ambientLight.intensity = light ? 0.8 : 0.65
      key.intensity = light ? 1.55 : 1.45
      fill.intensity = light ? 0.6 : 0.5
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
    controlsRef.current = controls

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
      draggingRef.current = event.value
      if (event.value) beginExclusive(transformControls)
      else endExclusive()
    })
    rotateControls.addEventListener('dragging-changed', (event) => {
      draggingRef.current = event.value
      if (event.value) beginExclusive(rotateControls)
      else endExclusive()
    })
    scaleControls.addEventListener('dragging-changed', (event) => {
      draggingRef.current = event.value
      if (event.value) beginExclusive(scaleControls)
      else endExclusive()
    })

    const reportTransform = (commit) => {
      const group = modelGroupRef.current
      if (!group) return
      const entry = layoutRef.current.find(
        (e) => groupsRef.current.get(e.id) === group
      )
      if (!entry) return
      const rot = eulerDegreesFromObject(group)

      onTransformChangeRef.current?.(
        entry.id,
        {
          position_x: group.position.x - entry.ox - 0.5,
          position_y: entry.aspect / 2 - group.position.z,
          position_z: group.position.y,
          rotation_x: rot.rotation_x,
          rotation_y: rot.rotation_y,
          rotation_z: rot.rotation_z,
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

    const grid = new THREE.GridHelper(8, 32, 0x46484d, 0x383a3f)
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
      for (const ctl of animCtlsRef.current.values()) ctl.update(dt)
      for (const panel of mediaPanelsRef.current.values()) panel.update()
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
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(mount)
    onResize()

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      pmremGenerator.dispose()
      envTexture.dispose()
      for (const ctl of animCtlsRef.current.values()) ctl.dispose()
      animCtlsRef.current.clear()
      for (const panel of mediaPanelsRef.current.values()) panel.dispose()
      mediaPanelsRef.current.clear()
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
      controlsRef.current = null
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

  // Synchronize active gizmo tools with transformMode, space, snaps, and model
  // state. Plain function (not just an effect) so scene rebuilds and selection
  // changes can re-attach immediately after the selected group changes.
  const syncGizmos = () => {
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
        rg.setSize?.(gizmoSize)
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
  }

  useEffect(() => {
    syncGizmos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transformMode, space, snapEnabled, gizmoSize, modelReady, rectOrientation])

  const handleReset = (type) => {
    const itemId = selectedItemIdRef.current
    if (type === 'pos') {
      onTransformChangeRef.current?.(itemId, { position_x: 0, position_y: 0, position_z: 0 }, true)
    } else if (type === 'rot') {
      onTransformChangeRef.current?.(itemId, { rotation_x: 0, rotation_y: 0, rotation_z: 0 }, true)
    } else if (type === 'scale') {
      onTransformChangeRef.current?.(itemId, { scale_x: 1, scale_y: 1, scale_z: 1, scale: 1 }, true)
    } else {
      onTransformChangeRef.current?.(itemId, {
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

  // Preview mapping: AR frame (x right, y down-image, z out-of-plane)
  // -> ground plane (x right, z depth, y up); origin at plane center, with the
  // plane offset by its row slot (entry.ox).
  const applyTransforms = () => {
    if (draggingRef.current || rectGizmoRef.current?.isDragging?.()) return
    for (const entry of layoutRef.current) {
      const g = groupsRef.current.get(entry.id)
      if (!g || !entry.transform) continue
      applyARItemTransform(g, entry.transform)
      g.position.x += entry.ox + 0.5
      g.position.z += entry.aspect / 2
    }
  }

  // Rebuild scene contents when the item set (markers / models) changes
  useEffect(() => {
    const world = worldRef.current
    if (!world) return

    modelGroupRef.current = null
    groupsRef.current = new Map()
    transformControlsRef.current?.detach()
    rotateControlsRef.current?.detach()
    scaleControlsRef.current?.detach()
    rectGizmoRef.current?.setVisible(false)
    setModelReady(false)
    for (const ctl of animCtlsRef.current.values()) ctl.dispose()
    animCtlsRef.current.clear()
    for (const panel of mediaPanelsRef.current.values()) panel.dispose()
    mediaPanelsRef.current.clear()
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

    const entries = layoutRef.current
    if (!entries.length) {
      setModelState('')
      syncGizmos()
      return
    }

    // Marker planes — one per distinct target image, laid out in a row.
    const slots = new Map()
    for (const entry of entries) {
      if (slots.has(entry.target.id)) continue
      slots.set(entry.target.id, {
        ox: entry.ox,
        aspect: entry.aspect,
        image: entry.target.image,
        target: entry.target,
      })
    }
    targetPlanesRef.current.clear()

    for (const slot of slots.values()) {
      const planeGeo = new THREE.PlaneGeometry(1, slot.aspect)
      planeGeo.rotateX(-Math.PI / 2)
      const normalTex = new THREE.TextureLoader().load(rel(slot.image))
      normalTex.colorSpace = THREE.SRGBColorSpace
      const planeMat = new THREE.MeshStandardMaterial({ map: normalTex, roughness: 0.9, metalness: 0 })
      const plane = new THREE.Mesh(planeGeo, planeMat)
      plane.position.set(slot.ox + 0.5, 0.001, slot.aspect / 2)
      world.add(plane)

      targetPlanesRef.current.set(slot.target.id, {
        mesh: plane,
        material: planeMat,
        normalTex,
        featureTex: null,
        slot,
      })

      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(
          new THREE.PlaneGeometry(1, slot.aspect).rotateX(-Math.PI / 2)
        ),
        new THREE.LineBasicMaterial({ color: 0x77797e })
      )
      edge.position.set(slot.ox + 0.5, 0.002, slot.aspect / 2)
      world.add(edge)
    }

    const controls = controlsRef.current
    if (controls) {
      const rowWidth = slots.size * 1.4 - 0.4
      controls.target.set(Math.max(0.5, rowWidth / 2), 0.1, 0.4)
    }

    let pending = entries.length
    let failed = 0
    const finishOne = (ok) => {
      if (!ok) failed++
      pending--
      if (pending > 0) return
      setModelState(
        failed ? `${failed} asset${failed > 1 ? 's' : ''} failed to load` : ''
      )
    }
    setModelState('loading model…')

    for (const entry of entries) {
      const modelGroup = new THREE.Group()
      modelGroup.rotation.order = 'YXZ'
      world.add(modelGroup)
      groupsRef.current.set(entry.id, modelGroup)

      const asset = entry.asset
      if (!asset?.model_file) {
        finishOne(true)
        continue
      }

      const isMedia = isFlatMedia(asset.format)
      const stale = () => groupsRef.current.get(entry.id) !== modelGroup

      if (isMedia) {
        createMediaPanel(rel(asset.model_file), asset.format)
          .then((panel) => {
            if (stale()) {
              panel.dispose()
              finishOne(false)
              return
            }
            modelGroup.add(panel.mesh)
            mediaPanelsRef.current.set(entry.id, panel)
            rectGizmoRef.current?.invalidateBounds?.()
            setModelReady(true)
            finishOne(true)
          })
          .catch((err) => {
            console.error('Could not load media asset:', err)
            finishOne(false)
          })
      } else {
        new GLTFLoader().load(
          rel(asset.model_file),
          (gltf) => {
            if (stale()) return
            const model = gltf.scene
            const size = fitModelToMarker(model)
            modelGroup.add(model)

            // Add soft contact shadow under model onto the target marker plane
            const shadow = createContactShadow(size.x, size.z)
            const pz = Number(entry.transform?.position?.[2] || entry.transform?.position_z || 0)
            shadow.position.set(0, -pz + 0.0015, 0)
            modelGroup.add(shadow)

            // Enhance materials and textures
            model.traverse((child) => {
              if (child.isMesh) {
                child.frustumCulled = false
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

            rectGizmoRef.current?.invalidateBounds?.()
            if (gltf.animations?.length) {
              const ctl = createAnimationController(gltf)
              if (entry.animation) ctl.applySettings(entry.animation)
              else ctl.play()
              animCtlsRef.current.set(entry.id, ctl)
              if (selectedItemIdRef.current === entry.id) {
                onAnimationControllerRef.current?.(ctl)
              }
            }
            setModelReady(true)
            finishOne(true)
          },
          (evt) => {
            if (evt.total) {
              const pct = Math.round((evt.loaded / evt.total) * 100)
              setModelState(`loading model… ${pct}%`)
            }
          },
          () => finishOne(false)
        )
      }
    }

    applyTransforms()
    modelGroupRef.current =
      groupsRef.current.get(selectedItemIdRef.current) || null
    syncGizmos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, aspectsKey])

  // Selection change: re-point gizmos + animation panel at the chosen item.
  useEffect(() => {
    const itemId = selectedItemIdRef.current
    modelGroupRef.current = groupsRef.current.get(itemId) || null
    applyTransforms()
    onAnimationControllerRef.current?.(animCtlsRef.current.get(itemId) || null)
    syncGizmos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId])

  // Live transform — applies every item's transform (transform edits come in
  // as new `items` identities from the parent).
  useEffect(() => {
    if (rectGizmoRef.current?.isDragging?.()) return
    applyTransforms()
    if (transformModeRef.current === 'rect') {
      rectGizmoRef.current?.invalidateBounds?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // Toggle target feature points (grayscale + red circles) on ground marker planes
  useEffect(() => {
    for (const entry of targetPlanesRef.current.values()) {
      if (showTargetFeatures) {
        if (!entry.featureTex) {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => {
            const canvas = document.createElement('canvas')
            const kps =
              entry.slot.target?.tracking_data?.rich_keypoints ||
              entry.slot.target?.tracking_data?.keypoints ||
              []
            drawFeaturePreview(canvas, img, kps, {
              grayscale: true,
              showFeatures: true,
              strokeColor: '#ff2222',
            })
            const tex = new THREE.CanvasTexture(canvas)
            tex.colorSpace = THREE.SRGBColorSpace
            entry.featureTex = tex
            if (showTargetFeatures) {
              entry.material.map = tex
              entry.material.needsUpdate = true
            }
          }
          img.src = rel(entry.slot.image)
        } else {
          entry.material.map = entry.featureTex
          entry.material.needsUpdate = true
        }
      } else {
        entry.material.map = entry.normalTex
        entry.material.needsUpdate = true
      }
    }
  }, [showTargetFeatures])

  return (
    <div className="viewport">
      {/* Canvas host must stay childless: React must not reconcile away the
          imperatively-appended WebGL canvas when the badge toggles below. */}
      <div className="viewport-canvas" ref={mountRef} />
      {modelState && <div className="viewport-badge">{modelState}</div>}
      <button
        type="button"
        className={`viewport-features-toggle ${showTargetFeatures ? 'active' : ''}`}
        onClick={() => setShowTargetFeatures((v) => !v)}
        title="Toggle OpenCV Feature Points (Grayscale + Red Circles) on ground marker"
      >
        <span className="features-toggle-dot" />
        {showTargetFeatures ? '✓ Target Features ON' : '🎯 Target Features'}
      </button>
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
