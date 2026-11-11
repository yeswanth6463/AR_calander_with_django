/**
 * Texture budget for the public AR viewer.
 *
 * Studio models routinely ship 2048² (or larger) maps: the bundled house model
 * carries 31 of them, ~500 MB once decoded to RGBA. Desktop GPUs swallow that;
 * phone GPUs do not — the upload fails and three.js keeps rendering the
 * material with its flat base colour, which reads as "the model is too bright
 * and the texture is missing".
 *
 * This pass runs before the first upload (`warmUpModel`) and:
 *   1. caps every texture's longest edge (`maxSize`),
 *   2. keeps halving the largest remaining image until the whole model fits in
 *      `budgetBytes` of RGBA,
 *   3. replaces the source bitmaps with the small ones and releases the
 *      originals (ImageBitmap.close) so the decoded memory is actually freed,
 *   4. sets a sane anisotropy (three defaults to 1, which is blurry at the
 *      glancing angles AR models are usually seen at).
 *
 * sRGB colour space, wrapping, flipY and the Texture object itself are left
 * untouched, so colour maps keep their look.
 */
export const TEXTURE_BUDGET = {
  /** Longest edge cap, px. */
  maxSize: { mobile: 1024, desktop: 2048 },
  /** Total decoded RGBA the model may keep, bytes. */
  bytes: { mobile: 128e6, desktop: 384e6 },
  /** Never shrink a map below this (longest edge). */
  minSize: 256,
  /** Texture filtering sharpness; clamped to the GPU's maximum. */
  anisotropy: 4,
}

const isImageBitmap = (v) => typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap
const isHtmlImage = (v) => typeof HTMLImageElement !== 'undefined' && v instanceof HTMLImageElement
const isCanvas = (v) =>
  (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) ||
  (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas)

/** True for a phone/tablet (iPadOS reports a Mac UA, so also check pointers). */
export function isMobileDevice() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua)) return true
  return (
    (navigator.maxTouchPoints || 0) > 1 &&
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches
  )
}

function imageSize(image) {
  const w = image?.width || image?.videoWidth || 0
  const h = image?.height || image?.videoHeight || 0
  return w > 0 && h > 0 ? { w, h } : null
}

/** Sources we can redraw. Video / compressed / data textures are skipped. */
function resizable(image) {
  if (!image || typeof image !== 'object') return false
  if (typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement) return false
  return isImageBitmap(image) || isHtmlImage(image) || isCanvas(image)
}

/** Every Texture referenced by a material slot of `model`. */
export function collectModelTextures(model) {
  const textures = new Set()
  model.traverse((child) => {
    const mats = Array.isArray(child.material) ? child.material : child.material ? [child.material] : []
    for (const mat of mats) {
      if (!mat) continue
      for (const value of Object.values(mat)) {
        if (value?.isTexture && !value.isCompressedTexture && !value.isVideoTexture) textures.add(value)
      }
    }
  })
  return textures
}

function drawToCanvas(image, w, h) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, w, h)
  return canvas
}

/**
 * Downscale one image. Canvas blits are ~20× faster than
 * createImageBitmap(resize*) in Chrome, so they are the default; the bitmap
 * path stays as a fallback for sources a canvas cannot draw.
 */
async function redraw(image, w, h, via = 'canvas') {
  if (via !== 'bitmap') {
    try {
      return drawToCanvas(image, w, h)
    } catch {
      /* fall through */
    }
  }
  if (typeof createImageBitmap === 'function' && !isCanvas(image)) {
    try {
      // Off the main thread where the browser supports it.
      return await createImageBitmap(image, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'medium',
      })
    } catch {
      /* fall through */
    }
  }
  return drawToCanvas(image, w, h)
}

/**
 * @param {THREE.Object3D} model
 * @param {{ renderer?: THREE.WebGLRenderer, mobile?: boolean, maxSize?: number,
 *           budgetBytes?: number, anisotropy?: number,
 *           resizeVia?: 'canvas' | 'bitmap' }} [opts]
 * @returns {Promise<{ images: number, resized: number, beforeMB: number, afterMB: number, maxEdge: number }>}
 */
export async function applyTextureBudget(model, opts = {}) {
  const renderer = opts.renderer
  const mobile = opts.mobile ?? isMobileDevice()
  const caps = renderer?.capabilities
  const gpuMax = caps?.maxTextureSize || Infinity
  const maxSize = Math.min(
    opts.maxSize ?? (mobile ? TEXTURE_BUDGET.maxSize.mobile : TEXTURE_BUDGET.maxSize.desktop),
    gpuMax
  )
  const budgetBytes = opts.budgetBytes ?? (mobile ? TEXTURE_BUDGET.bytes.mobile : TEXTURE_BUDGET.bytes.desktop)
  const anisotropy = Math.max(
    1,
    Math.min(opts.anisotropy ?? TEXTURE_BUDGET.anisotropy, caps?.getMaxAnisotropy?.() || 1)
  )

  const textures = collectModelTextures(model)

  // One entry per distinct source image (samplers can share an image).
  const plan = []
  const seen = new Set()
  for (const tex of textures) {
    const image = tex.image
    if (!image || seen.has(image) || !resizable(image)) continue
    const size = imageSize(image)
    if (!size) continue
    seen.add(image)
    const longest = Math.max(size.w, size.h)
    const k = longest > maxSize ? maxSize / longest : 1
    plan.push({
      image,
      w: size.w,
      h: size.h,
      targetW: Math.max(1, Math.round(size.w * k)),
      targetH: Math.max(1, Math.round(size.h * k)),
    })
  }

  const bytesOf = (p) => p.targetW * p.targetH * 4
  let total = plan.reduce((n, p) => n + bytesOf(p), 0)
  // Shave the biggest image repeatedly: keeps the small maps sharp while
  // bringing the total down, unlike a single global scale factor.
  let guard = plan.length * 8
  while (total > budgetBytes && guard-- > 0) {
    let best = null
    for (const p of plan) {
      if (Math.max(p.targetW, p.targetH) <= TEXTURE_BUDGET.minSize) continue
      if (!best || bytesOf(p) > bytesOf(best)) best = p
    }
    if (!best) break
    total -= bytesOf(best)
    best.targetW = Math.max(1, Math.round(best.targetW / 2))
    best.targetH = Math.max(1, Math.round(best.targetH / 2))
    total += bytesOf(best)
  }

  const jobs = plan.filter((p) => p.targetW < p.w || p.targetH < p.h)
  const replaced = new Map()
  let cursor = 0
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      try {
        replaced.set(job.image, await redraw(job.image, job.targetW, job.targetH, opts.resizeVia))
      } catch {
        /* keep the original texture rather than losing it */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker))

  const stale = new Set()
  for (const tex of textures) {
    const next = replaced.get(tex.image)
    if (next) {
      stale.add(tex.image)
      tex.image = next
      tex.needsUpdate = true
    }
    if (tex.anisotropy !== anisotropy) {
      tex.anisotropy = anisotropy
      tex.needsUpdate = true
    }
  }
  // Only now that every Texture points at the replacement can the source go.
  for (const image of stale) image.close?.()

  const before = plan.reduce((n, p) => n + p.w * p.h * 4, 0)
  return {
    images: plan.length,
    resized: replaced.size,
    beforeMB: +(before / 1e6).toFixed(1),
    afterMB: +(total / 1e6).toFixed(1),
    maxEdge: plan.reduce((n, p) => Math.max(n, p.targetW, p.targetH), 0),
  }
}
