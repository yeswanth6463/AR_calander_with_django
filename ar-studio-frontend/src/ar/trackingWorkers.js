/**
 * Main-thread client for the two tracking workers.
 *
 *   flow worker   — optical flow on every camera frame (cheap-ish, ordered)
 *   detect worker — ORB detection + matching (slow, async, never blocks a frame)
 *
 * Only one frame and one detection are in flight at a time; extra camera
 * frames are skipped instead of queueing up (no growing latency).
 */
import { OPENCV_URL } from './opencvRuntime'

export const trackingWorkersSupported = () =>
  typeof Worker !== 'undefined' && typeof createImageBitmap === 'function'

const once = (worker, match, timeoutMs, what) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('message', onMsg)
      reject(new Error(`${what} timed out`))
    }, timeoutMs)
    const onMsg = (e) => {
      const msg = e.data || {}
      if (msg.type === 'error' && msg.id == null && msg.frameId == null) {
        clearTimeout(timer)
        worker.removeEventListener('message', onMsg)
        reject(new Error(msg.message))
      } else if (match(msg)) {
        clearTimeout(timer)
        worker.removeEventListener('message', onMsg)
        resolve(msg)
      }
    }
    worker.addEventListener('message', onMsg)
  })

/**
 * @param targets   [{ key, entry?, imageUrl }] — entry = compiled bundle entry
 * @param loadImageData async (imageUrl) => { data, width, height } for targets
 *                  that must be compiled from their image
 * @param drift     { minPx, frac } flow-vs-detection disagreement threshold
 */
export async function startTrackingWorkers({ targets, loadImageData, drift, timeoutMs = 90000 }) {
  const flowWorker = new Worker(new URL('./flowWorker.js', import.meta.url), { type: 'module' })
  const detectWorker = new Worker(new URL('./detectWorker.js', import.meta.url), { type: 'module' })
  const dispose = () => {
    flowWorker.terminate()
    detectWorker.terminate()
  }

  try {
    const known = targets.filter((t) => t.entry).map((t) => ({ key: t.key, width: t.entry.width, height: t.entry.height }))
    // Both workers download/compile OpenCV in parallel.
    const detectReady = once(detectWorker, (m) => m.type === 'ready', timeoutMs, 'Tracker start-up')
    const flowReady = once(flowWorker, (m) => m.type === 'ready', timeoutMs, 'Flow start-up')
    detectWorker.postMessage({ type: 'init', cvUrl: OPENCV_URL, targets: targets.map((t) => ({ key: t.key, entry: t.entry || null })) })
    flowWorker.postMessage({ type: 'init', cvUrl: OPENCV_URL, targets: known, drift })

    const sizes = new Map()
    const ready = await detectReady
    for (const t of ready.targets) {
      if (t.ok) sizes.set(t.key, { width: t.width, height: t.height })
    }
    // Targets missing from (or corrupt in) the compiled bundle: compile from the image.
    for (const t of targets) {
      if (sizes.has(t.key)) continue
      const image = await loadImageData(t.imageUrl)
      const done = once(detectWorker, (m) => m.type === 'compiled' && m.key === t.key, timeoutMs, 'Target compile')
      detectWorker.postMessage({ type: 'compile', key: t.key, image }, [image.data.buffer])
      const res = await done
      if (!res.ok) throw new Error(res.error || 'Target could not be compiled.')
      sizes.set(t.key, { width: res.width, height: res.height })
    }
    flowWorker.postMessage({ type: 'targets', targets: [...sizes].map(([key, s]) => ({ key, ...s })) })
    const { flow, bitmaps: flowBitmaps } = await flowReady
    // Both workers can read ImageBitmaps → the page never calls getImageData.
    const bitmaps = !!(flowBitmaps && ready.bitmaps)

    const listeners = { frame: null, detect: null, error: null }
    let flowBusy = false
    let detectBusy = false
    flowWorker.onmessage = (e) => {
      const msg = e.data || {}
      if (msg.type === 'frame') {
        flowBusy = false
        listeners.frame?.(msg)
      } else if (msg.type === 'error') listeners.error?.(msg.message)
    }
    detectWorker.onmessage = (e) => {
      const msg = e.data || {}
      if (msg.type === 'detect') {
        detectBusy = false
        listeners.detect?.(msg)
      } else if (msg.type === 'error') {
        if (msg.id != null) detectBusy = false
        listeners.error?.(msg.message)
      }
    }
    let detectId = 0

    return {
      flow,
      sizes,
      bitmaps,
      get flowBusy() {
        return flowBusy
      },
      get detectBusy() {
        return detectBusy
      },
      onFrame(fn) {
        listeners.frame = fn
      },
      onDetect(fn) {
        listeners.detect = fn
      },
      onError(fn) {
        listeners.error = fn
      },
      /** Reserve the flow slot before an async capture (prevents double sends). */
      reserveFrame() {
        flowBusy = true
      },
      releaseFrame() {
        flowBusy = false
      },
      reserveDetect() {
        detectBusy = true
      },
      releaseDetect() {
        detectBusy = false
      },
      /**
       * Whole frame scaled to width × height: either `image` (ImageData) or
       * `bitmap` (ImageBitmap, read in the worker). sx/sy = video px per px.
       */
      sendFrame({ frameId, image, bitmap, width, height, sx, sy, videoW, videoH }) {
        flowBusy = true
        const transfer = bitmap ? [bitmap] : [image.data.buffer]
        flowWorker.postMessage({ type: 'frame', frameId, image, bitmap, width, height, sx, sy, videoW, videoH }, transfer)
      },
      detect({ frameId, image, bitmap, width, height, region, keys, locked }) {
        detectBusy = true
        const transfer = bitmap ? [bitmap] : [image.data.buffer]
        detectWorker.postMessage(
          { type: 'detect', id: ++detectId, frameId, image, bitmap, width, height, region, keys, locked },
          transfer
        )
      },
      /** Forward a trusted detection to the flow worker (re-seed / drift fix). */
      sendDetection({ frameId, key, H, corners }) {
        flowWorker.postMessage({ type: 'detection', frameId, key, H, corners })
      },
      dispose,
    }
  } catch (err) {
    dispose()
    throw err
  }
}
