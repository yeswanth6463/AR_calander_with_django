import * as THREE from 'three'
import { apiUpload } from '../api'
import { applyTextureBudget } from './textureBudget'

/**
 * Shared helpers for the "Upload Custom 3D Model" feature:
 *   - client-side validation and progress uploads
 *   - model prep (texture budget, PBR tweaks, shader warm-up)
 *   - safe disposal when the model in a scene is replaced
 */

export const MODEL_3D_FORMATS = ['glb', 'gltf']

/** Warn (but allow) above this size: big models are slow to decode on phones. */
export const MODEL_WARN_BYTES = 50 * 1024 * 1024
/** Hard client stop; the API enforces the same 100 MB limit. */
export const MODEL_MAX_BYTES = 100 * 1024 * 1024

export const formatOf = (name = '') => {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const mb = (bytes) =>
  bytes == null ? '' : `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`

/**
 * Client-side check before a 3D upload.
 * Returns { error, warning } — error blocks, warning asks the user to confirm.
 */
export function validateModelFile(file) {
  if (!file) return { error: 'Pick a 3D model file.', warning: '' }
  const ext = formatOf(file.name)
  if (!MODEL_3D_FORMATS.includes(ext)) {
    return {
      error: `${file.name}: only .glb and .gltf 3D files are supported.`,
      warning: '',
    }
  }
  if (file.size > MODEL_MAX_BYTES) {
    return {
      error: `${file.name} is ${mb(file.size)}. 3D models must be 100 MB or smaller.`,
      warning: '',
    }
  }
  if (file.size > MODEL_WARN_BYTES) {
    return {
      error: '',
      warning: `${file.name} is ${mb(file.size)}. Large models can be slow to open on phones. Continue?`,
    }
  }
  if (ext === 'gltf') {
    // .gltf is JSON and may point at external .bin/texture files the browser
    // cannot fetch from the uploaded folder. Warn so users can pick a GLB.
    return {
      error: '',
      warning:
        `${file.name} is a .gltf file. If it references external .bin or texture files, ` +
        'those will not be uploaded. A self-contained .glb is recommended. Continue?',
    }
  }
  return { error: '', warning: '' }
}

/** Backend asset → the shape the viewer's model switcher uses. */
export function assetToModel(asset) {
  if (!asset) return null
  return {
    id: asset.id,
    name: asset.name,
    url: asset.model_file || asset.url,
    format: asset.format,
    file_size: asset.file_size ?? null,
    optimized: Boolean(asset.optimized),
  }
}

/**
 * Upload a model file to /api/assets/ with a progress callback.
 * Returns the model payload used by the viewer drawer.
 */
export async function uploadModelFile(projectId, file, { onProgress, name, optimized = false } = {}) {
  const { error } = validateModelFile(file)
  if (error) throw new Error(error)
  if (!projectId) throw new Error('This experience is not linked to a project.')

  const ext = formatOf(file.name)
  const fd = new FormData()
  fd.append('project', projectId)
  fd.append('name', name || file.name.replace(/\.[^.]+$/, '') || 'model')
  fd.append('format', ext)
  fd.append('optimized', optimized ? 'true' : 'false')
  fd.append('model_file', file)

  const asset = await apiUpload('/assets/', fd, { onProgress })
  return assetToModel(asset)
}

/** Upload failures on a public link are usually just "not signed in". */
export function friendlyUploadError(err) {
  const message = String(err?.message || 'Upload failed.')
  if (err?.status === 403 || /authentication|credential|permission/i.test(message)) {
    return 'Sign in to AR Studio to upload models to this project.'
  }
  return message
}

/** Free every geometry, material and texture under `root` (no leaks). */
export function disposeObject3D(root) {
  if (!root) return
  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()

  root.traverse((obj) => {
    if (obj.geometry) geometries.add(obj.geometry)
    const list = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : []
    for (const mat of list) {
      if (!mat) continue
      materials.add(mat)
      for (const value of Object.values(mat)) {
        if (value?.isTexture) textures.add(value)
      }
    }
    // Render targets / environment maps occasionally live on the object.
    if (obj.material?.envMap?.isTexture) textures.add(obj.material.envMap)
  })

  textures.forEach((tex) => tex.dispose?.())
  materials.forEach((mat) => mat.dispose?.())
  geometries.forEach((geo) => geo.dispose?.())

  if (root.parent) root.parent.remove(root)
  root.clear?.()
}

/** Local-space centre of a child object inside `parent`. */
export function localCenterOf(parent, child) {
  if (!parent || !child) return new THREE.Vector3()
  parent.updateWorldMatrix(true, true)
  child.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(child)
  if (box.isEmpty()) return new THREE.Vector3()
  const inverse = parent.matrixWorld.clone().invert()
  box.applyMatrix4(inverse)
  return box.getCenter(new THREE.Vector3())
}

/**
 * Scale a model to `targetSize` on its longest axis and move its geometry so
 * the true bounding-box centre sits at the group origin (rotation/scaling then
 * happens around the object, not around a corner).
 */
export function centerAndFitModel(root, targetSize = 0.6) {
  root.position.set(0, 0, 0)
  root.rotation.set(0, 0, 0)
  root.scale.set(1, 1, 1)
  root.updateMatrixWorld(true)

  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  root.scale.setScalar(maxDim > 1e-4 ? targetSize / maxDim : 1)
  root.updateMatrixWorld(true)

  const box2 = new THREE.Box3().setFromObject(root)
  if (!box2.isEmpty()) {
    root.position.sub(box2.getCenter(new THREE.Vector3()))
    root.updateMatrixWorld(true)
  }
  return size
}

/**
 * Upload textures + compile shaders while a loading indicator is up, instead
 * of on the first visible frame (which froze big models for seconds).
 */
export async function warmUpModel(renderer, model, camera, scene) {
  try {
    await renderer.compileAsync(model, camera, scene)
  } catch {
    /* compileAsync unsupported: shaders compile on first draw */
  }
  const seen = new Set()
  model.traverse((child) => {
    const mats = Array.isArray(child.material) ? child.material : child.material ? [child.material] : []
    for (const mat of mats) {
      for (const value of Object.values(mat)) {
        if (value?.isTexture && !seen.has(value)) {
          seen.add(value)
          renderer.initTexture(value)
        }
      }
    }
  })
}

/**
 * Keep GPU texture memory inside a phone's budget, flag PBR materials for the
 * camera rig and warm the shaders. Returns the texture-budget report.
 */
export async function prepareModel(model, { renderer, camera, scene }) {
  let budget = null
  try {
    budget = await applyTextureBudget(model, { renderer })
  } catch (err) {
    console.warn('[AR viewer] texture budget skipped', err)
  }

  model.traverse((child) => {
    if (!child.isMesh) return
    // Skinned meshes keep bind-pose bounds; culling can hide them mid-animation.
    child.frustumCulled = !child.isSkinnedMesh
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    mats.forEach((mat) => {
      if (!mat) return
      mat.envMapIntensity = 1.15
      if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace
      if (mat.emissiveMap) mat.emissiveMap.colorSpace = THREE.SRGBColorSpace
      mat.needsUpdate = true
    })
  })

  await warmUpModel(renderer, model, camera, scene)
  return budget
}
