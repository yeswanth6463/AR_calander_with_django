/**
 * glTF / GLB optimiser for AR (runs in the studio before upload).
 *
 * Phone GPUs choke on studio-grade models: 50–70 MB files, hundreds of draw
 * calls, 2048–6500 px textures (~600 MB of GPU memory). This pipeline keeps
 * the look but makes them phone-sized:
 *
 *   dedup      — identical meshes / materials / textures stored once
 *   instance   — repeated meshes → GPU instancing
 *   flatten    — shallow scene graph (animated / skinned nodes are left alone)
 *   join       — merge meshes that share a material → far fewer draw calls
 *   weld       — share identical vertices
 *   resample   — drop redundant animation keyframes
 *   prune      — remove unused nodes, materials, textures, accessors
 *   textures   — downscale to `maxTextureSize`, re-encode (WebP when possible)
 *   meshopt    — quantise + compress geometry (EXT_meshopt_compression)
 *
 * The viewer's GLTFLoader registers the Meshopt decoder; EXT_texture_webp is
 * supported by three.js natively.
 */
import { WebIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions'
import { dedup, flatten, instance, join, meshopt, prune, resample, weld } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'

export const OPTIMIZE_DEFAULTS = {
  // Content on a printed marker rarely covers more than ~1000 px on screen.
  maxTextureSize: 1024,
  textureQuality: 0.85,
}

/**
 * Browser texture re-encoder: decode, downscale, encode WebP (JPEG / PNG
 * when the browser cannot encode WebP, e.g. Safari).
 * Returns { bytes, mimeType } or null to keep the original image.
 */
export async function resizeTextureInBrowser(bytes, mimeType, { maxSize, quality, hasAlpha }) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mimeType }), {
    colorSpaceConversion: 'none', // normal / roughness maps are data, not colour
    premultiplyAlpha: 'none',
  })
  try {
    const k = Math.min(1, maxSize / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * k))
    const h = Math.max(1, Math.round(bmp.height * k))
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, h)
    const encode = (type, q) =>
      canvas.convertToBlob ? canvas.convertToBlob({ type, quality: q }) : new Promise((r) => canvas.toBlob(r, type, q))
    let blob = await encode('image/webp', quality)
    if (!blob || blob.type !== 'image/webp') blob = await encode(hasAlpha ? 'image/png' : 'image/jpeg', quality)
    // Not worth it (already small and compact): keep the original.
    if (k === 1 && blob.size >= bytes.byteLength) return null
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type }
  } finally {
    bmp.close?.()
  }
}

const textureHasAlpha = (doc, texture) => {
  for (const material of doc.getRoot().listMaterials()) {
    if (material.getBaseColorTexture() === texture && material.getAlphaMode() !== 'OPAQUE') return true
  }
  return false
}

/**
 * @param {Uint8Array} glb        input .glb bytes (or self-contained .gltf with embedded data)
 * @param {object}     opts
 *   maxTextureSize, textureQuality — see OPTIMIZE_DEFAULTS
 *   resizeTexture(bytes, mimeType, { maxSize, quality, hasAlpha }) → { bytes, mimeType } | null
 *   onProgress(label)
 * @returns {{ glb: Uint8Array, report: object }}
 */
export async function optimizeGlb(glb, opts = {}) {
  const { maxTextureSize, textureQuality } = { ...OPTIMIZE_DEFAULTS, ...opts }
  const resizeTexture = opts.resizeTexture || resizeTextureInBrowser
  const progress = opts.onProgress || (() => {})
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready])

  const io = new WebIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })

  progress('Reading model…')
  const doc = await io.readBinary(glb)
  const before = summarize(doc)

  progress('Merging meshes…')
  await doc.transform(
    dedup(),
    instance({ min: 5 }),
    flatten(),
    join(),
    weld(),
    resample(),
    prune({ keepAttributes: false, keepLeaves: false })
  )

  progress('Resizing textures…')
  let webp = false
  const textures = doc.getRoot().listTextures()
  for (let i = 0; i < textures.length; i++) {
    const tex = textures[i]
    const image = tex.getImage()
    if (!image) continue
    progress(`Resizing textures… ${i + 1}/${textures.length}`)
    try {
      const out = await resizeTexture(image, tex.getMimeType(), {
        maxSize: maxTextureSize,
        quality: textureQuality,
        hasAlpha: textureHasAlpha(doc, tex),
      })
      if (out) {
        tex.setImage(out.bytes).setMimeType(out.mimeType)
        const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[out.mimeType]
        if (ext) tex.setURI(`${tex.getName() || `texture_${i}`}.${ext}`)
        if (out.mimeType === 'image/webp') webp = true
      }
    } catch (err) {
      console.warn('[optimizer] texture kept as-is', tex.getName(), err)
    }
  }
  if (webp) doc.createExtension(EXTTextureWebP).setRequired(true)

  progress('Compressing geometry…')
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }))

  progress('Writing…')
  const out = await io.writeBinary(doc)
  const after = summarize(doc)
  return {
    glb: out,
    report: {
      bytesBefore: glb.byteLength,
      bytesAfter: out.byteLength,
      drawCallsBefore: before.primitives,
      drawCallsAfter: after.primitives,
      texturesBefore: before.textures,
      texturesAfter: after.textures,
      maxTextureBefore: before.maxTexture,
      maxTextureAfter: Math.min(before.maxTexture, maxTextureSize),
      animations: after.animations,
      triangles: after.triangles,
    },
  }
}

function summarize(doc) {
  const root = doc.getRoot()
  let primitives = 0
  let triangles = 0
  for (const mesh of root.listMeshes()) {
    // Instanced meshes are drawn once per mesh, not per node.
    for (const prim of mesh.listPrimitives()) {
      primitives++
      const idx = prim.getIndices()
      const pos = prim.getAttribute('POSITION')
      triangles += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3)
    }
  }
  let maxTexture = 0
  for (const tex of root.listTextures()) {
    const size = tex.getSize()
    if (size) maxTexture = Math.max(maxTexture, size[0], size[1])
  }
  return {
    primitives,
    triangles,
    textures: root.listTextures().length,
    animations: root.listAnimations().length,
    maxTexture,
  }
}
