/**
 * Frame-to-frame planar tracking with pyramidal Lucas-Kanade optical flow.
 *
 * ORB detection (tracker.js) is good at *finding* the target, but its
 * keypoints are re-detected every frame at coarse pyramid positions, so the
 * homography jitters. Once the target is found we seed sub-pixel corners
 * (goodFeaturesToTrack + cornerSubPix) inside the projected quad, remember
 * where each one lies on the target image (via H⁻¹), then follow them with
 * KLT. A forward-backward check drops points that slid off texture, and a
 * RANSAC + least-squares homography on the survivors gives a stable,
 * accurate pose.
 *
 * Coordinates: `gray` is the full camera frame downscaled to `FLOW_CONFIG.width`.
 * All homographies in/out of this module map TARGET px → VIDEO px.
 */

export const FLOW_CONFIG = {
  width: 640,
  maxCorners: 160,
  qualityLevel: 0.008,
  minDistance: 9,
  blockSize: 5,
  quadShrink: 0.04, // keep seeds off the target border (background bleeds there)
  winSize: 21,
  maxLevel: 3,
  fbMaxErr: 0.8, // forward-backward round-trip error allowed (process px)
  minPoints: 14,
  reseedBelow: 70,
  ransacReprojPx: 2.0, // process px
  minInlierRatio: 0.55,
}

const applyH = (H, x, y) => {
  const w = H[6] * x + H[7] * y + H[8]
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return [NaN, NaN]
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]
}

export const invert3 = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const s = 1 / det
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ]
}

const mat9 = (M) => {
  const d = M?.data64F?.length >= 9 ? M.data64F : M?.data32F?.length >= 9 ? M.data32F : null
  return d ? Array.from(d.slice(0, 9)) : null
}

const finiteH = (H) => H && H.length >= 9 && H.every(Number.isFinite)

// cv.TermCriteria.EPS = 2, COUNT = 1 (constant names differ between 4.x / 5.x builds).
const termCriteria = () => new cv.TermCriteria(2 | 1, 30, 0.01)

/** KLT needs this; without it the viewer falls back to detection-only tracking. */
export const flowSupported = () =>
  typeof cv !== 'undefined' && typeof cv.calcOpticalFlowPyrLK === 'function'

let seedOrb = null
const getSeedOrb = (n) => {
  if (seedOrb && seedOrb.n >= n) return seedOrb.orb
  seedOrb?.orb?.delete?.()
  const args = [n, 1.2, 1, 7, 0, 2, 0 /* HARRIS */, 7, 10]
  let orb = null
  try {
    orb = typeof cv.ORB_create === 'function' ? cv.ORB_create(...args) : new cv.ORB(...args)
  } catch {
    orb = typeof cv.ORB_create === 'function' ? cv.ORB_create(n) : new cv.ORB(n)
  }
  seedOrb = { orb, n }
  return orb
}

export const releaseFlowRuntime = () => {
  seedOrb?.orb?.delete?.()
  seedOrb = null
}

/**
 * Strong, well-localised corners inside `rect` (process px, full-frame coords),
 * best first. Shi-Tomasi when the build exports it, else single-level Harris-
 * scored ORB keypoints. Sub-pixel refined when cornerSubPix is available.
 */
function detectCorners(gray, rect, maxN, cfg) {
  const sub = gray.roi(rect)
  const out = []
  try {
    if (typeof cv.goodFeaturesToTrack === 'function') {
      const corners = new cv.Mat()
      const noMask = new cv.Mat()
      try {
        cv.goodFeaturesToTrack(sub, corners, maxN, cfg.qualityLevel, cfg.minDistance, noMask, cfg.blockSize)
        refineSubPix(sub, corners)
        const d = corners.data32F
        for (let i = 0; i < corners.rows; i++) out.push([d[i * 2] + rect.x, d[i * 2 + 1] + rect.y])
      } finally {
        corners.delete()
        noMask.delete()
      }
      return out
    }

    const orb = getSeedOrb(maxN)
    const kps = new cv.KeyPointVector()
    const desc = new cv.Mat()
    const noMask = new cv.Mat()
    try {
      orb.detectAndCompute(sub, noMask, kps, desc)
      const n = typeof kps.size === 'function' ? kps.size() : 0
      const list = []
      for (let i = 0; i < n; i++) {
        const kp = kps.get(i)
        list.push({ x: kp.pt.x, y: kp.pt.y, r: kp.response })
      }
      list.sort((a, b) => b.r - a.r)
      if (list.length) {
        const flat = new Float32Array(list.length * 2)
        list.forEach((p, i) => {
          flat[i * 2] = p.x
          flat[i * 2 + 1] = p.y
        })
        const corners = cv.matFromArray(list.length, 1, cv.CV_32FC2, flat)
        try {
          refineSubPix(sub, corners)
          const d = corners.data32F
          for (let i = 0; i < corners.rows; i++) out.push([d[i * 2] + rect.x, d[i * 2 + 1] + rect.y])
        } finally {
          corners.delete()
        }
      }
    } finally {
      kps.delete()
      desc.delete()
      noMask.delete()
    }
    return out
  } finally {
    sub.delete()
  }
}

function refineSubPix(img, corners) {
  if (!corners.rows || typeof cv.cornerSubPix !== 'function') return
  try {
    cv.cornerSubPix(img, corners, new cv.Size(4, 4), new cv.Size(-1, -1), termCriteria())
  } catch {
    /* integer corners are still usable */
  }
}

export class FlowTracker {
  constructor(config = FLOW_CONFIG) {
    this.cfg = config
    this.prevGray = null
    this.pts = [] // process-px positions in prevGray
    this.ref = [] // matching target-px positions
    this.H = null
  }

  get active() {
    return !!this.prevGray && this.pts.length >= this.cfg.minPoints
  }

  get count() {
    return this.pts.length
  }

  reset() {
    this.prevGray?.delete()
    this.prevGray = null
    this.pts = []
    this.ref = []
    this.H = null
  }

  /**
   * Add sub-pixel corners inside the target quad. `H` maps target → video px,
   * `sx/sy` are video px per process px. Keeps existing points (top-up).
   */
  seed(gray, H, targetW, targetH, sx, sy) {
    const Hinv = invert3(H)
    if (!Hinv) return 0
    const cfg = this.cfg
    const k = cfg.quadShrink
    const quad = [
      [targetW * k, targetH * k],
      [targetW * (1 - k), targetH * k],
      [targetW * (1 - k), targetH * (1 - k)],
      [targetW * k, targetH * (1 - k)],
    ].map(([x, y]) => {
      const [vx, vy] = applyH(H, x, y)
      return [Math.round(vx / sx), Math.round(vy / sy)]
    })
    if (quad.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return 0
    const want = cfg.maxCorners - this.pts.length
    if (want <= 0) return 0

    // Detect inside the quad's bounding box only, then keep points whose
    // target-space position is inside the (shrunk) target rectangle.
    const xs = quad.map((p) => p[0])
    const ys = quad.map((p) => p[1])
    const x0 = Math.max(0, Math.min(...xs))
    const y0 = Math.max(0, Math.min(...ys))
    const x1 = Math.min(gray.cols, Math.max(...xs))
    const y1 = Math.min(gray.rows, Math.max(...ys))
    if (x1 - x0 < 24 || y1 - y0 < 24) return 0

    const candidates = detectCorners(gray, new cv.Rect(x0, y0, x1 - x0, y1 - y0), want * 3, cfg)
    const minD2 = cfg.minDistance * cfg.minDistance
    const taken = this.pts.slice()
    let added = 0
    for (const [px, py] of candidates) {
      if (added >= want) break
      const [tx, ty] = applyH(Hinv, px * sx, py * sy)
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue
      if (tx < targetW * k || ty < targetH * k || tx > targetW * (1 - k) || ty > targetH * (1 - k)) continue
      let crowded = false
      for (const q of taken) {
        const dx = q[0] - px
        const dy = q[1] - py
        if (dx * dx + dy * dy < minD2) {
          crowded = true
          break
        }
      }
      if (crowded) continue
      taken.push([px, py])
      this.pts.push([px, py])
      this.ref.push([tx, ty])
      added++
    }
    this.H = H
    return added
  }

  /** Replace all points with a fresh seed from a trusted homography. */
  reseed(gray, H, targetW, targetH, sx, sy) {
    this.pts = []
    this.ref = []
    const n = this.seed(gray, H, targetW, targetH, sx, sy)
    this.commit(gray)
    return n
  }

  /**
   * Follow the points from prevGray into `gray`.
   * Returns { found, H, inliers } with H mapping target → video px.
   * Does NOT advance prevGray — call commit(gray) after any top-up.
   */
  track(gray, sx, sy) {
    if (!this.active) return { found: false, reason: 'flow inactive' }
    const cfg = this.cfg
    const n = this.pts.length
    const prevPts = cv.matFromArray(n, 1, cv.CV_32FC2, this.pts.flat())
    const nextPts = new cv.Mat()
    const backPts = new cv.Mat()
    const st1 = new cv.Mat()
    const st2 = new cv.Mat()
    const err1 = new cv.Mat()
    const err2 = new cv.Mat()
    const win = new cv.Size(cfg.winSize, cfg.winSize)
    const crit = termCriteria()
    let src = null
    let dst = null
    let mask = null
    let Hm = null
    try {
      cv.calcOpticalFlowPyrLK(this.prevGray, gray, prevPts, nextPts, st1, err1, win, cfg.maxLevel, crit)
      cv.calcOpticalFlowPyrLK(gray, this.prevGray, nextPts, backPts, st2, err2, win, cfg.maxLevel, crit)
      const nx = nextPts.data32F
      const bx = backPts.data32F
      const s1 = st1.data
      const s2 = st2.data
      const fb2 = cfg.fbMaxErr * cfg.fbMaxErr
      const keepNext = []
      const keepRef = []
      for (let i = 0; i < n; i++) {
        if (!s1[i] || !s2[i]) continue
        const dx = bx[i * 2] - this.pts[i][0]
        const dy = bx[i * 2 + 1] - this.pts[i][1]
        if (dx * dx + dy * dy > fb2) continue
        const x = nx[i * 2]
        const y = nx[i * 2 + 1]
        if (x < 0 || y < 0 || x >= gray.cols || y >= gray.rows) continue
        keepNext.push([x, y])
        keepRef.push(this.ref[i])
      }
      if (keepNext.length < cfg.minPoints) {
        return { found: false, reason: `flow lost (${keepNext.length} pts)` }
      }

      const m = keepNext.length
      src = cv.matFromArray(m, 1, cv.CV_32FC2, keepRef.flat())
      dst = cv.matFromArray(m, 1, cv.CV_32FC2, keepNext.flatMap(([x, y]) => [x * sx, y * sy]))
      mask = new cv.Mat()
      Hm = cv.findHomography(src, dst, cv.RANSAC, cfg.ransacReprojPx * Math.max(sx, sy), mask)
      const Hr = mat9(Hm)
      if (!finiteH(Hr)) return { found: false, reason: 'flow homography failed' }
      const md = mask.data
      const inNext = []
      const inRef = []
      for (let i = 0; i < m; i++) {
        if (md[i]) {
          inNext.push(keepNext[i])
          inRef.push(keepRef[i])
        }
      }
      if (inNext.length < cfg.minPoints || inNext.length / m < cfg.minInlierRatio) {
        return { found: false, reason: 'flow inconsistent' }
      }

      // Least-squares over all inliers: sub-pixel, jitter-free estimate.
      let H = Hr
      const s2m = cv.matFromArray(inRef.length, 1, cv.CV_32FC2, inRef.flat())
      const d2m = cv.matFromArray(inNext.length, 1, cv.CV_32FC2, inNext.flatMap(([x, y]) => [x * sx, y * sy]))
      try {
        const Hls = cv.findHomography(s2m, d2m, 0)
        const arr = mat9(Hls)
        Hls.delete()
        if (finiteH(arr)) H = arr
      } catch {
        /* keep RANSAC estimate */
      } finally {
        s2m.delete()
        d2m.delete()
      }

      const scale = H[8]
      if (Math.abs(scale) > 1e-12) H = H.map((v) => v / scale)
      this.pts = inNext
      this.ref = inRef
      this.H = H
      return { found: true, H, inliers: inNext.length }
    } finally {
      prevPts.delete()
      nextPts.delete()
      backPts.delete()
      st1.delete()
      st2.delete()
      err1.delete()
      err2.delete()
      src?.delete()
      dst?.delete()
      mask?.delete()
      Hm?.delete()
    }
  }

  /** Make `gray` the reference frame for the next track() call. */
  commit(gray) {
    if (this.prevGray && this.prevGray.rows === gray.rows && this.prevGray.cols === gray.cols) {
      gray.copyTo(this.prevGray)
    } else {
      this.prevGray?.delete()
      this.prevGray = gray.clone()
    }
  }

  dispose() {
    this.reset()
  }
}

/** Project the 4 target corners (TL, TR, BR, BL) through H. */
export const quadFromH = (H, targetW, targetH) => [
  applyH(H, 0, 0),
  applyH(H, targetW - 1, 0),
  applyH(H, targetW - 1, targetH - 1),
  applyH(H, 0, targetH - 1),
]

/** Mean corner distance (px) between two quads. */
export const quadDistance = (a, b) => {
  let s = 0
  for (let i = 0; i < 4; i++) s += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1])
  return s / 4
}
