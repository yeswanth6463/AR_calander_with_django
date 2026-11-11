/**
 * Flow worker: frame-to-frame KLT optical flow for the locked target (one at
 * a time), off the main thread.
 *
 * Detection runs in a separate worker and is slower than a frame, so its
 * results refer to an OLDER frame. This worker keeps the last RING_SIZE
 * grayscale frames; a detection for frame N re-seeds the flow on frame N and
 * then follows it forward to the newest frame, so a late detection still
 * lands exactly on the current image.
 *
 * Messages in:
 *   { type: 'init', cvUrl, targets: [{ key, width, height }], drift: { minPx, frac } }
 *   { type: 'targets', targets: [...] }               (late-compiled targets)
 *   { type: 'frame', frameId, image: { data, width, height }, sx, sy, videoW, videoH }
 *       image = whole camera frame scaled down; sx/sy = video px per image px
 *   { type: 'detection', frameId, key, H, corners }   trusted detection result
 *   { type: 'reset' }
 * Messages out:
 *   { type: 'ready', flow }  (flow = false: this OpenCV build has no KLT)
 *   { type: 'frame', frameId, results: [{ key, found, corners, H, viaFlow }], ms }
 *   { type: 'error', message }
 */
import { loadOpenCvInWorker } from './opencvRuntime'
import { FlowTracker, FLOW_CONFIG, flowSupported, quadFromH, quadDistance } from './flowTracker'
import { validateProjectedQuad } from './tracker'
import { bitmapToImageData, canReadBitmaps } from './workerPixels'

const RING_SIZE = 30

const targets = new Map() // key → { width, height }
const flows = new Map() // key → FlowTracker
const ring = new Map() // frameId → { gray, sx, sy, corners }
let latestId = null
let active = null
let supported = false
let drift = { minPx: 5, frac: 0.02 }
// Diagnostics, sent with every frame result (cheap counters).
const stats = { frames: 0, flowLost: 0, detections: 0, agreed: 0, carried: 0, carryFailed: 0, carrySteps: 0 }

const setTargets = (list) => {
  for (const t of list || []) {
    if (t?.key == null || !t.width || !t.height) continue
    targets.set(t.key, { width: t.width, height: t.height })
    if (!flows.has(t.key)) flows.set(t.key, new FlowTracker())
  }
}

const remember = (frameId, entry) => {
  ring.set(frameId, entry)
  latestId = frameId
  while (ring.size > RING_SIZE) {
    const oldest = ring.keys().next().value
    ring.get(oldest)?.gray?.delete()
    ring.delete(oldest)
  }
}

const deactivate = () => {
  if (active != null) flows.get(active)?.reset()
  active = null
}

function onFrame(msg) {
  const t0 = performance.now()
  if (!supported) {
    msg.bitmap?.close?.()
    self.postMessage({ type: 'frame', frameId: msg.frameId, results: [], ms: 0 })
    return
  }
  const image = msg.bitmap ? bitmapToImageData(msg.bitmap, msg.width, msg.height) : msg.image
  const rgba = cv.matFromImageData(image)
  const gray = new cv.Mat()
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
  } finally {
    rgba.delete()
  }
  const entry = { gray, sx: msg.sx, sy: msg.sy, corners: null }
  remember(msg.frameId, entry)

  stats.frames++
  const results = []
  if (active != null) {
    const flow = flows.get(active)
    const t = targets.get(active)
    const f = flow?.active ? flow.track(gray, msg.sx, msg.sy) : { found: false }
    let corners = null
    if (f.found) {
      corners = quadFromH(f.H, t.width, t.height)
      if (!validateProjectedQuad(corners, msg.videoW, msg.videoH, t.width, t.height).ok) corners = null
    }
    if (corners) {
      // Top up points lost to occlusion / leaving the frame, then advance.
      if (flow.count < FLOW_CONFIG.reseedBelow) flow.seed(gray, f.H, t.width, t.height, msg.sx, msg.sy)
      flow.commit(gray)
      entry.corners = corners
      results.push({ key: active, found: true, corners, H: f.H, viaFlow: true })
    } else {
      stats.flowLost++
      deactivate()
    }
  }
  self.postMessage({ type: 'frame', frameId: msg.frameId, results, ms: performance.now() - t0, stats })
}

function onDetection(msg) {
  if (!supported) return
  const t = targets.get(msg.key)
  const flow = flows.get(msg.key)
  const at = ring.get(msg.frameId) || ring.get(latestId)
  if (!t || !flow || !at || !msg.H) return
  stats.detections++

  if (active === msg.key && at.corners && msg.corners) {
    const c = at.corners
    const edge = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1])
    // Detection agrees with where the flow was on that frame: keep flowing.
    if (quadDistance(msg.corners, c) <= Math.max(drift.minPx, drift.frac * edge)) {
      stats.agreed++
      return
    }
  }

  // New lock, or the flow drifted: restart it from the detection frame and
  // carry it forward to the newest frame.
  if (active != null && active !== msg.key) deactivate()
  flow.reseed(at.gray, msg.H, t.width, t.height, at.sx, at.sy)
  const latest = ring.get(latestId)
  if (latest && latest !== at) {
    stats.carrySteps += 1
    const f = flow.track(latest.gray, latest.sx, latest.sy)
    if (!f.found) {
      stats.carryFailed++
      flow.reset()
      if (active === msg.key) active = null
      return
    }
    flow.commit(latest.gray)
  }
  stats.carried++
  active = msg.key
}

self.onmessage = async (e) => {
  const msg = e.data || {}
  try {
    if (msg.type === 'init') {
      await loadOpenCvInWorker(msg.cvUrl)
      supported = flowSupported()
      if (msg.drift) drift = msg.drift
      setTargets(msg.targets)
      self.postMessage({ type: 'ready', flow: supported, bitmaps: canReadBitmaps() })
    } else if (msg.type === 'targets') {
      setTargets(msg.targets)
    } else if (msg.type === 'frame') {
      onFrame(msg)
    } else if (msg.type === 'detection') {
      onDetection(msg)
    } else if (msg.type === 'reset') {
      deactivate()
    }
  } catch (err) {
    if (msg.type === 'frame') self.postMessage({ type: 'frame', frameId: msg.frameId, results: [], ms: 0 })
    self.postMessage({ type: 'error', message: String(err?.message || err) })
  }
}
