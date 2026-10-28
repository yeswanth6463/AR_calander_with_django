/** Central tracking thresholds — tune here, not at call sites. */
export const TRACK_CONFIG = {
  processWidth: 640,
  targetCompileMaxEdge: 1080,
  targetFeatures: 2500,
  frameFeatures: 1200,
  scaleFactor: 1.2,
  nlevels: 8,
  edgeThreshold: 15,
  firstLevel: 0,
  wtaK: 2,
  patchSize: 31,
  fastThreshold: 7,
  claheClip: 3.0,
  claheTiles: 8,
  ratio: 0.82,
  knnK: 2,
  ransacReproj: 5.0,
  minRatioMatches: 6,
  minInliers: 7,
  minInliersLocked: 5,
  minInlierRatio: 0.14,
  minInlierRatioLocked: 0.1,
  minSpreadCells: 1,
  maxReprojError: 8.0,
  minQuadAreaFrac: 0.0004,
  maxQuadAreaFrac: 4.0,
  minQuadPixelArea: 35 * 35,
  minAngleDeg: 20,
  maxAngleDeg: 160,
  boundsMarginFrac: 0.5,
  minAspectRel: 0.15,
  maxAspectRel: 6.0,
  roiPad: 0.5,
  minRoiFrac: 0.06,
  get debug() {
    try {
      return localStorage.getItem('arTrackerDebug') === '1'
    } catch {
      return false
    }
  },
}

const compileCache = new Map()
const COMPILE_CACHE_MAX = 16

let runtime = null
let lastDiagAt = 0
const diag = {
  frames: 0,
  lastMs: 0,
  avgMs: 0,
  camW: 0,
  camH: 0,
  frameKps: 0,
  refKps: 0,
  ratioMatches: 0,
  inliers: 0,
  inlierRatio: 0,
  rejects: {},
  state: 'idle',
}

const bumpReject = (reason) => {
  diag.rejects[reason] = (diag.rejects[reason] || 0) + 1
}

const maybeLogDiag = () => {
  if (!TRACK_CONFIG.debug) return
  const now = performance.now()
  if (now - lastDiagAt < 2000) return
  lastDiagAt = now
  console.info('[AR tracker]', { ...diag, rejects: { ...diag.rejects } })
}

export const getTrackerDiagnostics = () => ({ ...diag, rejects: { ...diag.rejects } })

const vecSize = (v) => {
  if (!v) return 0
  try {
    if (typeof v.size === 'function') return v.size()
    if (typeof v.size === 'number') return v.size
  } catch {
    /* native handle already deleted */
  }
  return 0
}

const mat9 = (H) => {
  if (!H) return null
  const d64 = H.data64F
  if (d64 && d64.length >= 9) return [d64[0], d64[1], d64[2], d64[3], d64[4], d64[5], d64[6], d64[7], d64[8]]
  const d32 = H.data32F
  if (d32 && d32.length >= 9) return [d32[0], d32[1], d32[2], d32[3], d32[4], d32[5], d32[6], d32[7], d32[8]]
  return null
}

const homographyFinite = (H) => {
  const m = Array.isArray(H) ? H : mat9(H)
  if (!m || m.length < 9) return false
  if (m.some((v) => !Number.isFinite(v))) return false
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
  return Math.abs(det) > 1e-8
}

const applyH = (H, x, y) => {
  const w = H[6] * x + H[7] * y + H[8]
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return [NaN, NaN]
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]
}

const dist2 = (a, b) => {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

const hypot = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1])

export function createOrb(nfeatures, options = {}) {
  const n = nfeatures ?? TRACK_CONFIG.targetFeatures
  const scaleFactor = options.scaleFactor ?? TRACK_CONFIG.scaleFactor
  const nlevels = options.nlevels ?? TRACK_CONFIG.nlevels
  const edgeThreshold = options.edgeThreshold ?? TRACK_CONFIG.edgeThreshold
  const firstLevel = options.firstLevel ?? TRACK_CONFIG.firstLevel
  const wtaK = options.wtaK ?? TRACK_CONFIG.wtaK
  const scoreType = typeof cv.ORB_HARRIS_SCORE === 'number' ? cv.ORB_HARRIS_SCORE : 0
  const patchSize = options.patchSize ?? TRACK_CONFIG.patchSize
  const fastThreshold = options.fastThreshold ?? TRACK_CONFIG.fastThreshold
  const args = [n, scaleFactor, nlevels, edgeThreshold, firstLevel, wtaK, scoreType, patchSize, fastThreshold]

  const tryCreate = (fn) => {
    try {
      return fn(...args)
    } catch {
      try {
        return fn(n)
      } catch {
        return null
      }
    }
  }

  if (typeof cv.ORB_create === 'function') {
    const orb = tryCreate((...a) => cv.ORB_create(...a))
    if (orb) return orb
  }
  if (typeof cv.ORB === 'function') {
    const orb = tryCreate((...a) => new cv.ORB(...a))
    if (orb) return orb
  }
  throw new Error('OpenCV ORB is not available')
}

const createClahe = () => {
  const tiles = new cv.Size(TRACK_CONFIG.claheTiles, TRACK_CONFIG.claheTiles)
  if (typeof cv.createCLAHE === 'function') {
    try {
      return cv.createCLAHE(TRACK_CONFIG.claheClip, tiles)
    } catch {
      /* fall through */
    }
  }
  if (typeof cv.CLAHE === 'function') {
    try {
      return new cv.CLAHE(TRACK_CONFIG.claheClip, tiles)
    } catch {
      try {
        return new cv.CLAHE()
      } catch {
        return null
      }
    }
  }
  return null
}

const ensureRuntime = () => {
  if (runtime) return runtime
  if (typeof cv === 'undefined' || typeof cv.Mat !== 'function') {
    throw new Error('OpenCV is not initialized')
  }
  runtime = {
    emptyMask: new cv.Mat(),
    clahe: createClahe(),
    orbFrame: createOrb(TRACK_CONFIG.frameFeatures),
    orbTarget: createOrb(TRACK_CONFIG.targetFeatures),
    matcher: new cv.BFMatcher(cv.NORM_HAMMING, false),
    gray: new cv.Mat(),
    enhanced: new cv.Mat(),
    canvas: document.createElement('canvas'),
    ctx: null,
  }
  runtime.canvas.width = TRACK_CONFIG.processWidth
  runtime.ctx = runtime.canvas.getContext('2d', { willReadFrequently: true })
  return runtime
}

export function releaseTrackerRuntime() {
  for (const compiled of compileCache.values()) {
    try {
      compiled.desc?.delete()
    } catch {
      /* already released */
    }
  }
  compileCache.clear()
  if (!runtime) return
  try {
    runtime.emptyMask?.delete()
    runtime.clahe?.delete?.()
    runtime.orbFrame?.delete()
    runtime.orbTarget?.delete()
    runtime.matcher?.delete()
    runtime.gray?.delete()
    runtime.enhanced?.delete()
  } catch {
    /* already released */
  }
  runtime = null
}

const preprocessGray = (rgba, grayOut, enhancedOut, clahe) => {
  cv.cvtColor(rgba, grayOut, cv.COLOR_RGBA2GRAY)
  if (clahe && typeof clahe.apply === 'function') {
    clahe.apply(grayOut, enhancedOut)
    return enhancedOut
  }
  return grayOut
}

const compileKeyOf = (source) => {
  const src = source.src || source.currentSrc || ''
  const w = source.videoWidth || source.naturalWidth || source.width || 0
  const h = source.videoHeight || source.naturalHeight || source.height || 0
  return src ? `src:${src}` : `px:${w}x${h}`
}

const readKeypoints = (kps) => {
  const n = vecSize(kps)
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const kp = kps.get(i)
    out[i] = { x: kp.pt.x, y: kp.pt.y }
  }
  return out
}

/**
 * Convex, finite, reasonably sized quadrilateral in frame pixels.
 * Corner order is TL, TR, BR, BL (same as the projected reference corners).
 */
export function validateProjectedQuad(corners, frameW, frameH, targetW, targetH, config = TRACK_CONFIG) {
  if (!corners || corners.length !== 4) return { ok: false, reason: 'quad count' }
  for (const c of corners) {
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
      return { ok: false, reason: 'non-finite corner' }
    }
  }

  const margin = config.boundsMarginFrac * Math.max(frameW, frameH)
  for (const c of corners) {
    if (c[0] < -margin || c[1] < -margin || c[0] > frameW + margin || c[1] > frameH + margin) {
      return { ok: false, reason: 'out of bounds' }
    }
  }

  const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const cross = area2(corners[i], corners[(i + 1) % 4], corners[(i + 2) % 4])
    if (Math.abs(cross) < 1e-4) return { ok: false, reason: 'collapsed edge' }
    const s = Math.sign(cross)
    if (!sign) sign = s
    else if (s !== sign) return { ok: false, reason: 'not convex' }
  }

  const area =
    0.5 *
    Math.abs(
      corners.reduce((sum, c, i) => {
        const n = corners[(i + 1) % 4]
        return sum + c[0] * n[1] - n[0] * c[1]
      }, 0)
    )
  const frameArea = Math.max(frameW * frameH, 1)
  if (area < config.minQuadPixelArea || area < config.minQuadAreaFrac * frameArea) {
    return { ok: false, reason: 'too small' }
  }
  if (area > config.maxQuadAreaFrac * frameArea) {
    return { ok: false, reason: 'too large' }
  }

  for (let i = 0; i < 4; i++) {
    const p = corners[i]
    const prev = corners[(i + 3) % 4]
    const next = corners[(i + 1) % 4]
    const v1 = [p[0] - prev[0], p[1] - prev[1]]
    const v2 = [next[0] - p[0], next[1] - p[1]]
    const cross = v1[0] * v2[1] - v1[1] * v2[0]
    const dot = v1[0] * v2[0] + v1[1] * v2[1]
    const angle = Math.abs(Math.atan2(cross, dot)) * (180 / Math.PI)
    if (angle < config.minAngleDeg || angle > config.maxAngleDeg) {
      return { ok: false, reason: 'angle' }
    }
  }

  const w = (hypot(corners[0], corners[1]) + hypot(corners[3], corners[2])) / 2
  const h = (hypot(corners[0], corners[3]) + hypot(corners[1], corners[2])) / 2
  if (w < 8 || h < 8) return { ok: false, reason: 'degenerate size' }
  const projAspect = w / h
  const refAspect = Math.max(targetW, 1) / Math.max(targetH, 1)
  const rel = projAspect / refAspect
  if (rel < config.minAspectRel || rel > config.maxAspectRel) {
    return { ok: false, reason: 'aspect' }
  }

  return { ok: true, area, reason: 'ok' }
}

const spreadCells = (pts, tw, th) => {
  const cells = new Set()
  const w = Math.max(tw, 1)
  const h = Math.max(th, 1)
  for (const p of pts) {
    const cx = p[0] < w * 0.5 ? 0 : 1
    const cy = p[1] < h * 0.5 ? 0 : 2
    cells.add(cx + cy)
  }
  return cells.size
}

const meanReprojError = (H, srcPts, dstPts) => {
  let sum = 0
  for (let i = 0; i < srcPts.length; i++) {
    const p = applyH(H, srcPts[i][0], srcPts[i][1])
    sum += Math.sqrt(dist2(p, dstPts[i]))
  }
  return srcPts.length ? sum / srcPts.length : Infinity
}

const countInliersFromMask = (mask) => {
  try {
    if (!mask || (typeof mask.empty === 'function' && mask.empty())) return 0
    const data = mask.data
    if (!data || !data.length) return 0
    let n = 0
    for (let i = 0; i < data.length; i++) if (data[i]) n++
    return n
  } catch {
    return 0
  }
}

const inliersByReproj = (H, srcPts, dstPts, thresh) => {
  const t2 = thresh * thresh
  const keep = []
  for (let i = 0; i < srcPts.length; i++) {
    const p = applyH(H, srcPts[i][0], srcPts[i][1])
    if (Number.isFinite(p[0]) && dist2(p, dstPts[i]) <= t2) keep.push(i)
  }
  return keep
}

const uniqueMatches = (pairs, maxMatches = 200) => {
  pairs.sort((a, b) => a.distance - b.distance)
  const usedQ = new Set()
  const usedT = new Set()
  const out = []
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]
    if (usedQ.has(p.queryIdx) || usedT.has(p.trainIdx)) continue
    usedQ.add(p.queryIdx)
    usedT.add(p.trainIdx)
    out.push(p)
    if (out.length >= maxMatches) break
  }
  return out
}

const ratioMatches = (matcher, queryDesc, trainDesc, frameKps, targetKps, ratio) => {
  if (!queryDesc || !trainDesc || queryDesc.rows < 4 || trainDesc.rows < 4) {
    return []
  }
  const pairs = []
  const knn = new cv.DMatchVectorVector()
  try {
    matcher.knnMatch(queryDesc, trainDesc, knn, TRACK_CONFIG.knnK)
    const n = vecSize(knn)
    const nQ = vecSize(frameKps)
    const nT = targetKps.length
    for (let i = 0; i < n; i++) {
      const pair = knn.get(i)
      try {
        if (vecSize(pair) < 2) continue
        const m = pair.get(0)
        const alt = pair.get(1)
        if (!m || !alt) continue
        if (!(m.distance < ratio * alt.distance)) continue
        if (m.queryIdx < 0 || m.trainIdx < 0 || m.queryIdx >= nQ || m.trainIdx >= nT) continue
        pairs.push({ queryIdx: m.queryIdx, trainIdx: m.trainIdx, distance: m.distance })
      } finally {
        pair.delete()
      }
    }
  } catch {
    const matches = new cv.DMatchVector()
    try {
      matcher.match(queryDesc, trainDesc, matches)
      const n = vecSize(matches)
      const nQ = vecSize(frameKps)
      const nT = targetKps.length
      for (let i = 0; i < n; i++) {
        const m = matches.get(i)
        if (m.queryIdx < 0 || m.trainIdx < 0 || m.queryIdx >= nQ || m.trainIdx >= nT) continue
        pairs.push({ queryIdx: m.queryIdx, trainIdx: m.trainIdx, distance: m.distance })
      }
    } finally {
      matches.delete()
    }
  } finally {
    knn.delete()
  }
  return uniqueMatches(pairs, 200)
}

const findHomographyMasked = (src, dst) => {
  let mask = new cv.Mat()
  try {
    const H = cv.findHomography(src, dst, cv.RANSAC, TRACK_CONFIG.ransacReproj, mask)
    return { H, mask }
  } catch {
    mask.delete()
    mask = null
    const H = cv.findHomography(src, dst, cv.RANSAC, TRACK_CONFIG.ransacReproj)
    return { H, mask }
  }
}

export function paddedRoiFromCorners(corners, frameW, frameH, pad = TRACK_CONFIG.roiPad) {
  if (!corners?.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of corners) {
    minX = Math.min(minX, c[0])
    minY = Math.min(minY, c[1])
    maxX = Math.max(maxX, c[0])
    maxY = Math.max(maxY, c[1])
  }
  const bw = Math.max(maxX - minX, 16)
  const bh = Math.max(maxY - minY, 16)
  const px = bw * pad
  const py = bh * pad
  const x = Math.max(0, Math.floor(minX - px))
  const y = Math.max(0, Math.floor(minY - py))
  const w = Math.min(frameW - x, Math.ceil(bw + px * 2))
  const h = Math.min(frameH - y, Math.ceil(bh + py * 2))
  if (w < 32 || h < 32) return null
  if (w * h < TRACK_CONFIG.minRoiFrac * frameW * frameH) return null
  return { x, y, w, h }
}

export const extractFrame = (video, frameFeaturesOrOpts) => {
  const opts =
    typeof frameFeaturesOrOpts === 'number'
      ? { frameFeatures: frameFeaturesOrOpts }
      : frameFeaturesOrOpts || {}
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const t0 = performance.now()
  const rt = ensureRuntime()
  const roi = opts.roi
  const srcX = roi ? roi.x : 0
  const srcY = roi ? roi.y : 0
  const srcW = roi ? roi.w : vw
  const srcH = roi ? roi.h : vh
  const scale = Math.min(1, TRACK_CONFIG.processWidth / srcW)
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))

  if (rt.canvas.width !== w || rt.canvas.height !== h) {
    rt.canvas.width = w
    rt.canvas.height = h
  }
  rt.ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, w, h)

  const rgba = cv.imread(rt.canvas)
  let keypoints
  let descriptors
  try {
    const processed = preprocessGray(rgba, rt.gray, rt.enhanced, rt.clahe)
    keypoints = new cv.KeyPointVector()
    descriptors = new cv.Mat()
    rt.orbFrame.detectAndCompute(processed, rt.emptyMask, keypoints, descriptors)
  } finally {
    rgba.delete()
  }

  const sx = srcW / w
  const sy = srcH / h
  diag.camW = vw
  diag.camH = vh
  diag.frameKps = vecSize(keypoints)
  diag.lastMs = performance.now() - t0

  return {
    scale,
    width: vw,
    height: vh,
    keypoints,
    descriptors,
    roi: roi || null,
    toVideo: (x, y) => [srcX + x * sx, srcY + y * sy],
    dispose() {
      try {
        keypoints?.delete()
        descriptors?.delete()
      } catch {
        /* already deleted */
      }
    },
  }
}

export class ImageTracker {
  constructor({
    targetFeatures = TRACK_CONFIG.targetFeatures,
    frameFeatures = TRACK_CONFIG.frameFeatures,
    ratio = TRACK_CONFIG.ratio,
    minMatches = TRACK_CONFIG.minInliers,
  } = {}) {
    this.targetFeatures = targetFeatures
    this.frameFeatures = frameFeatures
    this.ratio = ratio
    this.minMatches = minMatches
    this.targetKeypoints = []
    this.trainDesc = null
    this.targetW = 0
    this.targetH = 0
    this._cacheKey = ''
    this._work = document.createElement('canvas')
    this._work.width = 640
  }

  get ready() {
    return this.trainDesc !== null && this.targetKeypoints.length > 0
  }

  _adopt(compiled, key) {
    if (this.trainDesc) this.trainDesc.delete()
    this.trainDesc = compiled.desc.clone()
    this.targetKeypoints = compiled.keypoints
    this.targetW = compiled.width
    this.targetH = compiled.height
    this._cacheKey = key
  }

  compile(source) {
    const sw = source.videoWidth || source.naturalWidth || source.width
    const sh = source.videoHeight || source.naturalHeight || source.height
    if (!sw || !sh) throw new Error('Target has no size.')

    const key = compileKeyOf(source)
    if (this._cacheKey === key && this.ready) {
      return { features: this.targetKeypoints.length, width: this.targetW, height: this.targetH }
    }
    const cached = compileCache.get(key)
    if (cached) {
      this._adopt(cached, key)
      diag.refKps = this.targetKeypoints.length
      return { features: this.targetKeypoints.length, width: this.targetW, height: this.targetH }
    }

    const rt = ensureRuntime()
    const scale = Math.min(1, TRACK_CONFIG.targetCompileMaxEdge / Math.max(sw, sh))
    this.targetW = Math.round(sw * scale)
    this.targetH = Math.round(sh * scale)
    this._work.width = this.targetW
    this._work.height = this.targetH

    const ctx = this._work.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(source, 0, 0, this.targetW, this.targetH)

    const mat = cv.imread(this._work)
    const gray = new cv.Mat()
    const enhanced = new cv.Mat()
    const kps = new cv.KeyPointVector()
    const desc = new cv.Mat()
    try {
      const processed = preprocessGray(mat, gray, enhanced, rt.clahe)
      rt.orbTarget.detectAndCompute(processed, rt.emptyMask, kps, desc)
      if (desc.rows < this.minMatches || vecSize(kps) < this.minMatches) {
        throw new Error('Too few features — use a more detailed image.')
      }
      const keypoints = readKeypoints(kps)
      if (this.trainDesc) this.trainDesc.delete()
      this.trainDesc = desc.clone()
      this.targetKeypoints = keypoints
      this._cacheKey = key
      if (compileCache.size >= COMPILE_CACHE_MAX) {
        const first = compileCache.keys().next().value
        compileCache.get(first)?.desc?.delete()
        compileCache.delete(first)
      }
      compileCache.set(key, {
        width: this.targetW,
        height: this.targetH,
        keypoints,
        desc: desc.clone(),
      })
      diag.refKps = keypoints.length
      return { features: keypoints.length, width: this.targetW, height: this.targetH }
    } finally {
      mat.delete()
      gray.delete()
      enhanced.delete()
      kps.delete()
      desc.delete()
    }
  }

  matchFrame(frame, { locked = false } = {}) {
    if (!this.ready) return { found: false, reason: 'not ready' }
    if (!frame?.descriptors || frame.descriptors.rows < TRACK_CONFIG.minRatioMatches) {
      bumpReject('no features in frame')
      return { found: false, reason: 'no features in frame' }
    }

    const minInliers = locked ? TRACK_CONFIG.minInliersLocked : TRACK_CONFIG.minInliers
    const minRatio = locked ? TRACK_CONFIG.minInlierRatioLocked : TRACK_CONFIG.minInlierRatio
    const rt = ensureRuntime()
    const goods = ratioMatches(
      rt.matcher,
      frame.descriptors,
      this.trainDesc,
      frame.keypoints,
      this.targetKeypoints,
      this.ratio
    )
    diag.ratioMatches = goods.length
    diag.refKps = this.targetKeypoints.length

    if (goods.length < 4) {
      bumpReject(`only ${goods.length} matches`)
      return { found: false, reason: `only ${goods.length} matches`, matchCount: goods.length }
    }

    const numGoods = goods.length
    const srcFlat = new Float32Array(numGoods * 2)
    const dstFlat = new Float32Array(numGoods * 2)
    const srcPts = new Array(numGoods)
    const dstPts = new Array(numGoods)
    for (let i = 0; i < numGoods; i++) {
      const m = goods[i]
      const tp = this.targetKeypoints[m.trainIdx]
      const fp = frame.keypoints.get(m.queryIdx).pt
      const [vx, vy] = frame.toVideo(fp.x, fp.y)
      srcPts[i] = [tp.x, tp.y]
      dstPts[i] = [vx, vy]
      srcFlat[i * 2] = tp.x
      srcFlat[i * 2 + 1] = tp.y
      dstFlat[i * 2] = vx
      dstFlat[i * 2 + 1] = vy
    }

    const src = cv.matFromArray(numGoods, 1, cv.CV_32FC2, srcFlat)
    const dst = cv.matFromArray(numGoods, 1, cv.CV_32FC2, dstFlat)
    let Hmat = null
    let mask = null
    try {
      const found = findHomographyMasked(src, dst)
      Hmat = found.H
      mask = found.mask
      const H = mat9(Hmat)
      if (!H || !homographyFinite(H)) {
        bumpReject('homography failed')
        return { found: false, reason: 'homography failed', matchCount: goods.length }
      }

      let inlierIdx = []
      const masked = countInliersFromMask(mask)
      if (masked > 0 && mask?.data) {
        const data = mask.data
        for (let i = 0; i < srcPts.length; i++) if (data[i]) inlierIdx.push(i)
      } else {
        inlierIdx = inliersByReproj(H, srcPts, dstPts, TRACK_CONFIG.ransacReproj)
      }
      const inliers = inlierIdx.length
      const inlierRatio = inliers / goods.length
      diag.inliers = inliers
      diag.inlierRatio = inlierRatio
      const srcIn = inlierIdx.map((i) => srcPts[i])
      const dstIn = inlierIdx.map((i) => dstPts[i])
      const reproj = meanReprojError(H, srcIn.length ? srcIn : srcPts, dstIn.length ? dstIn : dstPts)
      const cells = spreadCells(srcIn.length ? srcIn : srcPts, this.targetW, this.targetH)

      if (inliers < minInliers || inlierRatio < minRatio) {
        bumpReject('weak inliers')
        return {
          found: false,
          reason: 'weak inliers',
          matchCount: goods.length,
          inliers,
          inlierRatio,
        }
      }
      if (reproj > TRACK_CONFIG.maxReprojError) {
        bumpReject('reproj')
        return { found: false, reason: 'reproj', matchCount: goods.length, inliers, reprojError: reproj }
      }
      if (cells < TRACK_CONFIG.minSpreadCells) {
        bumpReject('clustered')
        return { found: false, reason: 'clustered', matchCount: goods.length, inliers }
      }

      const tw1 = this.targetW - 1
      const th1 = this.targetH - 1
      const corners = [
        applyH(H, 0, 0),
        applyH(H, tw1, 0),
        applyH(H, tw1, th1),
        applyH(H, 0, th1),
      ]
      const geom = validateProjectedQuad(corners, frame.width, frame.height, this.targetW, this.targetH)
      if (!geom.ok) {
        bumpReject(geom.reason)
        return { found: false, reason: geom.reason, matchCount: goods.length, inliers }
      }

      const confidence = inlierRatio * Math.min(inliers / 20, 1) * Math.min(cells / 4, 1)
      return {
        found: true,
        corners,
        H,
        matchCount: goods.length,
        inliers,
        inlierRatio,
        reprojError: reproj,
        confidence,
        spread: cells,
      }
    } finally {
      src.delete()
      dst.delete()
      Hmat?.delete()
      mask?.delete()
    }
  }

  track(video) {
    const frame = extractFrame(video, this.frameFeatures)
    if (!frame) return { found: false, reason: 'not ready' }
    try {
      return this.matchFrame(frame)
    } finally {
      frame.dispose()
    }
  }

  dispose() {
    try {
      this.trainDesc?.delete()
    } catch {
      /* already deleted */
    }
    this.trainDesc = null
    this.targetKeypoints = []
    this._cacheKey = ''
  }
}

export function noteTrackerTiming(frameMs, state) {
  diag.frames += 1
  diag.lastMs = frameMs
  diag.avgMs = diag.avgMs ? diag.avgMs * 0.9 + frameMs * 0.1 : frameMs
  diag.state = state
  maybeLogDiag()
}
