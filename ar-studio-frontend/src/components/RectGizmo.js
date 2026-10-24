import * as THREE from 'three'

/**
 * Unity-Style 3D Rect Tool Gizmo.
 *
 * Implements complete rectangular bounding frame manipulation matching Unity Editor:
 * 1. Camera-Facing Manipulation Plane:
 *    - Horizontal (Surface / XZ): aligned to AR image target plane with camera-facing normal.
 *    - Vertical: dynamically chooses dominant camera-facing vertical plane (XY or ZY).
 * 2. Center Drag (Move):
 *    - Translates the object smoothly along the manipulation plane when dragging the
 *      center handle OR anywhere inside the rectangular frame polygon.
 *    - Preserves depth relative to the plane. Zero jump on click.
 * 3. 4 Corner Handles (Resize Width & Height):
 *    - Dragging a corner handle resizes width (hKey) and height (vKey) independently.
 *    - Opposite corner remains 100% stationary/anchored in world space.
 *    - Shift key locks aspect ratio for proportional resizing.
 *    - Depth axis (out-of-plane) is preserved.
 * 4. 4 Edge Handles (Resize One Dimension):
 *    - Dragging horizontal edges (Bottom/Top) scales only height (vKey), leaving width untouched.
 *    - Dragging vertical edges (Left/Right) scales only width (hKey), leaving height untouched.
 *    - Opposite edge remains 100% stationary/anchored in world space.
 *    - Depth axis is preserved.
 * 5. Screen-Space Consistent Sizing & Contextual Cursors:
 *    - Handles maintain constant readable pixel dimensions at any camera zoom/distance.
 *    - Hit tests are performed in screen space (pixels) with generous hit areas.
 *    - Screen-space angle calculation assigns accurate resize cursors (ew-resize, ns-resize,
 *      nwse-resize, nesw-resize) dynamically adapting to camera orbit and object rotation.
 * 6. Interaction State Machine & Pointer Capture:
 *    - idle -> hover -> dragging (corner | edge | move) -> idle
 *    - Pointer capture on canvas ensures drags continue smoothly outside canvas/window.
 *    - OrbitControls suspended during drag and restored on release.
 *    - Real-time transform reporting during drag (false) and persistence commit on release (true).
 */
export function createRectGizmo({
  scene,
  camera,
  domElement,
  getModelGroup,
  onTransformChange,
  orbitControls,
}) {
  // ─── Scene Groups ────────────────────────────────────────────────────────────
  const gizmoGroup = new THREE.Group()
  gizmoGroup.name = 'RectGizmoGroup'
  gizmoGroup.visible = false
  scene.add(gizmoGroup)

  // ─── Materials ───────────────────────────────────────────────────────────────
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0x1e88e5, // Unity blue
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  })
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, // Crisp white
    depthTest: false,
    depthWrite: false,
  })
  const hoverMat = new THREE.MeshBasicMaterial({
    color: 0xffd600, // Vibrant hover gold
    depthTest: false,
    depthWrite: false,
  })
  const dragMat = new THREE.MeshBasicMaterial({
    color: 0x00e5ff, // Electric cyan active
    depthTest: false,
    depthWrite: false,
  })

  // Frame outline line
  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 3), 3))
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x00d4ff,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  })
  const frameLine = new THREE.Line(lineGeo, lineMat)
  frameLine.renderOrder = 9998
  gizmoGroup.add(frameLine)

  // Translucent plane fill (gives subtle visible interior highlight)
  const planeFillGeo = new THREE.BufferGeometry()
  const fillPosAttr = new THREE.BufferAttribute(new Float32Array(4 * 3), 3)
  const fillIndexAttr = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1)
  planeFillGeo.setAttribute('position', fillPosAttr)
  planeFillGeo.setIndex(fillIndexAttr)
  const planeFillMat = new THREE.MeshBasicMaterial({
    color: 0x00d4ff,
    transparent: true,
    opacity: 0.04,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const planeFillMesh = new THREE.Mesh(planeFillGeo, planeFillMat)
  planeFillMesh.renderOrder = 9996
  gizmoGroup.add(planeFillMesh)

  // ─── 4 Corner Handles ────────────────────────────────────────────────────────
  // 0: Bottom-Left (hMin, vMin)
  // 1: Bottom-Right (hMax, vMin)
  // 2: Top-Right (hMax, vMax)
  // 3: Top-Left (hMin, vMax)
  const cornerOuterGeo = new THREE.SphereGeometry(0.5, 16, 16)
  const cornerInnerGeo = new THREE.SphereGeometry(0.24, 16, 16)

  const cornerObjs = []
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group()
    g.name = `RectCorner_${i}`
    const outer = new THREE.Mesh(cornerOuterGeo, outerMat)
    outer.renderOrder = 10001
    const inner = new THREE.Mesh(cornerInnerGeo, innerMat)
    inner.renderOrder = 10002
    g.add(outer, inner)
    gizmoGroup.add(g)
    cornerObjs.push({ group: g, outer, inner, worldPos: new THREE.Vector3() })
  }

  // ─── 4 Edge Midpoint Handles ─────────────────────────────────────────────────
  // 0: Bottom (between 0 & 1, vMin)
  // 1: Right (between 1 & 2, hMax)
  // 2: Top (between 2 & 3, vMax)
  // 3: Left (between 3 & 0, hMin)
  const edgeOuterGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7)
  const edgeInnerGeo = new THREE.BoxGeometry(0.35, 0.35, 0.35)

  const edgeObjs = []
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group()
    g.name = `RectEdge_${i}`
    const outer = new THREE.Mesh(edgeOuterGeo, outerMat)
    outer.renderOrder = 9999
    const inner = new THREE.Mesh(edgeInnerGeo, innerMat)
    inner.renderOrder = 10000
    g.add(outer, inner)
    gizmoGroup.add(g)
    edgeObjs.push({ group: g, outer, inner, worldPos: new THREE.Vector3() })
  }

  // ─── Center Handle (Pivot / Move Indicator) ──────────────────────────────────
  const centerGroup = new THREE.Group()
  centerGroup.name = 'RectCenter'
  const ringGeo = new THREE.TorusGeometry(0.55, 0.1, 16, 32)
  const ring = new THREE.Mesh(ringGeo, outerMat)
  ring.renderOrder = 10003
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), innerMat)
  dot.renderOrder = 10004
  centerGroup.add(ring, dot)
  gizmoGroup.add(centerGroup)
  const centerWorldPos = new THREE.Vector3()
  const worldNormal = new THREE.Vector3(0, 1, 0)

  // ─── State ───────────────────────────────────────────────────────────────────
  let isUniversalMode = false
  let isDragging = false
  let dragMode = null // 'corner' | 'edge' | 'move'
  let activeHandle = -1
  let activePointerId = null
  let preferredOrientation = 'horizontal' // 'horizontal' (XZ) | 'vertical' (XY/ZY)
  let activePlaneName = 'XZ'
  let currentPlaneGeom = null
  let lockedPlaneGeom = null

  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  const dragPlane = new THREE.Plane()
  const hitStart = new THREE.Vector3()
  const hitCurrent = new THREE.Vector3()

  const startScale = new THREE.Vector3()
  const startPos = new THREE.Vector3()
  const anchorWorld = new THREE.Vector3()
  const anchorLocal = new THREE.Vector3()
  const dragDeltaLocal = new THREE.Vector3()
  const invQ = new THREE.Quaternion()
  let startExtentH = 1
  let startExtentV = 1

  // Cached model local bounds
  let cachedModel = null
  let cachedBox = new THREE.Box3()

  const invalidateBounds = () => {
    cachedModel = null
    cachedBox.makeEmpty()
  }

  const getLocalBounds = (model) => {
    if (cachedModel === model && !cachedBox.isEmpty()) {
      return cachedBox
    }
    const box = new THREE.Box3()
    model.updateMatrixWorld(true)
    const inv = model.matrixWorld.clone().invert()
    let meshCount = 0

    model.traverse((c) => {
      if (c === model || !c.isMesh || !c.geometry) return
      meshCount++
      if (!c.geometry.boundingBox) c.geometry.computeBoundingBox()
      if (!c.geometry.boundingBox) return
      const m = new THREE.Matrix4().copy(inv).multiply(c.matrixWorld)
      box.union(c.geometry.boundingBox.clone().applyMatrix4(m))
    })

    if (box.isEmpty() || meshCount === 0) {
      box.set(
        new THREE.Vector3(-0.25, 0, -0.25),
        new THREE.Vector3(0.25, 0.5, 0.25)
      )
    } else {
      cachedModel = model
      cachedBox.copy(box)
    }
    return box
  }

  // ─── Plane Geometry Generator ───────────────────────────────────────────────
  const computePlaneGeometry = (box, planeName, camLocal) => {
    let hKey, vKey, dKey
    let depth

    if (planeName === 'XY') {
      hKey = 'x'
      vKey = 'y'
      dKey = 'z'
      depth = camLocal.z >= 0 ? box.max.z : box.min.z
    } else if (planeName === 'ZY') {
      hKey = 'z'
      vKey = 'y'
      dKey = 'x'
      depth = camLocal.x >= 0 ? box.max.x : box.min.x
    } else {
      // 'XZ' (Horizontal plane on image target / surface)
      hKey = 'x'
      vKey = 'z'
      dKey = 'y'
      depth = box.min.y
    }

    const hMin = box.min[hKey]
    const hMax = box.max[hKey]
    const vMin = box.min[vKey]
    const vMax = box.max[vKey]
    const hCenter = (hMin + hMax) / 2
    const vCenter = (vMin + vMax) / 2
    const hSpan = Math.max((hMax - hMin) / 2, 1e-4)
    const vSpan = Math.max((vMax - vMin) / 2, 1e-4)

    const makePt = (h, v) => {
      const p = new THREE.Vector3()
      p[hKey] = h
      p[vKey] = v
      p[dKey] = depth
      return p
    }

    // 4 corners:
    // 0: Bottom-Left  (-, -)
    // 1: Bottom-Right (+, -)
    // 2: Top-Right    (+, +)
    // 3: Top-Left     (-, +)
    const corners = [
      makePt(hMin, vMin),
      makePt(hMax, vMin),
      makePt(hMax, vMax),
      makePt(hMin, vMax),
    ]

    // 4 edge midpoints:
    // 0: Bottom (between 0 and 1) -> vMin
    // 1: Right  (between 1 and 2) -> hMax
    // 2: Top    (between 2 and 3) -> vMax
    // 3: Left   (between 3 and 0) -> hMin
    const edgeMids = [
      makePt(hCenter, vMin),
      makePt(hMax, vCenter),
      makePt(hCenter, vMax),
      makePt(hMin, vCenter),
    ]

    const center = makePt(hCenter, vCenter)

    // Local normal pointing towards the camera
    const localNormal = new THREE.Vector3()
    if (planeName === 'XZ') {
      localNormal.y = camLocal.y >= 0 ? 1 : -1
    } else if (planeName === 'XY') {
      localNormal.z = camLocal.z >= 0 ? 1 : -1
    } else {
      localNormal.x = camLocal.x >= 0 ? 1 : -1
    }

    return {
      planeName,
      hKey,
      vKey,
      dKey,
      hMin,
      hMax,
      vMin,
      vMax,
      hCenter,
      vCenter,
      hSpan,
      vSpan,
      depth,
      corners,
      edgeMids,
      center,
      localNormal,
    }
  }

  // ─── Screen Projection & Sizing Helpers ─────────────────────────────────────
  const toScreen = (worldVec3) => {
    // Check if behind camera near plane
    const eye = worldVec3.clone().applyMatrix4(camera.matrixWorldInverse)
    if (eye.z >= -0.01) {
      return { x: -99999, y: -99999, visible: false }
    }
    const v = worldVec3.clone().project(camera)
    const r = domElement.getBoundingClientRect()
    return {
      x: (v.x * 0.5 + 0.5) * r.width,
      y: (-v.y * 0.5 + 0.5) * r.height,
      visible: true,
    }
  }

  const getScreenScale = (worldPos) => {
    const dist = camera.position.distanceTo(worldPos)
    if (camera.isPerspectiveCamera) {
      const vFOV = THREE.MathUtils.degToRad(camera.fov)
      const h = domElement.clientHeight || 600
      return (2 * Math.tan(vFOV / 2) * dist) / Math.max(h, 1)
    }
    return 0.002
  }

  const distToSegment = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1
    const dy = y2 - y1
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1e-4) return Math.hypot(px - x1, py - y1)
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
  }

  const pointInPolygon = (px, py, poly) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x
      const yi = poly[i].y
      const xj = poly[j].x
      const yj = poly[j].y
      const intersect =
        yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
      if (intersect) inside = !inside
    }
    return inside
  }

  // ─── Screen-Space Angle-Based Contextual Cursors ───────────────────────────
  const getAngleCursor = (dx, dy) => {
    let angle = Math.atan2(dy, dx) * (180 / Math.PI)
    if (angle < 0) angle += 180
    if (angle >= 22.5 && angle < 67.5) return 'nesw-resize'
    if (angle >= 67.5 && angle < 112.5) return 'ns-resize'
    if (angle >= 112.5 && angle < 157.5) return 'nwse-resize'
    return 'ew-resize'
  }

  const getCornerCursor = (cornerIndex, sCorners) => {
    const oppIndex = (cornerIndex + 2) % 4
    const c = sCorners[cornerIndex]
    const opp = sCorners[oppIndex]
    if (!c || !opp || !c.visible || !opp.visible) return 'crosshair'
    return getAngleCursor(c.x - opp.x, c.y - opp.y)
  }

  const getEdgeCursor = (edgeIndex, sCorners) => {
    const c1 = sCorners[edgeIndex]
    const c2 = sCorners[(edgeIndex + 1) % 4]
    if (!c1 || !c2 || !c1.visible || !c2.visible) return 'crosshair'
    const dx = c2.x - c1.x
    const dy = c2.y - c1.y
    // Perpendicular vector (-dy, dx) points in the resize direction
    return getAngleCursor(-dy, dx)
  }

  // ─── Update Visuals ─────────────────────────────────────────────────────────
  const update = () => {
    const model = getModelGroup?.()
    if (!model || !gizmoGroup.visible) return

    model.updateMatrixWorld(true)
    const box = getLocalBounds(model)

    // Compute camera position in model local space to determine dominant facing plane
    const invModelQ = model.quaternion.clone().invert()
    const camLocal = camera.position
      .clone()
      .sub(model.position)
      .applyQuaternion(invModelQ)

    if (!isDragging) {
      if (preferredOrientation === 'horizontal') {
        activePlaneName = 'XZ'
      } else {
        const absX = Math.abs(camLocal.x)
        const absZ = Math.abs(camLocal.z)
        activePlaneName = absX > absZ ? 'ZY' : 'XY'
      }
    }

    const planeGeom = computePlaneGeometry(box, activePlaneName, camLocal)
    currentPlaneGeom = planeGeom

    // Transform local points to world space
    const worldCorners = planeGeom.corners.map((c) =>
      c.clone().applyMatrix4(model.matrixWorld)
    )
    const worldEdgeMids = planeGeom.edgeMids.map((e) =>
      e.clone().applyMatrix4(model.matrixWorld)
    )
    const worldCenter = planeGeom.center.clone().applyMatrix4(model.matrixWorld)

    // Ensure worldNormal always points towards the camera
    worldNormal
      .copy(planeGeom.localNormal)
      .applyQuaternion(model.quaternion)
      .normalize()
    const toCam = camera.position.clone().sub(worldCenter)
    if (worldNormal.dot(toCam) < 0) {
      worldNormal.negate()
    }
    centerWorldPos.copy(worldCenter)

    // Screen-space handle scaling factor (maintains ~14-16px readable size)
    const sfCenter = getScreenScale(worldCenter)

    // Position corners
    cornerObjs.forEach((obj, i) => {
      obj.worldPos.copy(worldCorners[i])
      obj.group.position.copy(worldCorners[i])
      const sf = getScreenScale(worldCorners[i])
      obj.group.scale.setScalar(sf * 15)
    })

    // Position edge midpoints
    edgeObjs.forEach((obj, i) => {
      obj.worldPos.copy(worldEdgeMids[i])
      obj.group.position.copy(worldEdgeMids[i])
      const sf = getScreenScale(worldEdgeMids[i])
      obj.group.scale.setScalar(sf * 13)
    })

    // Position center handle
    centerGroup.position.copy(worldCenter)
    centerGroup.scale.setScalar(sfCenter * 16)
    centerGroup.lookAt(worldCenter.clone().add(worldNormal))
    centerGroup.visible = !isUniversalMode

    // Update frame perimeter line
    const pa = lineGeo.attributes.position
    ;[...worldCorners, worldCorners[0]].forEach((p, i) =>
      pa.setXYZ(i, p.x, p.y, p.z)
    )
    pa.needsUpdate = true

    // Update translucent plane fill
    worldCorners.forEach((p, i) => fillPosAttr.setXYZ(i, p.x, p.y, p.z))
    fillPosAttr.needsUpdate = true
    planeFillGeo.computeVertexNormals()
  }

  // ─── Hit Detection ──────────────────────────────────────────────────────────
  const getPointer = (e) => {
    const r = domElement.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return { cx: 0, cy: 0 }
    return { cx: e.clientX - r.left, cy: e.clientY - r.top }
  }

  const findHit = (cx, cy) => {
    // 1. Corners (priority 1)
    let bestCorner = -1
    let bestCornerDist = 22
    cornerObjs.forEach((c, i) => {
      const s = toScreen(c.worldPos)
      if (!s.visible) return
      const d = Math.hypot(s.x - cx, s.y - cy)
      if (d < bestCornerDist) {
        bestCornerDist = d
        bestCorner = i
      }
    })
    if (bestCorner !== -1) {
      return { type: 'corner', index: bestCorner }
    }

    // 2. Center handle (priority 2, when not in universal mode)
    if (!isUniversalMode) {
      const sc = toScreen(centerWorldPos)
      if (sc.visible && Math.hypot(sc.x - cx, sc.y - cy) < 22) {
        return { type: 'move', index: -1 }
      }
    }

    // 3. Edge midpoint handles (priority 3)
    let bestEdge = -1
    let bestEdgeDist = 18
    edgeObjs.forEach((e, i) => {
      const s = toScreen(e.worldPos)
      if (!s.visible) return
      const d = Math.hypot(s.x - cx, s.y - cy)
      if (d < bestEdgeDist) {
        bestEdgeDist = d
        bestEdge = i
      }
    })
    if (bestEdge !== -1) {
      return { type: 'edge', index: bestEdge }
    }

    // 4. Edge line segments (priority 4)
    const sCorners = cornerObjs.map((c) => toScreen(c.worldPos))
    const edgeSegments = [
      [sCorners[0], sCorners[1]], // 0: Bottom
      [sCorners[1], sCorners[2]], // 1: Right
      [sCorners[2], sCorners[3]], // 2: Top
      [sCorners[3], sCorners[0]], // 3: Left
    ]

    let bestSegDist = 10
    edgeSegments.forEach(([p1, p2], i) => {
      if (!p1.visible || !p2.visible) return
      const d = distToSegment(cx, cy, p1.x, p1.y, p2.x, p2.y)
      if (d < bestSegDist) {
        bestSegDist = d
        bestEdge = i
      }
    })
    if (bestEdge !== -1) {
      return { type: 'edge', index: bestEdge }
    }

    // 5. Inside the rectangular frame (priority 5: move drag like Unity)
    if (sCorners.every((c) => c.visible) && pointInPolygon(cx, cy, sCorners)) {
      return { type: 'move', index: -1 }
    }

    return null
  }

  const getCursorForHit = (hit) => {
    if (!hit) return ''
    if (hit.type === 'move') return 'move'
    const sCorners = cornerObjs.map((c) => toScreen(c.worldPos))
    if (hit.type === 'corner') {
      return getCornerCursor(hit.index, sCorners)
    }
    if (hit.type === 'edge') {
      return getEdgeCursor(hit.index, sCorners)
    }
    return 'crosshair'
  }

  const clearHighlights = () => {
    cornerObjs.forEach((c) => {
      c.outer.material = outerMat
    })
    edgeObjs.forEach((eg) => {
      eg.outer.material = outerMat
    })
    ring.material = outerMat
    lineMat.color.setHex(0x00d4ff)
    planeFillMat.opacity = 0.04
  }

  // ─── Pointer Down ───────────────────────────────────────────────────────────
  const onDown = (e) => {
    if (!gizmoGroup.visible || e.button !== 0) return
    const model = getModelGroup?.()
    if (!model) return

    const { cx, cy } = getPointer(e)
    const hit = findHit(cx, cy)
    if (!hit) return

    e.preventDefault()
    e.stopPropagation()

    isDragging = true
    dragMode = hit.type
    activeHandle = hit.index
    activePointerId = e.pointerId

    try {
      domElement.setPointerCapture(e.pointerId)
    } catch (err) {}

    if (orbitControls) orbitControls.enabled = false

    // Lock plane orientation for the duration of the drag
    lockedPlaneGeom = {
      ...currentPlaneGeom,
      corners: currentPlaneGeom.corners.map((c) => c.clone()),
      edgeMids: currentPlaneGeom.edgeMids.map((m) => m.clone()),
      center: currentPlaneGeom.center.clone(),
    }
    const lp = lockedPlaneGeom

    // Drag plane perpendicular to worldNormal passing through centerWorldPos
    dragPlane.setFromNormalAndCoplanarPoint(worldNormal, centerWorldPos)

    const r = domElement.getBoundingClientRect()
    mouse.set((cx / r.width) * 2 - 1, -(cy / r.height) * 2 + 1)
    raycaster.setFromCamera(mouse, camera)
    if (!raycaster.ray.intersectPlane(dragPlane, hitStart)) {
      hitStart.copy(centerWorldPos)
    }

    startScale.copy(model.scale)
    startPos.copy(model.position)
    invQ.copy(model.quaternion).invert()

    if (hit.type === 'corner') {
      // 0: Bottom-Left  (hMin, vMin) -> Anchor: Corner 2 (Top-Right: hMax, vMax)
      // 1: Bottom-Right (hMax, vMin) -> Anchor: Corner 3 (Top-Left: hMin, vMax)
      // 2: Top-Right    (hMax, vMax) -> Anchor: Corner 0 (Bottom-Left: hMin, vMin)
      // 3: Top-Left     (hMin, vMax) -> Anchor: Corner 1 (Bottom-Right: hMax, vMin)
      const oppIndex = (hit.index + 2) % 4
      anchorLocal.copy(lp.corners[oppIndex])
      anchorWorld.copy(anchorLocal).applyMatrix4(model.matrixWorld)

      const draggedLocal = lp.corners[hit.index]
      dragDeltaLocal.copy(draggedLocal).sub(anchorLocal)
      startExtentH = startScale[lp.hKey] * dragDeltaLocal[lp.hKey]
      startExtentV = startScale[lp.vKey] * dragDeltaLocal[lp.vKey]

      if (Math.abs(startExtentH) < 1e-6) startExtentH = 1e-4
      if (Math.abs(startExtentV) < 1e-6) startExtentV = 1e-4

      // Visual feedback
      cornerObjs[hit.index].outer.material = dragMat
      lineMat.color.setHex(0x00ffff)
      planeFillMat.opacity = 0.12

    } else if (hit.type === 'edge') {
      // 0: Bottom Edge (vMin) -> Anchor: Edge 2 (Top midpoint vMax)
      // 1: Right Edge  (hMax) -> Anchor: Edge 3 (Left midpoint hMin)
      // 2: Top Edge    (vMax) -> Anchor: Edge 0 (Bottom midpoint vMin)
      // 3: Left Edge   (hMin) -> Anchor: Edge 1 (Right midpoint hMax)
      const oppIndex = (hit.index + 2) % 4
      anchorLocal.copy(lp.edgeMids[oppIndex])
      anchorWorld.copy(anchorLocal).applyMatrix4(model.matrixWorld)

      const draggedLocal = lp.edgeMids[hit.index]
      dragDeltaLocal.copy(draggedLocal).sub(anchorLocal)
      startExtentH = startScale[lp.hKey] * dragDeltaLocal[lp.hKey]
      startExtentV = startScale[lp.vKey] * dragDeltaLocal[lp.vKey]

      if (Math.abs(startExtentH) < 1e-6) startExtentH = 1e-4
      if (Math.abs(startExtentV) < 1e-6) startExtentV = 1e-4

      // Visual feedback
      edgeObjs[hit.index].outer.material = dragMat
      lineMat.color.setHex(0x00ffff)
      planeFillMat.opacity = 0.12

    } else {
      // Center move drag
      ring.material = dragMat
      lineMat.color.setHex(0x00ffff)
      planeFillMat.opacity = 0.14
    }

    domElement.style.cursor = getCursorForHit(hit)
  }

  // ─── Pointer Move ───────────────────────────────────────────────────────────
  const onMove = (e) => {
    if (!gizmoGroup.visible) return
    const model = getModelGroup?.()
    if (!model) return

    if (isDragging) {
      const r = domElement.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      mouse.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      )
      raycaster.setFromCamera(mouse, camera)
      if (!raycaster.ray.intersectPlane(dragPlane, hitCurrent)) return

      if (dragMode === 'move') {
        // Translate model on the active 2D plane (delta parallel to plane)
        const deltaW = hitCurrent.clone().sub(hitStart)
        model.position.copy(startPos).add(deltaW)
        onTransformChange(false)
        update()

      } else if (dragMode === 'corner') {
        const lp = lockedPlaneGeom
        const deltaW = hitCurrent.clone().sub(hitStart)
        const deltaL = deltaW.applyQuaternion(invQ)

        // Resizing relative to the pinned opposite anchor corner
        const ratioH = (startExtentH + deltaL[lp.hKey]) / startExtentH
        const ratioV = (startExtentV + deltaL[lp.vKey]) / startExtentV
        if (!Number.isFinite(ratioH) || !Number.isFinite(ratioV)) return

        const clampedRatioH = Math.min(Math.max(ratioH, 0.01), 100)
        const clampedRatioV = Math.min(Math.max(ratioV, 0.01), 100)

        const newScale = startScale.clone()
        if (e.shiftKey) {
          // Proportional resizing when Shift is held
          const uniform = (clampedRatioH + clampedRatioV) / 2
          newScale[lp.hKey] = Math.max(startScale[lp.hKey] * uniform, 1e-4)
          newScale[lp.vKey] = Math.max(startScale[lp.vKey] * uniform, 1e-4)
        } else {
          // Independent width & height resizing
          newScale[lp.hKey] = Math.max(startScale[lp.hKey] * clampedRatioH, 1e-4)
          newScale[lp.vKey] = Math.max(startScale[lp.vKey] * clampedRatioV, 1e-4)
        }
        // Preserve depth axis
        newScale[lp.dKey] = startScale[lp.dKey]
        model.scale.copy(newScale)

        // Keep anchor corner fixed in world space:
        // anchorWorld = model.position + model.quaternion * (anchorLocal * model.scale)
        const newOffset = new THREE.Vector3(
          anchorLocal.x * model.scale.x,
          anchorLocal.y * model.scale.y,
          anchorLocal.z * model.scale.z
        ).applyQuaternion(model.quaternion)

        model.position.copy(anchorWorld).sub(newOffset)
        onTransformChange(false)
        update()

      } else if (dragMode === 'edge') {
        const lp = lockedPlaneGeom
        const deltaW = hitCurrent.clone().sub(hitStart)
        const deltaL = deltaW.applyQuaternion(invQ)

        const newScale = startScale.clone()
        if (activeHandle === 0 || activeHandle === 2) {
          // Bottom or Top edge -> scales vertical axis ONLY
          const ratioV = (startExtentV + deltaL[lp.vKey]) / startExtentV
          if (!Number.isFinite(ratioV)) return
          const clampedRatioV = Math.min(Math.max(ratioV, 0.01), 100)
          newScale[lp.vKey] = Math.max(startScale[lp.vKey] * clampedRatioV, 1e-4)
        } else {
          // Right or Left edge -> scales horizontal axis ONLY
          const ratioH = (startExtentH + deltaL[lp.hKey]) / startExtentH
          if (!Number.isFinite(ratioH)) return
          const clampedRatioH = Math.min(Math.max(ratioH, 0.01), 100)
          newScale[lp.hKey] = Math.max(startScale[lp.hKey] * clampedRatioH, 1e-4)
        }
        model.scale.copy(newScale)

        // Keep opposite edge fixed in world space
        const newOffset = new THREE.Vector3(
          anchorLocal.x * model.scale.x,
          anchorLocal.y * model.scale.y,
          anchorLocal.z * model.scale.z
        ).applyQuaternion(model.quaternion)

        model.position.copy(anchorWorld).sub(newOffset)
        onTransformChange(false)
        update()
      }
    } else {
      // Hover feedback: update cursor and highlight active handle
      const { cx, cy } = getPointer(e)
      const hit = findHit(cx, cy)
      domElement.style.cursor = getCursorForHit(hit)

      cornerObjs.forEach((c, i) => {
        c.outer.material =
          hit?.type === 'corner' && hit.index === i ? hoverMat : outerMat
      })
      edgeObjs.forEach((eg, i) => {
        eg.outer.material =
          hit?.type === 'edge' && hit.index === i ? hoverMat : outerMat
      })
      ring.material =
        hit?.type === 'move' && !isUniversalMode ? hoverMat : outerMat
      planeFillMat.opacity = hit?.type === 'move' ? 0.09 : 0.04
    }
  }

  // ─── Pointer Up ─────────────────────────────────────────────────────────────
  const onUp = () => {
    if (!isDragging) return
    isDragging = false
    dragMode = null
    activeHandle = -1
    lockedPlaneGeom = null

    try {
      if (
        activePointerId !== null &&
        domElement.hasPointerCapture(activePointerId)
      ) {
        domElement.releasePointerCapture(activePointerId)
      }
    } catch (err) {}
    activePointerId = null

    if (orbitControls) orbitControls.enabled = true
    domElement.style.cursor = ''
    clearHighlights()
    onTransformChange(true)
  }

  const onPointerLeave = () => {
    if (!isDragging) {
      domElement.style.cursor = ''
      clearHighlights()
    }
  }

  const cancelDrag = () => {
    if (isDragging) {
      isDragging = false
      dragMode = null
      activeHandle = -1
      lockedPlaneGeom = null
      try {
        if (
          activePointerId !== null &&
          domElement.hasPointerCapture(activePointerId)
        ) {
          domElement.releasePointerCapture(activePointerId)
        }
      } catch (err) {}
      activePointerId = null
      if (orbitControls) orbitControls.enabled = true
      domElement.style.cursor = ''
      clearHighlights()
    }
  }

  domElement.addEventListener('pointerdown', onDown, { capture: true })
  domElement.addEventListener('pointerleave', onPointerLeave)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  window.addEventListener('blur', cancelDrag)

  return {
    group: gizmoGroup,
    isDragging: () => isDragging,
    invalidateBounds,
    setVisible: (v) => {
      gizmoGroup.visible = v
      if (v) {
        invalidateBounds()
        update()
      } else {
        cancelDrag()
      }
    },
    setUniversal: (v) => {
      isUniversalMode = !!v
      centerGroup.visible = !v
    },
    setOrientation: (o) => {
      preferredOrientation = o === 'vertical' ? 'vertical' : 'horizontal'
      activePlaneName = preferredOrientation === 'vertical' ? 'XY' : 'XZ'
      update()
    },
    getOrientation: () => preferredOrientation,
    update,
    dispose: () => {
      cancelDrag()
      domElement.removeEventListener('pointerdown', onDown, { capture: true })
      domElement.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', cancelDrag)
      scene.remove(gizmoGroup)
      lineGeo.dispose()
      lineMat.dispose()
      planeFillGeo.dispose()
      planeFillMat.dispose()
      cornerOuterGeo.dispose()
      cornerInnerGeo.dispose()
      edgeOuterGeo.dispose()
      edgeInnerGeo.dispose()
      outerMat.dispose()
      innerMat.dispose()
      hoverMat.dispose()
      dragMat.dispose()
      ringGeo.dispose()
    },
  }
}
