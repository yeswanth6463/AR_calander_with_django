/** Camera helpers shared by the marker and free-model AR viewers. */

export async function applySupportedFocus(track) {
  if (!track) return
  try {
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
    const modes = caps.focusMode
    if (Array.isArray(modes) && modes.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
    }
  } catch {
    // Autofocus is device/browser specific; tracking continues without it.
  }
}

/** Rear camera, with graceful fallbacks for browsers that reject `advanced`. */
export async function startCamera() {
  const video = {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { ...video, advanced: [{ focusMode: 'continuous' }] },
      audio: false,
    })
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
  }
  await applySupportedFocus(stream.getVideoTracks()[0])
  return stream
}

/** Resolve once the video element has real dimensions and can play. */
export function waitForVideo(video) {
  return new Promise((resolve, reject) => {
    if (video.videoWidth && video.videoHeight) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Camera timed out before producing a frame'))
    }, 8000)
    const onReady = () => {
      cleanup()
      if (video.videoWidth && video.videoHeight) resolve()
      else reject(new Error('Camera produced an empty video stream'))
    }
    const onError = () => {
      cleanup()
      reject(new Error('Camera failed to start'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onReady)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('loadedmetadata', onReady)
    video.addEventListener('error', onError)
  })
}
