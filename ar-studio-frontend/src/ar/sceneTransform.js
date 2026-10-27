import * as THREE from 'three'

const deg = THREE.MathUtils.degToRad

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
 * The live viewer anchor uses the tracker pose (origin at the target top-left,
 * +X right, +Y down the image, +Z away from camera / into the target plane). A -90° pitch
 * on the content group maps editor Y-up space onto that anchor so saved Euler XYZ
 * rotations apply unchanged.
 */

export function attachContentToTargetAnchor(content, targetAspect) {
  const aspect = Number.isFinite(targetAspect) ? targetAspect : 1
  content.position.set(0.5, aspect / 2, 0)
  content.rotation.set(-Math.PI / 2, 0, 0)
  content.scale.set(1, 1, 1)
}

export function scaleXYZ(transform = {}) {
  if (Array.isArray(transform.scale_xyz) && transform.scale_xyz.length >= 3) {
    return transform.scale_xyz
  }
  if (Array.isArray(transform.scale) && transform.scale.length >= 3) {
    return transform.scale
  }
  const s = Number(transform.scale)
  const n = Number.isFinite(s) && s > 0 ? s : 1
  return [n, n, n]
}

export function applyARItemTransform(object, transform = {}) {
  const pos = transform.position || [0, 0, 0]
  const rot = transform.rotation || [0, 0, 0]
  const scl = scaleXYZ(transform)
  const px = Number(pos[0]) || 0
  const py = Number(pos[1]) || 0
  const pz = Number(pos[2]) || 0
  object.position.set(px, pz, -py)
  object.rotation.set(deg(rot[0] || 0), deg(rot[1] || 0), deg(rot[2] || 0))
  object.scale.set(
    Math.max(Number(scl[0]) || 1, 1e-4),
    Math.max(Number(scl[1]) || 1, 1e-4),
    Math.max(Number(scl[2]) || 1, 1e-4)
  )
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
