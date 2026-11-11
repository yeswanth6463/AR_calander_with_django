/**
 * OpenCV.js loading for the AR viewer.
 *
 * The viewer runs OpenCV inside Web Workers (see trackingWorkers.js); the
 * main thread only loads it as a fallback when workers are unavailable.
 * Keep the version in sync with what the tracker was tuned against.
 */
export const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js'

const ready = (cv) =>
  !!cv && typeof cv.Mat === 'function' && typeof cv.findHomography === 'function' && typeof cv.matFromImageData === 'function'

/**
 * Resolve once `scope.cv` is a usable OpenCV module. opencv.js may expose a
 * Promise / thenable first and the real module later.
 */
function waitForModule(scope, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let hooked = false
    const check = () => {
      const cv = scope.cv
      if (ready(cv)) return resolve(cv)
      if (cv && typeof cv.then === 'function' && !hooked) {
        hooked = true
        // Callback form on purpose: resolving a Promise with a thenable
        // module would recurse.
        cv.then((mod) => {
          if (ready(mod)) scope.cv = mod
        })
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('OpenCV did not initialise in time.'))
      setTimeout(check, 30)
    }
    check()
  })
}

/** Inside a (module) Worker: download + evaluate opencv.js in global scope. */
export async function loadOpenCvInWorker(url = OPENCV_URL, timeoutMs = 60000) {
  if (!ready(self.cv)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`OpenCV download failed (${res.status}).`)
    const code = await res.text()
    // Indirect eval = global scope, like a classic <script>; module workers
    // cannot use importScripts(). The URL is a pinned CDN build.
    // oxlint-disable-next-line no-eval
    ;(0, eval)(code)
  }
  return waitForModule(self, timeoutMs)
}

/** Main-thread fallback: inject the script tag once and wait for it. */
export function loadOpenCvOnPage(url = OPENCV_URL, timeoutMs = 60000) {
  if (!ready(window.cv) && !document.querySelector('script[data-opencv]')) {
    const s = document.createElement('script')
    s.src = url
    s.async = true
    s.dataset.opencv = '1'
    document.head.appendChild(s)
  }
  return waitForModule(window, timeoutMs)
}
