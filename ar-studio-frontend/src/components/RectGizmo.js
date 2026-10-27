import * as THREE from 'three'

/**
 * Unity-style Rect Tool: planar move + 8-handle resize on the selected object.
 *
 * Pointer listeners are registered on `document` in the capture phase so they
 * run before OrbitControls / TransformControls on the canvas. Hitting a handle
 * calls stopImmediatePropagation, which is required because canvas-target
 * listeners fire in registration order regardless of the capture flag.
 */
export function createRectGizmo({
  scene,
  camera,
  domElement,
  getModelGroup,
  onTransformChange,
  orbitControls,
}) {
  const gizmoGroup = new THREE.Group()

  gizmoGroup.name = 'RectGizmoGroup'
  gizmoGroup.visible = false
  scene.add(gizmoGroup)

  const outerMat = new THREE.MeshBasicMaterial({
    color: 0x1e88e5,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  })
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
  })
  const hoverMat = new THREE.MeshBasicMaterial({
    color: 0xffd600,
    depthTest: false,
    depthWrite: false,
  })
  const dragMat = new THREE.MeshBasicMaterial({
    color: 0x00e5ff,
    depthTest: false,
    depthWrite: false,
  })

  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3))
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x00d4ff,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  })
  const frameLine = new THREE.LineLoop(lineGeo, lineMat)
  frameLine.renderOrder = 9998
  frameLine.raycast = () => { }
  frameLine.frustumCulled = false
  gizmoGroup.add(frameLine)

  const planeFillGeo = new THREE.BufferGeometry()
  const fillPosAttr = new THREE.BufferAttribute(new Float32Array(4 * 3), 3)
  planeFillGeo.setAttribute('position', fillPosAttr)
  planeFillGeo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))
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
  planeFillMesh.raycast = () => { }
  planeFillMesh.frustumCulled = false
  gizmoGroup.add(planeFillMesh)

  const cornerOuterGeo = new THREE.BoxGeometry(0.55, 0.55, 0.08)
  const cornerInnerGeo = new THREE.BoxGeometry(0.28, 0.28, 0.1)
  const edgeOuterGeo = new THREE.BoxGeometry(0.28, 0.72, 0.08)
  const edgeInnerGeo = new THREE.BoxGeometry(0.12, 0.4, 0.1)

  const skipRaycast = (obj) => {
    obj.raycast = () => { }
    obj.frustumCulled = false
  }

  const cornerObjs = []
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group()
    g.name = `RectCorner_${i}`
    const outer = new THREE.Mesh(cornerOuterGeo, outerMat)
    outer.renderOrder = 10001
    const inner = new THREE.Mesh(cornerInnerGeo, innerMat)
    inner.renderOrder = 10002
    skipRaycast(outer)
    skipRaycast(inner)
    g.add(outer, inner)
    gizmoGroup.add(g)
    cornerObjs.push({ group: g, outer, inner, worldPos: new THREE.Vector3() })
  }

  const edgeObjs = []
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group()
    g.name = `RectEdge_${i}`
    const outer = new THREE.Mesh(edgeOuterGeo, outerMat)
    outer.renderOrder = 9999
    const inner = new THREE.Mesh(edgeInnerGeo, innerMat)
    inner.renderOrder = 10000
    skipRaycast(outer)
    skipRaycast(inner)
    g.add(outer, inner)
    gizmoGroup.add(g)
    edgeObjs.push({ group: g, outer, inner, worldPos: new THREE.Vector3() })
  }

  const centerGroup = new THREE.Group()
  centerGroup.name = 'RectCenter'
  const ringGeo = new THREE.TorusGeometry(0.42, 0.08, 12, 28)
  const ring = new THREE.Mesh(ringGeo, outerMat)
  ring.renderOrder = 10003
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), innerMat)
  dot.renderOrder = 10004
  skipRaycast(ring)
  skipRaycast(dot)
  centerGroup.add(ring, dot)
  gizmoGroup.add(centerGroup)

  const centerWorldPos = new THREE.Vector3()
  const worldNormal = new THREE.Vector3(0, 1, 0)
  const camDir = new THREE.Vector3()
  const worldQuat = new THREE.Quaternion()
  const invWorldQ = new THREE.Quaternion()
  const parentInv = new THREE.Matrix4()
  const tmpV = new THREE.Vector3()
  const tmpV2 = new THREE.Vector3()
  const lookTarget = new THREE.Vector3()

  let isUniversalMode = false
  let handleScale = 1
  let interaction = 'idle'
  let dragMode = null
  let activeHandle = -1
  let activePointerId = null
  let preferredOrientation = 'horizontal'
  let activePlaneName = 'XZ'
  let currentPlaneGeom = null
  let lockedPlaneGeom = null
  let orbitWasEnabled = true

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
  let startExtentH = 1
  let startExtentV = 1

  const localBox = new THREE.Box3()
  let boxModel = null

  const isDragging = () => interaction.startsWith('dragging')

  const getLocalBounds = (model) => {
    if (boxModel === model && !localBox.isEmpty() && isDragging()) {
      return localBox
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
      box.set(new THREE.Vector3(-0.25, 0, -0.25), new THREE.Vector3(0.25, 0.5, 0.25))
    }
    localBox.copy(box)
    boxModel = model
    return localBox
  }

  const pickPlaneName = (box, camLocal) => {
    const ex = Math.max(box.max.x - box.min.x, 1e-8)
    const ey = Math.max(box.max.y - box.min.y, 1e-8)
    const ez = Math.max(box.max.z - box.min.z, 1e-8)
    const maxE = Math.max(ex, ey, ez)
    const planar = 0.18

    if (ey <= maxE * planar && ey <= ex && ey <= ez) return 'XZ'
    if (ez <= maxE * planar && ez <= ex && ez <= ey) return 'XY'
    if (ex <= maxE * planar && ex <= ey && ex <= ez) return 'ZY'

    if (preferredOrientation === 'vertical') {
      return Math.abs(camLocal.x) > Math.abs(camLocal.z) ? 'ZY' : 'XY'
    }
    return 'XZ'
  }

  const computePlaneGeometry = (box, planeName, camLocal) => {
    let hKey
    let vKey
    let dKey
    if (planeName === 'XY') {
      hKey = 'x'
      vKey = 'y'
      dKey = 'z'
    } else if (planeName === 'ZY') {
      hKey = 'z'
      vKey = 'y'
      dKey = 'x'
    } else {
      hKey = 'x'
      vKey = 'z'
      dKey = 'y'
    }

    const towardCam = camLocal[dKey] >= 0 ? 1 : -1
    const depth =
      (box.min[dKey] + box.max[dKey]) / 2 +
      towardCam * Math.max((box.max[dKey] - box.min[dKey]) / 2, 1e-4)

    const hMin = box.min[hKey]
    const hMax = box.max[hKey]
    const vMin = box.min[vKey]
    const vMax = box.max[vKey]
    const hCenter = (hMin + hMax) / 2
    const vCenter = (vMin + vMax) / 2

    const makePt = (h, v) => {
      const p = new THREE.Vector3()
      p[hKey] = h
      p[vKey] = v
      p[dKey] = depth
      return p
    }

    const localNormal = new THREE.Vector3()
    localNormal[dKey] = towardCam

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
      depth,
      corners: [
        makePt(hMin, vMin),
        makePt(hMax, vMin),
        makePt(hMax, vMax),
        makePt(hMin, vMax),
      ],
      edgeMids: [
        makePt(hCenter, vMin),
        makePt(hMax, vCenter),
        makePt(hCenter, vMax),
        makePt(hMin, vCenter),
      ],
      center: makePt(hCenter, vCenter),
      localNormal,
    }
  }

  const canvasRect = () => domElement.getBoundingClientRect()

  const toScreen = (worldVec3) => {
    const eye = tmpV.copy(worldVec3).applyMatrix4(camera.matrixWorldInverse)
    if (eye.z >= -0.01) return { x: -99999, y: -99999, visible: false }
    const v = tmpV2.copy(worldVec3).project(camera)
    const r = canvasRect()
    return {
      x: (v.x * 0.5 + 0.5) * r.width,
      y: (-v.y * 0.5 + 0.5) * r.height,
      visible: Math.abs(v.x) <= 1.2 && Math.abs(v.y) <= 1.2,
    }
  }

  const getScreenScale = (worldPos) => {
    const dist = camera.position.distanceTo(worldPos)
    if (camera.isPerspectiveCamera) {
      const vFOV = THREE.MathUtils.degToRad(camera.fov)
      const h = Math.max(canvasRect().height, 1)
      return (2 * Math.tan(vFOV / 2) * dist) / h
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
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi) {
        inside = !inside
      }
    }
    return inside
  }

  const getAngleCursor = (dx, dy) => {
    let angle = Math.atan2(dy, dx) * (180 / Math.PI)
    if (angle < 0) angle += 180
    if (angle >= 22.5 && angle < 67.5) return 'nesw-resize'
    if (angle >= 67.5 && angle < 112.5) return 'ns-resize'
    if (angle >= 112.5 && angle < 157.5) return 'nwse-resize'
    return 'ew-resize'
  }

  const getCornerCursor = (cornerIndex, sCorners) => {
    const opp = sCorners[(cornerIndex + 2) % 4]
    const c = sCorners[cornerIndex]
    if (!c?.visible || !opp?.visible) return 'nwse-resize'
    return getAngleCursor(c.x - opp.x, c.y - opp.y)
  }

  const getEdgeCursor = (edgeIndex, sCorners) => {
    const c1 = sCorners[edgeIndex]
    const c2 = sCorners[(edgeIndex + 1) % 4]
    if (!c1?.visible || !c2?.visible) return 'ns-resize'
    return getAngleCursor(-(c2.y - c1.y), c2.x - c1.x)
  }

  const setWorldPositionOf = (object, world) => {
    if (!object.parent) {
      object.position.copy(world)
      return
    }
    object.parent.updateMatrixWorld(true)
    parentInv.copy(object.parent.matrixWorld).invert()
    object.position.copy(world).applyMatrix4(parentInv)
  }

  const applyWorldDeltaToStart = (object, worldDelta) => {
    if (!object.parent) {
      object.position.copy(startPos).add(worldDelta)
      return
    }
    object.parent.updateMatrixWorld(true)
    tmpV.copy(startPos).applyMatrix4(object.parent.matrixWorld).add(worldDelta)
    setWorldPositionOf(object, tmpV)
  }

  const keepLocalAnchor = (object, localAnchor, worldAnchorPt) => {
    object.updateMatrixWorld(true)
    tmpV.copy(localAnchor).applyMatrix4(object.matrixWorld)
    tmpV2.copy(worldAnchorPt).sub(tmpV)
    object.getWorldPosition(tmpV)
    setWorldPositionOf(object, tmpV.add(tmpV2))
  }

  const pointerOnCanvas = (e) => {
    const r = canvasRect()
    return (
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom
    )
  }

  const getPointer = (e) => {
    const r = canvasRect()
    if (r.width === 0 || r.height === 0) return { cx: 0, cy: 0, r }
    return { cx: e.clientX - r.left, cy: e.clientY - r.top, r }
  }

  const setNdc = (cx, cy, r) => {
    if (r.width === 0 || r.height === 0) return false
    mouse.set((cx / r.width) * 2 - 1, -(cy / r.height) * 2 + 1)
    raycaster.setFromCamera(mouse, camera)
    return true
  }

  const billboard = (obj, worldPos) => {
    lookTarget.copy(worldPos).add(camDir)
    obj.lookAt(lookTarget)
  }

  const update = () => {
    const model = getModelGroup?.()
    if (!model || !gizmoGroup.visible) return

    model.updateMatrixWorld(true)
    camera.updateMatrixWorld(true)
    const box = getLocalBounds(model)

    model.getWorldQuaternion(worldQuat)
    invWorldQ.copy(worldQuat).invert()
    const camLocal = camera.position
      .clone()
      .sub(tmpV.setFromMatrixPosition(model.matrixWorld))
      .applyQuaternion(invWorldQ)

    if (!isDragging()) {
      activePlaneName = pickPlaneName(box, camLocal)
    }

    const planeGeom = computePlaneGeometry(box, activePlaneName, camLocal)
    currentPlaneGeom = planeGeom

    const worldCorners = planeGeom.corners.map((c) => c.clone().applyMatrix4(model.matrixWorld))
    const worldEdgeMids = planeGeom.edgeMids.map((e) => e.clone().applyMatrix4(model.matrixWorld))
    const worldCenter = planeGeom.center.clone().applyMatrix4(model.matrixWorld)

    worldNormal.copy(planeGeom.localNormal).applyQuaternion(worldQuat).normalize()
    camDir.copy(camera.position).sub(worldCenter)
    if (worldNormal.dot(camDir) < 0) worldNormal.negate()
    camDir.copy(worldNormal)

    const lift = Math.max(getScreenScale(worldCenter) * 3, 0.004)
    worldCorners.forEach((p) => p.addScaledVector(worldNormal, lift))
    worldEdgeMids.forEach((p) => p.addScaledVector(worldNormal, lift))
    worldCenter.addScaledVector(worldNormal, lift)
    centerWorldPos.copy(worldCenter)

    const px = 14 * handleScale
    cornerObjs.forEach((obj, i) => {
      obj.worldPos.copy(worldCorners[i])
      obj.group.position.copy(worldCorners[i])
      obj.group.scale.setScalar(getScreenScale(worldCorners[i]) * px)
      billboard(obj.group, worldCorners[i])
    })

    edgeObjs.forEach((obj, i) => {
      obj.worldPos.copy(worldEdgeMids[i])
      obj.group.position.copy(worldEdgeMids[i])
      obj.group.scale.setScalar(getScreenScale(worldEdgeMids[i]) * (px * 0.9))
      const a = worldCorners[i]
      const b = worldCorners[(i + 1) % 4]
      obj.group.up.copy(b).sub(a).normalize()
      if (obj.group.up.lengthSq() < 1e-8) obj.group.up.set(0, 1, 0)
      obj.group.lookAt(lookTarget.copy(worldEdgeMids[i]).add(worldNormal))
    })

    centerGroup.position.copy(worldCenter)
    centerGroup.scale.setScalar(getScreenScale(worldCenter) * px)
    centerGroup.lookAt(lookTarget.copy(worldCenter).add(worldNormal))
    centerGroup.visible = !isUniversalMode

    const pa = lineGeo.attributes.position
    worldCorners.forEach((p, i) => pa.setXYZ(i, p.x, p.y, p.z))
    pa.needsUpdate = true
    lineGeo.computeBoundingSphere()

    worldCorners.forEach((p, i) => fillPosAttr.setXYZ(i, p.x, p.y, p.z))
    fillPosAttr.needsUpdate = true
    planeFillGeo.computeBoundingSphere()
  }

  const findHit = (cx, cy) => {
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
    if (bestCorner !== -1) return { type: 'corner', index: bestCorner }

    if (!isUniversalMode) {
      const sc = toScreen(centerWorldPos)
      if (sc.visible && Math.hypot(sc.x - cx, sc.y - cy) < 20) {
        return { type: 'move', index: -1 }
      }
    }

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
    if (bestEdge !== -1) return { type: 'edge', index: bestEdge }

    const sCorners = cornerObjs.map((c) => toScreen(c.worldPos))
    let bestSegDist = 10
    sCorners.forEach((p1, i) => {
      const p2 = sCorners[(i + 1) % 4]
      if (!p1.visible || !p2.visible) return
      const d = distToSegment(cx, cy, p1.x, p1.y, p2.x, p2.y)
      if (d < bestSegDist) {
        bestSegDist = d
        bestEdge = i
      }
    })
    if (bestEdge !== -1) return { type: 'edge', index: bestEdge }

    if (sCorners.every((c) => c.visible) && pointInPolygon(cx, cy, sCorners)) {
      return { type: 'move', index: -1 }
    }
    return null
  }

  const getCursorForHit = (hit) => {
    if (!hit) return ''
    if (hit.type === 'move') return 'move'
    const sCorners = cornerObjs.map((c) => toScreen(c.worldPos))
    if (hit.type === 'corner') return getCornerCursor(hit.index, sCorners)
    if (hit.type === 'edge') return getEdgeCursor(hit.index, sCorners)
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

  const suspendOrbit = () => {
    if (!orbitControls) return
    orbitWasEnabled = orbitControls.enabled
    orbitControls.enabled = false
    orbitControls.enableRotate = false
    orbitControls.enablePan = false
  }

  const restoreOrbit = () => {
    if (!orbitControls) return
    orbitControls.enableRotate = true
    orbitControls.enablePan = true
    orbitControls.enabled = orbitWasEnabled
  }

  const endDrag = (commit) => {
    if (!isDragging()) {
      interaction = 'idle'
      return
    }
    try {
      if (activePointerId !== null && domElement.hasPointerCapture(activePointerId)) {
        domElement.releasePointerCapture(activePointerId)
      }
    } catch {
      /* already released */
    }
    activePointerId = null
    dragMode = null
    activeHandle = -1
    lockedPlaneGeom = null
    interaction = 'idle'
    restoreOrbit()
    domElement.style.cursor = ''
    clearHighlights()
    if (commit) onTransformChange(true)
  }

  const onDown = (e) => {
    if (!gizmoGroup.visible || e.button !== 0) return
    if (e.target !== domElement) return
    const model = getModelGroup?.()
    if (!model) return

    update()
    const { cx, cy, r } = getPointer(e)
    const hit = findHit(cx, cy)
    if (!hit) return

    e.preventDefault()
    e.stopImmediatePropagation()

    dragMode = hit.type
    activeHandle = hit.index
    activePointerId = e.pointerId
    interaction =
      hit.type === 'corner'
        ? 'dragging-corner'
        : hit.type === 'edge'
          ? 'dragging-edge'
          : 'dragging-center'

    try {
      domElement.setPointerCapture(e.pointerId)
    } catch {
      /* capture unsupported */
    }

    suspendOrbit()

    lockedPlaneGeom = {
      ...currentPlaneGeom,
      corners: currentPlaneGeom.corners.map((c) => c.clone()),
      edgeMids: currentPlaneGeom.edgeMids.map((m) => m.clone()),
      center: currentPlaneGeom.center.clone(),
    }
    const lp = lockedPlaneGeom

    model.updateMatrixWorld(true)
    model.getWorldQuaternion(worldQuat)
    invWorldQ.copy(worldQuat).invert()
    dragPlane.setFromNormalAndCoplanarPoint(worldNormal, centerWorldPos)

    if (!setNdc(cx, cy, r) || !raycaster.ray.intersectPlane(dragPlane, hitStart)) {
      endDrag(false)
      return
    }

    startScale.copy(model.scale)
    startPos.copy(model.position)

    if (hit.type === 'corner') {
      const oppIndex = (hit.index + 2) % 4
      anchorLocal.copy(lp.corners[oppIndex])
      anchorWorld.copy(anchorLocal).applyMatrix4(model.matrixWorld)
      dragDeltaLocal.copy(lp.corners[hit.index]).sub(anchorLocal)
      startExtentH = startScale[lp.hKey] * dragDeltaLocal[lp.hKey]
      startExtentV = startScale[lp.vKey] * dragDeltaLocal[lp.vKey]
      if (Math.abs(startExtentH) < 1e-6) startExtentH = 1e-4
      if (Math.abs(startExtentV) < 1e-6) startExtentV = 1e-4
      cornerObjs[hit.index].outer.material = dragMat
    } else if (hit.type === 'edge') {
      const oppIndex = (hit.index + 2) % 4
      anchorLocal.copy(lp.edgeMids[oppIndex])
      anchorWorld.copy(anchorLocal).applyMatrix4(model.matrixWorld)
      dragDeltaLocal.copy(lp.edgeMids[hit.index]).sub(anchorLocal)
      startExtentH = startScale[lp.hKey] * dragDeltaLocal[lp.hKey]
      startExtentV = startScale[lp.vKey] * dragDeltaLocal[lp.vKey]
      if (Math.abs(startExtentH) < 1e-6) startExtentH = 1e-4
      if (Math.abs(startExtentV) < 1e-6) startExtentV = 1e-4
      edgeObjs[hit.index].outer.material = dragMat
    } else {
      ring.material = dragMat
    }

    lineMat.color.setHex(0x00ffff)
    planeFillMat.opacity = 0.12
    domElement.style.cursor = getCursorForHit(hit)
  }

  const onMove = (e) => {
    if (!gizmoGroup.visible) return
    const model = getModelGroup?.()
    if (!model) {
      if (isDragging()) endDrag(false)
      return
    }

    if (isDragging()) {
      if (activePointerId !== null && e.pointerId !== activePointerId) return
      e.preventDefault()
      const { cx, cy, r } = getPointer(e)
      if (!setNdc(cx, cy, r)) return
      if (!raycaster.ray.intersectPlane(dragPlane, hitCurrent)) return

      const deltaW = hitCurrent.clone().sub(hitStart)
      const lp = lockedPlaneGeom

      if (dragMode === 'move') {
        applyWorldDeltaToStart(model, deltaW)
      } else {
        const deltaL = deltaW.applyQuaternion(invWorldQ)
        const newScale = startScale.clone()
        if (dragMode === 'corner') {
          let ratioH = (startExtentH + deltaL[lp.hKey]) / startExtentH
          let ratioV = (startExtentV + deltaL[lp.vKey]) / startExtentV
          if (!Number.isFinite(ratioH) || !Number.isFinite(ratioV)) return
          ratioH = Math.min(Math.max(ratioH, 0.01), 100)
          ratioV = Math.min(Math.max(ratioV, 0.01), 100)
          if (e.shiftKey) {
            const uniform = (ratioH + ratioV) / 2
            newScale[lp.hKey] = Math.max(startScale[lp.hKey] * uniform, 1e-4)
            newScale[lp.vKey] = Math.max(startScale[lp.vKey] * uniform, 1e-4)
          } else {
            newScale[lp.hKey] = Math.max(startScale[lp.hKey] * ratioH, 1e-4)
            newScale[lp.vKey] = Math.max(startScale[lp.vKey] * ratioV, 1e-4)
          }
        } else if (dragMode === 'edge') {
          if (activeHandle === 0 || activeHandle === 2) {
            let ratioV = (startExtentV + deltaL[lp.vKey]) / startExtentV
            if (!Number.isFinite(ratioV)) return
            ratioV = Math.min(Math.max(ratioV, 0.01), 100)
            newScale[lp.vKey] = Math.max(startScale[lp.vKey] * ratioV, 1e-4)
          } else {
            let ratioH = (startExtentH + deltaL[lp.hKey]) / startExtentH
            if (!Number.isFinite(ratioH)) return
            ratioH = Math.min(Math.max(ratioH, 0.01), 100)
            newScale[lp.hKey] = Math.max(startScale[lp.hKey] * ratioH, 1e-4)
          }
        }
        newScale[lp.dKey] = startScale[lp.dKey]
        model.scale.copy(newScale)
        keepLocalAnchor(model, anchorLocal, anchorWorld)
      }

      onTransformChange(false)
      update()
      return
    }

    if (!pointerOnCanvas(e)) {
      if (interaction !== 'idle') {
        domElement.style.cursor = ''
        clearHighlights()
        interaction = 'idle'
      }
      return
    }

    const { cx, cy } = getPointer(e)
    const hit = findHit(cx, cy)
    interaction = hit ? 'hover' : 'idle'
    domElement.style.cursor = getCursorForHit(hit)

    cornerObjs.forEach((c, i) => {
      c.outer.material = hit?.type === 'corner' && hit.index === i ? hoverMat : outerMat
    })
    edgeObjs.forEach((eg, i) => {
      eg.outer.material = hit?.type === 'edge' && hit.index === i ? hoverMat : outerMat
    })
    ring.material = hit?.type === 'move' && !isUniversalMode ? hoverMat : outerMat
    planeFillMat.opacity = hit?.type === 'move' ? 0.09 : 0.04
  }

  const onUp = (e) => {
    if (!isDragging()) return
    if (activePointerId !== null && e.pointerId !== activePointerId) return
    endDrag(true)
  }

  const onLostCapture = () => {
    if (isDragging()) endDrag(true)
  }

  const cancelDrag = () => endDrag(false)

  document.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  window.addEventListener('blur', cancelDrag)
  domElement.addEventListener('lostpointercapture', onLostCapture)

  return {
    group: gizmoGroup,
    isDragging,
    invalidateBounds: () => {
      boxModel = null
      localBox.makeEmpty()
    },
    setVisible: (v) => {
      if (!v) {
        gizmoGroup.visible = false
        cancelDrag()
        return
      }
      const wasVisible = gizmoGroup.visible
      gizmoGroup.visible = true
      if (!isDragging() || !wasVisible) {
        boxModel = null
        localBox.makeEmpty()
      }
      update()
    },
    setUniversal: (v) => {
      isUniversalMode = !!v
      centerGroup.visible = !v
    },
    setSize: (s) => {
      handleScale = Number.isFinite(s) && s > 0 ? s : 1
    },
    setOrientation: (o) => {
      preferredOrientation = o === 'vertical' ? 'vertical' : 'horizontal'
      if (!isDragging()) {
        activePlaneName = preferredOrientation === 'vertical' ? 'XY' : 'XZ'
        update()
      }
    },
    getOrientation: () => preferredOrientation,
    update,
    dispose: () => {
      cancelDrag()
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', cancelDrag)
      domElement.removeEventListener('lostpointercapture', onLostCapture)
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
