import * as THREE from 'three'

/**
 * Unity-Style 3D Rect Tool Gizmo.
 *
 * Implements full 3D Rect Transform editing matching Unity:
 * 1. Camera-Facing 2D Projection Plane:
 *    - Automatically aligns to the dominant camera-facing plane (XY, ZY, or XZ).
 *    - Sits on the front-facing boundary of the object's 3D bounding box.
 * 2. 4 Corner Handles:
 *    - Scale BOTH axes of the active plane independently (e.g., Width & Height).
 *    - The opposite corner acts as the fixed anchor in world space.
 * 3. 4 Edge Handles (Bottom, Right, Top, Left):
 *    - Scale ONLY that specific edge's axis (e.g. pulling Top edge scales Height up while Bottom stays pinned).
 *    - The opposite edge acts as the fixed anchor in world space.
 * 4. Center Handle:
 *    - Translates the object on the active 2D plane.
 * 5. Screen-space pixel hit testing with contextual resize cursors (ns-resize, ew-resize, nwse-resize, nesw-resize, move).
 */
export function createRectGizmo({
  scene,
  camera,
  domElement,
  getModelGroup,
  onTransformChange,
  orbitControls,
}) {
  // ─── Scene group ────────────────────────────────────────────────────────────
  const gizmoGroup = new THREE.Group()
  gizmoGroup.name = 'RectGizmoGroup'
  gizmoGroup.visible = false
  scene.add(gizmoGroup)

  // ─── Frame outline ──────────────────────────────────────────────────────────
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

  // ─── Shared Geometries & Materials ──────────────────────────────────────────
  const cornerOuterGeo = new THREE.SphereGeometry(0.045, 16, 16)
  const cornerInnerGeo = new THREE.SphereGeometry(0.022, 16, 16)
  const edgeOuterGeo   = new THREE.BoxGeometry(0.045, 0.045, 0.045)
  const edgeInnerGeo   = new THREE.BoxGeometry(0.022, 0.022, 0.022)

  const outerMat = new THREE.MeshBasicMaterial({ color: 0x1e88e5, depthTest: false, depthWrite: false })
  const innerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false })
  const hoverMat = new THREE.MeshBasicMaterial({ color: 0xffd600, depthTest: false, depthWrite: false })

  // ─── 4 Corner handles ────────────────────────────────────────────────────────
  // 0: Bottom-Left, 1: Bottom-Right, 2: Top-Right, 3: Top-Left
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
    cornerObjs.push({ group: g, outer, worldPos: new THREE.Vector3() })
  }

  // ─── 4 Edge midpoint handles ─────────────────────────────────────────────────
  // 0: Bottom, 1: Right, 2: Top, 3: Left
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
    edgeObjs.push({ group: g, outer, worldPos: new THREE.Vector3() })
  }

  // ─── Center handle ───────────────────────────────────────────────────────────
  const centerGroup = new THREE.Group()
  centerGroup.name = 'RectCenter'
  const ringGeo = new THREE.TorusGeometry(0.05, 0.012, 16, 32)
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x1e88e5, depthTest: false, depthWrite: false })
  const ring = new THREE.Mesh(ringGeo, ringMat)
  ring.renderOrder = 9999
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 16), innerMat)
  dot.renderOrder = 10000
  centerGroup.add(ring, dot)
  gizmoGroup.add(centerGroup)
  const centerWorldPos = new THREE.Vector3()
  const worldNormal    = new THREE.Vector3(0, 0, 1)

  // ─── State ───────────────────────────────────────────────────────────────────
  let isUniversalMode       = false
  let isDragging            = false
  let dragMode              = null  // 'corner' | 'edge' | 'move'
  let activeHandle          = -1
  let preferredOrientation  = 'horizontal' // 'horizontal' (XZ on target surface) | 'vertical' (XY/ZY)
  let activePlaneName       = 'XZ'
  let currentPlaneGeom      = null
  let lockedPlaneGeom       = null

  const raycaster       = new THREE.Raycaster()
  const mouse           = new THREE.Vector2()
  const dragPlane       = new THREE.Plane()
  const hitStart        = new THREE.Vector3()
  const hitCurrent      = new THREE.Vector3()

  const startScale      = new THREE.Vector3()
  const startPos        = new THREE.Vector3()
  const anchorWorld     = new THREE.Vector3()
  const anchorLocal     = new THREE.Vector3()
  const invQ            = new THREE.Quaternion()
  let   startExtentH    = 1
  let   startExtentV    = 1

  // Cached model local bounds
  let cachedModel = null
  let cachedBox   = new THREE.Box3()

  const getLocalBounds = (model) => {
    if (cachedModel === model && !cachedBox.isEmpty()) {
      return cachedBox
    }
    const box = new THREE.Box3()
    model.updateMatrixWorld(true)
    const inv = model.matrixWorld.clone().invert()
    model.traverse((c) => {
      if (c === model || !c.isMesh || !c.geometry) return
      if (!c.geometry.boundingBox) c.geometry.computeBoundingBox()
      if (!c.geometry.boundingBox) return
      const m = new THREE.Matrix4().copy(inv).multiply(c.matrixWorld)
      box.union(c.geometry.boundingBox.clone().applyMatrix4(m))
    })
    if (box.isEmpty()) {
      box.set(
        new THREE.Vector3(-0.25, 0, -0.25),
        new THREE.Vector3( 0.25, 0.5, 0.25)
      )
    }
    cachedModel = model
    cachedBox.copy(box)
    return cachedBox
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
    } else { // 'XZ' (Horizontal plane on image target / surface)
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
    const hSpan   = Math.max((hMax - hMin) / 2, 1e-4)
    const vSpan   = Math.max((vMax - vMin) / 2, 1e-4)

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

    const localNormal = new THREE.Vector3()
    localNormal[dKey] = depth === box.max[dKey] ? 1 : -1

    return {
      planeName,
      hKey, vKey, dKey,
      hMin, hMax, vMin, vMax,
      hCenter, vCenter, hSpan, vSpan,
      depth,
      corners,
      edgeMids,
      center,
      localNormal,
    }
  }

  // ─── Screen projection helper ───────────────────────────────────────────────
  const toScreen = (worldVec3) => {
    const v = worldVec3.clone().project(camera)
    const r = domElement.getBoundingClientRect()
    return {
      x: ( v.x * 0.5 + 0.5) * r.width,
      y: (-v.y * 0.5 + 0.5) * r.height,
    }
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

  // ─── Update Visuals ─────────────────────────────────────────────────────────
  const update = () => {
    const model = getModelGroup?.()
    if (!model || !gizmoGroup.visible) return

    model.updateMatrixWorld(true)
    const box = getLocalBounds(model)

    // Compute camera position in model local space to determine dominant facing plane
    const invModelQ = model.quaternion.clone().invert()
    const camLocal  = camera.position.clone().sub(model.position).applyQuaternion(invModelQ)

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
    const worldCorners  = planeGeom.corners.map(c => c.clone().applyMatrix4(model.matrixWorld))
    const worldEdgeMids = planeGeom.edgeMids.map(e => e.clone().applyMatrix4(model.matrixWorld))
    const worldCenter   = planeGeom.center.clone().applyMatrix4(model.matrixWorld)

    worldNormal.copy(planeGeom.localNormal).applyQuaternion(model.quaternion).normalize()
    centerWorldPos.copy(worldCenter)

    // Handle scale based on distance to camera
    const dist = camera.position.distanceTo(worldCenter)
    const sf   = Math.max(dist * 0.35, 0.2)

    // Position corners
    cornerObjs.forEach((obj, i) => {
      obj.worldPos.copy(worldCorners[i])
      obj.group.position.copy(worldCorners[i])
      obj.group.scale.setScalar(sf)
    })

    // Position edge midpoints
    edgeObjs.forEach((obj, i) => {
      obj.worldPos.copy(worldEdgeMids[i])
      obj.group.position.copy(worldEdgeMids[i])
      obj.group.scale.setScalar(sf * 0.8)
    })

    // Position center handle
    centerGroup.position.copy(worldCenter)
    centerGroup.scale.setScalar(sf)
    centerGroup.lookAt(worldCenter.clone().add(worldNormal))
    centerGroup.visible = !isUniversalMode

    // Update frame perimeter line
    const pa = lineGeo.attributes.position
    ;[...worldCorners, worldCorners[0]].forEach((p, i) => pa.setXYZ(i, p.x, p.y, p.z))
    pa.needsUpdate = true
  }

  // ─── Hit Detection ──────────────────────────────────────────────────────────
  const getPointer = (e) => {
    const r = domElement.getBoundingClientRect()
    return { cx: e.clientX - r.left, cy: e.clientY - r.top }
  }

  const findHit = (cx, cy) => {
    // 1. Corners (priority 1)
    let bestCorner = -1
    let bestDist = 24
    cornerObjs.forEach((c, i) => {
      const s = toScreen(c.worldPos)
      const d = Math.hypot(s.x - cx, s.y - cy)
      if (d < bestDist) {
        bestDist = d
        bestCorner = i
      }
    })
    if (bestCorner !== -1) {
      return { type: 'corner', index: bestCorner }
    }

    // 2. Center handle (priority 2, when not in universal mode)
    if (!isUniversalMode) {
      const sc = toScreen(centerWorldPos)
      if (Math.hypot(sc.x - cx, sc.y - cy) < 22) {
        return { type: 'move', index: -1 }
      }
    }

    // 3. Edge midpoint handles (priority 3)
    let bestEdge = -1
    let bestEdgeDist = 20
    edgeObjs.forEach((e, i) => {
      const s = toScreen(e.worldPos)
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
    const sCorners = cornerObjs.map(c => toScreen(c.worldPos))
    const edgeSegments = [
      [sCorners[0], sCorners[1]], // 0: Bottom
      [sCorners[1], sCorners[2]], // 1: Right
      [sCorners[2], sCorners[3]], // 2: Top
      [sCorners[3], sCorners[0]], // 3: Left
    ]

    let bestSegDist = 12
    edgeSegments.forEach(([p1, p2], i) => {
      const d = distToSegment(cx, cy, p1.x, p1.y, p2.x, p2.y)
      if (d < bestSegDist) {
        bestSegDist = d
        bestEdge = i
      }
    })
    if (bestEdge !== -1) {
      return { type: 'edge', index: bestEdge }
    }

    return null
  }

  const getCursorForHit = (hit) => {
    if (!hit) return ''
    if (hit.type === 'move') return 'move'
    if (hit.type === 'corner') {
      return (hit.index === 0 || hit.index === 2) ? 'nwse-resize' : 'nesw-resize'
    }
    if (hit.type === 'edge') {
      // 0: Bottom, 2: Top -> ns-resize (vertical)
      // 1: Right, 3: Left -> ew-resize (horizontal)
      return (hit.index === 0 || hit.index === 2) ? 'ns-resize' : 'ew-resize'
    }
    return 'crosshair'
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
    if (orbitControls) orbitControls.enabled = false

    // Lock plane orientation for the duration of drag
    lockedPlaneGeom = { ...currentPlaneGeom }
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
      dragMode = 'corner'
      activeHandle = hit.index

      let hSign, vSign
      // 0: Bottom-Left -> Anchor: Top-Right (corner 2)
      // 1: Bottom-Right -> Anchor: Top-Left (corner 3)
      // 2: Top-Right -> Anchor: Bottom-Left (corner 0)
      // 3: Top-Left -> Anchor: Bottom-Right (corner 1)
      if (hit.index === 0) {
        hSign = -1; vSign = -1
        anchorLocal.copy(lp.corners[2])
      } else if (hit.index === 1) {
        hSign = 1; vSign = -1
        anchorLocal.copy(lp.corners[3])
      } else if (hit.index === 2) {
        hSign = 1; vSign = 1
        anchorLocal.copy(lp.corners[0])
      } else {
        hSign = -1; vSign = 1
        anchorLocal.copy(lp.corners[1])
      }

      anchorWorld.copy(anchorLocal).applyMatrix4(model.matrixWorld)

      const baseSpanH = startScale[lp.hKey] * 2 * hSign * lp.hSpan
      const baseSpanV = startScale[lp.vKey] * 2 * vSign * lp.vSpan

      const initDelta = hitStart.clone().sub(anchorWorld).applyQuaternion(invQ)
      startExtentH = (Math.abs(initDelta[lp.hKey]) > 0.002 && Math.sign(initDelta[lp.hKey]) === Math.sign(baseSpanH))
        ? initDelta[lp.hKey]
        : baseSpanH
      startExtentV = (Math.abs(initDelta[lp.vKey]) > 0.002 && Math.sign(initDelta[lp.vKey]) === Math.sign(baseSpanV))
        ? initDelta[lp.vKey]
        : baseSpanV

      if (Math.abs(startExtentH) < 1e-4) startExtentH = hSign * 1e-4
      if (Math.abs(startExtentV) < 1e-4) startExtentV = vSign * 1e-4

    } else if (hit.type === 'edge') {
      dragMode = 'edge'
      activeHandle = hit.index

      // 0: Bottom Edge (vSign = -1) -> Anchor: Top midpoint lp.edgeMids[2]
      // 1: Right Edge  (hSign = +1) -> Anchor: Left midpoint lp.edgeMids[3]
      // 2: Top Edge    (vSign = +1) -> Anchor: Bottom midpoint lp.edgeMids[0]
      // 3: Left Edge   (hSign = -1) -> Anchor: Right midpoint lp.edgeMids[1]
      if (hit.index === 0) {
        anchorLocal.copy(lp.edgeMids[2])
        const vSign = -1
        anchorWorld.copy(anchorLocal).applyMatrix4(model.matrixWorld)
        const baseSpanV = startScale[lp.vKey] * 2 * vSign * lp.vSpan
        const initDelta = hitStart.clone().sub(anchorWorld).applyQuaternion(invQ)
        startExtentV = (Math.abs(initDelta[lp.vKey]) > 0.002 && Math.sign(initDelta[lp.vKey]) === Math.sign(baseSpanV))
          ? initDelta[lp.vKey]
          : baseSpanV
        if (Math.abs(startExtentV) < 1e-4) startExtentV = vSign * 1e-4

      } else if (hit.index === 1) {
        anchorLocal.copy(lp.edgeMids[3])
        const hSign = 1
        anchorWorld.copy(anchorLocal).applyMatrix4(model.matrixWorld)
        const baseSpanH = startScale[lp.hKey] * 2 * hSign * lp.hSpan
        const initDelta = hitStart.clone().sub(anchorWorld).applyQuaternion(invQ)
        startExtentH = (Math.abs(initDelta[lp.hKey]) > 0.002 && Math.sign(initDelta[lp.hKey]) === Math.sign(baseSpanH))
          ? initDelta[lp.hKey]
          : baseSpanH
        if (Math.abs(startExtentH) < 1e-4) startExtentH = hSign * 1e-4

      } else if (hit.index === 2) {
        anchorLocal.copy(lp.edgeMids[0])
        const vSign = 1
        anchorWorld.copy(anchorLocal).applyMatrix4(model.matrixWorld)
        const baseSpanV = startScale[lp.vKey] * 2 * vSign * lp.vSpan
        const initDelta = hitStart.clone().sub(anchorWorld).applyQuaternion(invQ)
        startExtentV = (Math.abs(initDelta[lp.vKey]) > 0.002 && Math.sign(initDelta[lp.vKey]) === Math.sign(baseSpanV))
          ? initDelta[lp.vKey]
          : baseSpanV
        if (Math.abs(startExtentV) < 1e-4) startExtentV = vSign * 1e-4

      } else { // 3: Left Edge
        anchorLocal.copy(lp.edgeMids[1])
        const hSign = -1
        anchorWorld.copy(anchorLocal).applyMatrix4(model.matrixWorld)
        const baseSpanH = startScale[lp.hKey] * 2 * hSign * lp.hSpan
        const initDelta = hitStart.clone().sub(anchorWorld).applyQuaternion(invQ)
        startExtentH = (Math.abs(initDelta[lp.hKey]) > 0.002 && Math.sign(initDelta[lp.hKey]) === Math.sign(baseSpanH))
          ? initDelta[lp.hKey]
          : baseSpanH
        if (Math.abs(startExtentH) < 1e-4) startExtentH = hSign * 1e-4
      }

    } else {
      dragMode = 'move'
      activeHandle = -1
    }
  }

  // ─── Pointer Move ───────────────────────────────────────────────────────────
  const onMove = (e) => {
    if (!gizmoGroup.visible) return
    const model = getModelGroup?.()
    if (!model) return

    if (isDragging) {
      const r = domElement.getBoundingClientRect()
      mouse.set(
        ((e.clientX - r.left) / r.width ) * 2 - 1,
       -((e.clientY - r.top ) / r.height) * 2 + 1
      )
      raycaster.setFromCamera(mouse, camera)
      if (!raycaster.ray.intersectPlane(dragPlane, hitCurrent)) return

      if (dragMode === 'move') {
        // Translate model on the active 2D plane
        model.position.copy(startPos).add(hitCurrent).sub(hitStart)
        onTransformChange(false)
        update()

      } else if (dragMode === 'corner') {
        // Corner scale: uniform ratio on BOTH plane axes (keeps model proportions,
        // no stretching), opposite corner stays fixed
        const lp = lockedPlaneGeom
        const cursorDelta = hitCurrent.clone().sub(anchorWorld)
        const localDelta  = cursorDelta.applyQuaternion(invQ)

        const ratioH = localDelta[lp.hKey] / startExtentH
        const ratioV = localDelta[lp.vKey] / startExtentV
        if (!Number.isFinite(ratioH) || !Number.isFinite(ratioV)) return

        const clampedRatioH = Math.min(Math.max(ratioH, 0.02), 50)
        const clampedRatioV = Math.min(Math.max(ratioV, 0.02), 50)

        // Geometric mean -> one uniform factor for the whole model
        const uniform = Math.min(Math.max(Math.sqrt(clampedRatioH * clampedRatioV), 0.02), 50)

        model.scale.set(
          Math.max(Math.abs(startScale.x) * uniform, 1e-4),
          Math.max(Math.abs(startScale.y) * uniform, 1e-4),
          Math.max(Math.abs(startScale.z) * uniform, 1e-4)
        )

        // Keep anchor corner fixed in world space
        const newOffset = new THREE.Vector3(
          anchorLocal.x * model.scale.x,
          anchorLocal.y * model.scale.y,
          anchorLocal.z * model.scale.z
        ).applyQuaternion(model.quaternion)

        model.position.copy(anchorWorld).sub(newOffset)
        onTransformChange(false)
        update()

      } else if (dragMode === 'edge') {
        // Edge scale: scales the model UNIFORMLY from that edge (no stretch),
        // opposite edge stays fixed
        const lp = lockedPlaneGeom
        const cursorDelta = hitCurrent.clone().sub(anchorWorld)
        const localDelta  = cursorDelta.applyQuaternion(invQ)

        let ratio
        if (activeHandle === 0 || activeHandle === 2) {
          // Bottom or Top edge -> based on vertical axis
          ratio = localDelta[lp.vKey] / startExtentV
        } else {
          // Right or Left edge -> based on horizontal axis
          ratio = localDelta[lp.hKey] / startExtentH
        }
        if (!Number.isFinite(ratio)) return
        const uniform = Math.min(Math.max(ratio, 0.02), 50)

        model.scale.set(
          Math.max(Math.abs(startScale.x) * uniform, 1e-4),
          Math.max(Math.abs(startScale.y) * uniform, 1e-4),
          Math.max(Math.abs(startScale.z) * uniform, 1e-4)
        )

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
      // Hover feedback: update cursor and highlight handles
      const { cx, cy } = getPointer(e)
      const hit = findHit(cx, cy)
      domElement.style.cursor = getCursorForHit(hit)

      // Highlight active handle
      cornerObjs.forEach((c, i) => {
        c.outer.material = (hit?.type === 'corner' && hit.index === i) ? hoverMat : outerMat
      })
      edgeObjs.forEach((eg, i) => {
        eg.outer.material = (hit?.type === 'edge' && hit.index === i) ? hoverMat : outerMat
      })
    }
  }

  // ─── Pointer Up ─────────────────────────────────────────────────────────────
  const onUp = () => {
    if (!isDragging) return
    isDragging   = false
    dragMode     = null
    activeHandle = -1
    lockedPlaneGeom = null
    if (orbitControls) orbitControls.enabled = true
    domElement.style.cursor = ''
    // Clear hover highlight — it would otherwise stick until the next pointermove
    cornerObjs.forEach((c) => { c.outer.material = outerMat })
    edgeObjs.forEach((eg) => { eg.outer.material = outerMat })
    onTransformChange(true)
  }

  domElement.addEventListener('pointerdown', onDown, { capture: true })
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup',   onUp)

  return {
    group: gizmoGroup,
    setVisible: (v) => {
      gizmoGroup.visible = v
      if (v) {
        cachedBox.makeEmpty()
        update()
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
      domElement.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
      scene.remove(gizmoGroup)
      lineGeo.dispose(); lineMat.dispose()
      cornerOuterGeo.dispose(); cornerInnerGeo.dispose()
      edgeOuterGeo.dispose(); edgeInnerGeo.dispose()
      outerMat.dispose(); innerMat.dispose(); hoverMat.dispose()
      ringGeo.dispose(); ringMat.dispose()
    },
  }
}
