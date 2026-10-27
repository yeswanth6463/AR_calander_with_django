const mul3 = (A, B) => {
  // Row-major 3x3: C = A * B
  const C = new Array(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] =
        A[r * 3] * B[c] +
        A[r * 3 + 1] * B[3 + c] +
        A[r * 3 + 2] * B[6 + c]
    }
  }
  return C
}

const col = (M, i) => [M[i], M[3 + i], M[6 + i]]

const norm = (v) => Math.hypot(v[0], v[1], v[2])
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const normalize = (v) => {
  const n = norm(v)
  return n < 1e-9 ? [1, 0, 0] : scale(v, 1 / n)
}

export function readHomography(mat) {
  if (!mat) return null
  const d64 = mat.data64F
  if (d64 && d64.length >= 9) {
    return [d64[0], d64[1], d64[2], d64[3], d64[4], d64[5], d64[6], d64[7], d64[8]]
  }
  const d32 = mat.data32F
  if (d32 && d32.length >= 9) {
    return [d32[0], d32[1], d32[2], d32[3], d32[4], d32[5], d32[6], d32[7], d32[8]]
  }
  return null
}

/**
 * Planar pose from a homography that maps target pixels → camera pixels.
 * World units: target width = 1, origin at the target's top-left, +X along
 * the top edge, +Y down the left edge, +Z out of the image plane.
 *
 * Returns a column-major Three.js Matrix4 (OpenCV y-down/z-forward converted
 * to Three.js y-up/z-toward-camera).
 */
export function poseFromHomography(H, frameW, frameH, fovDeg, targetW = 1) {
  if (!H || H.length < 9 || H.some((v) => !Number.isFinite(v))) return null

  const f = frameH / 2 / Math.tan((fovDeg * Math.PI) / 360)
  const cx = frameW / 2
  const cy = frameH / 2
  const Kinv = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1]
  const widthPx = Math.max(targetW, 1)

  const build = (homography) => {
    const M = mul3(Kinv, homography)
    let r1 = col(M, 0)
    let r2 = col(M, 1)
    let t = col(M, 2)
    const perPixel = (norm(r1) + norm(r2)) / 2 || 1e-9
    const s = 1 / (perPixel * widthPx)
    r1 = scale(r1, s)
    r2 = scale(r2, s)
    t = scale(t, s)
    const R1 = normalize(r1)
    const R2 = normalize(sub(r2, scale(R1, dot(R1, r2))))
    const R3 = cross(R1, R2)
    return { R1, R2, R3, t }
  }

  let pose = build(H)
  // OpenCV camera looks +Z; the plane must sit in front of the camera.
  if (pose.t[2] < 0) {
    pose = build(H.map((v) => -v))
  }

  // diag(1, -1, -1) maps OpenCV (y down, z forward) → Three.js (y up, z toward viewer)
  const flip = (v) => [v[0], -v[1], -v[2]]
  const c0 = flip(pose.R1)
  const c1 = flip(pose.R2)
  const c2 = flip(pose.R3)
  const ct = flip(pose.t)

  if (![...c0, ...c1, ...c2, ...ct].every(Number.isFinite)) return null
  const dist = norm(ct)
  if (dist < 0.02 || dist > 80) return null

  return [
    c0[0], c0[1], c0[2], 0,
    c1[0], c1[1], c1[2], 0,
    c2[0], c2[1], c2[2], 0,
    ct[0], ct[1], ct[2], 1,
  ]
}

export function poseTranslation(matrix) {
  if (!matrix || matrix.length < 16) return null
  return { x: matrix[12], y: matrix[13], z: matrix[14], dist: Math.hypot(matrix[12], matrix[13], matrix[14]) }
}

export function smoothCorners(prev, next, alpha = 0.35) {
  if (!prev) return next
  return next.map((p, i) => [
    prev[i][0] + (p[0] - prev[i][0]) * alpha,
    prev[i][1] + (p[1] - prev[i][1]) * alpha,
  ])
}
