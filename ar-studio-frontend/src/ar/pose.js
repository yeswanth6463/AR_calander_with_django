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
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s]
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
    // Symmetric orthonormalization: split the error evenly between r1 and r2.
    // Gram-Schmidt (fix r1, bend r2) pushes all noise into one axis, which
    // shows up as a lopsided wobble of the model.
    const c = normalize([r1[0] + r2[0], r1[1] + r2[1], r1[2] + r2[2]])
    const d = normalize(cross(c, cross(r1, r2)))
    const k = Math.SQRT1_2
    const R1 = [(c[0] + d[0]) * k, (c[1] + d[1]) * k, (c[2] + d[2]) * k]
    const R2 = [(c[0] - d[0]) * k, (c[1] - d[1]) * k, (c[2] - d[2]) * k]
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

/**
 * Closed-form 4-point projective homography from rectangle [0, 0, tw, th] to quad corners.
 * Bypasses OpenCV matrix allocations entirely for ultra-low latency & zero GC pauses.
 */
export function getQuadHomography(targetW, targetH, corners) {
  if (!corners || corners.length < 4) return null
  const [p0, p1, p2, p3] = corners
  const x0 = p0[0], y0 = p0[1]
  const x1 = p1[0], y1 = p1[1]
  const x2 = p2[0], y2 = p2[1]
  const x3 = p3[0], y3 = p3[1]

  const dx1 = x1 - x2
  const dy1 = y1 - y2
  const dx2 = x3 - x2
  const dy2 = y3 - y2

  const sx = x0 - x1 + x2 - x3
  const sy = y0 - y1 + y2 - y3

  const det = dx1 * dy2 - dx2 * dy1
  if (Math.abs(det) < 1e-8) return null

  let g = 0
  let h = 0
  if (Math.abs(sx) > 1e-8 || Math.abs(sy) > 1e-8) {
    g = (sx * dy2 - sy * dx2) / det
    h = (dx1 * sy - dy1 * sx) / det
  }

  const a = x1 - x0 + g * x1
  const b = x3 - x0 + h * x3
  const c = x0
  const d = y1 - y0 + g * y1
  const e = y3 - y0 + h * y3
  const f = y0

  const tw = Math.max(targetW - 1, 1)
  const th = Math.max(targetH - 1, 1)

  return [
    a / tw, b / th, c,
    d / tw, e / th, f,
    g / tw, h / th, 1,
  ]
}

/**
 * Focal length (px) for a camera frame, assuming a typical phone/webcam
 * field of view across the LONG edge. Using a fixed vertical FOV on the
 * frame height made portrait frames very telephoto (f ≈ 1.4× too large),
 * which turns small homography noise into big tilt swings.
 */
export const LONG_EDGE_FOV_DEG = 63
export function focalForFrame(frameW, frameH, longEdgeFovDeg = LONG_EDGE_FOV_DEG) {
  return Math.max(frameW, frameH) / 2 / Math.tan((longEdgeFovDeg * Math.PI) / 360)
}
/** Vertical FOV (deg) matching focalForFrame — feed to both pose + THREE camera. */
export function verticalFovForFrame(frameW, frameH, longEdgeFovDeg = LONG_EDGE_FOV_DEG) {
  const f = focalForFrame(frameW, frameH, longEdgeFovDeg)
  return (2 * Math.atan(frameH / 2 / f) * 180) / Math.PI
}

/**
 * One Euro filter over the 4 tracked corners (8 values).
 * Heavy smoothing when the quad is nearly still (kills keypoint jitter),
 * low lag when it moves fast. No freeze/deadband, so there is no
 * stick-then-jump motion.
 * `state` is null on (re)acquire; returns { state, corners }.
 */
export const ONE_EURO = { minCutoff: 0.9, beta: 0.012, dCutoff: 1.2 }
// Optical-flow corners are sub-pixel and temporally coherent: smooth less, lag less.
export const ONE_EURO_FLOW = { minCutoff: 2.2, beta: 0.02, dCutoff: 1.2 }
const lpAlpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}
export function filterCorners(state, corners, tSec, opts = ONE_EURO) {
  const x = corners.flat()
  if (!state) {
    return { state: { x, dx: new Array(8).fill(0), t: tSec }, corners: corners.map((c) => [c[0], c[1]]) }
  }
  const dt = Math.min(Math.max(tSec - state.t, 1 / 240), 0.25)
  const aD = lpAlpha(opts.dCutoff, dt)
  const outX = new Array(8)
  const outDx = new Array(8)
  for (let i = 0; i < 8; i++) {
    const rawDx = (x[i] - state.x[i]) / dt
    const dxHat = state.dx[i] + aD * (rawDx - state.dx[i])
    const cutoff = opts.minCutoff + opts.beta * Math.abs(dxHat)
    const a = lpAlpha(cutoff, dt)
    outX[i] = state.x[i] + a * (x[i] - state.x[i])
    outDx[i] = dxHat
  }
  return {
    state: { x: outX, dx: outDx, t: tSec },
    corners: [
      [outX[0], outX[1]],
      [outX[2], outX[3]],
      [outX[4], outX[5]],
      [outX[6], outX[7]],
    ],
  }
}

/**
 * Adaptive corner smoothing (legacy, unused by the viewer):
 * - When stationary (< 2.5px jitter), the quad is frozen completely: the
 *   pose decomposition amplifies a 1px corner wobble into a visible tilt
 *   swing, so any residual creep here becomes model shake.
 * - Slow drift gets only a gentle creep; responsiveness ramps up with
 *   confirmed displacement and reaches near-instant for fast pans.
 * - If displaced over 100px (fast camera snap), snaps instantly.
 */
export function smoothCorners(prev, next, baseAlpha = 0.35) {
  if (!prev) return next
  let maxD = 0
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(next[i][0] - prev[i][0], next[i][1] - prev[i][1])
    if (d > maxD) maxD = d
  }
  if (maxD > 120) return next

  // Freeze the quad until motion is real, then follow it.
  if (maxD < 2.5) return prev

  let alpha
  if (maxD < 6.0) {
    // Genuine slow drift — creep gently, don't chase noise.
    alpha = 0.06 + 0.10 * ((maxD - 2.5) / 3.5)
  } else if (maxD < 20.0) {
    // Handheld pan — firm damped follow.
    alpha = 0.16 + 0.34 * ((maxD - 6.0) / 14.0)
  } else if (maxD < 60.0) {
    // Fast pan.
    alpha = 0.50 + 0.36 * ((maxD - 20.0) / 40.0)
  } else {
    alpha = 0.94
  }

  return next.map((p, i) => [
    prev[i][0] + (p[0] - prev[i][0]) * alpha,
    prev[i][1] + (p[1] - prev[i][1]) * alpha,
  ])
}
