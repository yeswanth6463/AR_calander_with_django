/**
 * Worker-side pixel access: turn an ImageBitmap posted by the page into RGBA
 * ImageData using an OffscreenCanvas, so the page never has to call
 * getImageData (a GPU→CPU readback that blocked the main thread).
 */
let canvas = null
let ctx = null

export const canReadBitmaps = () => {
  try {
    return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d')
  } catch {
    return false
  }
}

/** Draw `bitmap` at width × height and return its pixels; closes the bitmap. */
export function bitmapToImageData(bitmap, width, height) {
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height)
    ctx = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  try {
    ctx.drawImage(bitmap, 0, 0, width, height)
    return ctx.getImageData(0, 0, width, height)
  } finally {
    bitmap.close?.()
  }
}
