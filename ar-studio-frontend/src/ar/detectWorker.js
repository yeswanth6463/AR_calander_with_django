/**
 * Detect worker: ORB feature detection + matching against the image targets
 * (the expensive part of tracking, ~100+ ms per frame on phones), kept off
 * the main thread so rendering never waits for it.
 *
 * Messages in:
 *   { type: 'init', cvUrl, targets: [{ key, entry? }] }    entry = compiled bundle entry
 *   { type: 'compile', key, image: { data, width, height } } targets missing from the bundle
 *   { type: 'detect', id, frameId, image, region, keys, locked }
 *       image  = RGBA { data, width, height } of `region` of the camera frame
 *       region = { srcX, srcY, srcW, srcH, videoW, videoH }
 * Messages out:
 *   { type: 'ready', targets: [{ key, width, height, ok, error }] } | { type: 'error', message }
 *   { type: 'compiled', key, width, height, ok, error }
 *   { type: 'detect', id, frameId, key, found, corners, H, diag }
 */
import { loadOpenCvInWorker } from './opencvRuntime'
import { ImageTracker, frameFromImageData, getTrackerDiagnostics } from './tracker'
import { bitmapToImageData, canReadBitmaps } from './workerPixels'

const trackers = new Map()

const describe = (key, tracker, error) => ({
  key,
  ok: !error && tracker.ready,
  width: tracker.targetW,
  height: tracker.targetH,
  error: error ? String(error.message || error) : '',
})

self.onmessage = async (e) => {
  const msg = e.data || {}
  try {
    if (msg.type === 'init') {
      await loadOpenCvInWorker(msg.cvUrl)
      const out = []
      for (const t of msg.targets || []) {
        const tracker = new ImageTracker()
        trackers.set(t.key, tracker)
        if (!t.entry) {
          out.push({ key: t.key, ok: false, pending: true })
          continue
        }
        try {
          tracker.loadCompiled(t.entry)
          out.push(describe(t.key, tracker))
        } catch (err) {
          out.push({ ...describe(t.key, tracker, err), pending: true })
        }
      }
      self.postMessage({ type: 'ready', targets: out, bitmaps: canReadBitmaps() })
    } else if (msg.type === 'compile') {
      const tracker = trackers.get(msg.key) || new ImageTracker()
      trackers.set(msg.key, tracker)
      try {
        tracker.compileImageData(msg.image)
        self.postMessage({ type: 'compiled', ...describe(msg.key, tracker) })
      } catch (err) {
        self.postMessage({ type: 'compiled', ...describe(msg.key, tracker, err) })
      }
    } else if (msg.type === 'detect') {
      const image = msg.bitmap ? bitmapToImageData(msg.bitmap, msg.width, msg.height) : msg.image
      const frame = frameFromImageData(image, msg.region)
      let best = null
      try {
        for (const key of msg.keys || []) {
          const tracker = trackers.get(key)
          if (!tracker?.ready) continue
          const r = tracker.matchFrame(frame, { locked: !!msg.locked })
          if (r.found && (!best || (r.confidence || 0) > (best.r.confidence || 0))) best = { key, r }
        }
      } finally {
        frame.dispose()
      }
      self.postMessage({
        type: 'detect',
        id: msg.id,
        frameId: msg.frameId,
        key: best?.key ?? null,
        found: !!best,
        corners: best?.r.corners ?? null,
        H: best?.r.H ?? null,
        diag: getTrackerDiagnostics(),
      })
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, frameId: msg.frameId, message: String(err?.message || err) })
  }
}
