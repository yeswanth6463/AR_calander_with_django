import * as THREE from 'three'

const deg = THREE.MathUtils.degToRad
const rad = THREE.MathUtils.radToDeg

/**
 * YXZ matches the studio's Global rotate gizmo: yaw around world/editor Y,
 * then pitch around X, then roll around Z. XYZ was reversing yaw/pitch, so
 * the published AR pose did not match the viewport.
 */
export const EULER_ORDER = 'YXZ'

const _euler = new THREE.Euler(0, 0, 0, EULER_ORDER)

/**
 * Authoritative AR item frame used by the studio editor:
 *   X = right on the target
 *   Y = down the target image
 *   Z = out of the target plane (height above the marker)
 *
 * The editor viewport lies the marker on the XZ ground plane (Y up). Relative
 * to the marker center that is:
 *   editorX = AR.x
 *   editorY = AR.z
 *   editorZ = -AR.y
 *
 * Tracker pose (OpenCV → Three.js): origin at the target top-left, +X right,
 * +Y down the image, +Z into the target (away from the camera). Rx(-90°) on
 * the content group maps editor Y-up space onto that anchor so saved Euler
 * angles apply unchanged.
 */
export function attachContentToTargetAnchor(content, targetAspect) {
  const aspect = Number.isFinite(targetAspect) ? targetAspect : 1
  content.position.set(0.5, aspect / 2, 0)
  content.rotation.order = 'XYZ'
  content.rotation.set(-Math.PI / 2, 0, 0)
  content.scale.set(1, 1, 1)
}

export function scaleXYZ(transform = {}) {
  const fromList = (arr) => {
    if (!Array.isArray(arr) || arr.length < 3) return null
    const xyz = arr.slice(0, 3).map((v) => Number(v))
    if (xyz.some((v) => !Number.isFinite(v) || v <= 0)) return null
    return xyz
  }
  const xyz = fromList(transform.scale_xyz) || fromList(transform.scale)
  const scalar = Number(transform.scale)
  const uniform = Number.isFinite(scalar) && scalar > 0 ? scalar : 1
  // Prefer axis values when they were actually authored (not leftover 1,1,1
  // while `scale` holds the inspector size).
  if (xyz) {
    const looksDefault = xyz.every((v) => Math.abs(v - 1) < 1e-6)
    if (!looksDefault || Math.abs(uniform - 1) < 1e-6) return xyz
  }
  return [uniform, uniform, uniform]
}

/** Same local TRS the editor viewport uses (Y-up, Z toward the top of the image). */
export function applyARItemTransform(object, transform = {}) {
  const pos = transform.position || [0, 0, 0]
  const rot = transform.rotation || [0, 0, 0]
  const scl = scaleXYZ(transform)
  const px = Number(pos[0]) || 0
  const py = Number(pos[1]) || 0
  const pz = Number(pos[2]) || 0
  object.position.set(px, pz, -py)
  object.rotation.order = EULER_ORDER
  object.rotation.set(deg(rot[0] || 0), deg(rot[1] || 0), deg(rot[2] || 0), EULER_ORDER)
  object.quaternion.setFromEuler(object.rotation)
  object.scale.set(
    Math.max(Number(scl[0]) || 1, 1e-4),
    Math.max(Number(scl[1]) || 1, 1e-4),
    Math.max(Number(scl[2]) || 1, 1e-4)
  )
}

export function eulerDegreesFromObject(object) {
  _euler.order = EULER_ORDER
  _euler.setFromQuaternion(object.quaternion, EULER_ORDER)
  return {
    rotation_x: rad(_euler.x),
    rotation_y: rad(_euler.y),
    rotation_z: rad(_euler.z),
  }
}

function objectBounds(root) {
  root.updateMatrixWorld(true)
  const box = new THREE.Box3()
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return
    if (obj.name === '__contact_shadow__') return
    if (obj.isSkinnedMesh) obj.skeleton?.update()
    obj.geometry.computeBoundingBox?.()
    const local = obj.geometry.boundingBox
    if (!local || local.isEmpty()) return
    box.union(local.clone().applyMatrix4(obj.matrixWorld))
  })
  if (box.isEmpty()) box.setFromObject(root)
  return box
}

/** Soft ground contact shadow anchoring 3D models to the target surface. */
export function createContactShadow(width = 0.5, depth = 0.5) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.75)')
  grad.addColorStop(0.25, 'rgba(0, 0, 0, 0.48)')
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.16)')
  grad.addColorStop(0.85, 'rgba(0, 0, 0, 0.03)')
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)

  const texture = new THREE.CanvasTexture(canvas)
  const sx = Math.max(Number(width) || 0.5, 0.2) * 1.35
  const sz = Math.max(Number(depth) || 0.5, 0.2) * 1.35
  const geo = new THREE.PlaneGeometry(sx, sz)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = '__contact_shadow__'
  mesh.position.set(0, 0.0015, 0)
  mesh.renderOrder = 2
  return mesh
}

/** Sit a GLB on the marker plane; identical in the editor and the live viewer. */
export function fitModelToMarker(root) {
  root.position.set(0, 0, 0)
  root.rotation.set(0, 0, 0)
  root.scale.set(1, 1, 1)
  const box = objectBounds(root)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  const safeDim = Number.isFinite(maxDim) && maxDim > 1e-4 ? maxDim : 1
  root.scale.setScalar(0.5 / safeDim)
  const box2 = objectBounds(root)
  if (!box2.isEmpty()) {
    const c = box2.getCenter(new THREE.Vector3())
    root.position.set(-c.x, -box2.min.y, -c.z)
  }
  root.traverse((obj) => {
    if (!obj.isMesh) return
    obj.frustumCulled = false
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    mats.forEach((mat) => {
      if (!mat) return
      mat.depthTest = true
      mat.depthWrite = mat.transparent ? false : mat.depthWrite !== false
      mat.needsUpdate = true
    })
  })
  return size
}

export function animationConfigFromState(st) {
  if (!st) return null
  const names = Array.isArray(st.clips) ? st.clips.map((c) => c.name) : []
  const active = Array.isArray(st.activeIndices) ? st.activeIndices : []
  return {
    loop: st.loop === 'repeat' ? 'repeat' : 'once',
    speed: Number.isFinite(st.speed) ? st.speed : 1,
    autoplay: st.autoplay !== false,
    clips: active.map((i) => names[i]).filter(Boolean),
  }
}
