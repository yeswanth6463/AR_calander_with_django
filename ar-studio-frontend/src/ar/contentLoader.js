/**
 * Loads one experience item's content (GLB/GLTF model, video, GIF or image)
 * into a THREE.Group normalised to a 1-unit box, ready to be scaled by the
 * caller (face: centimetres, object: bounding-box size).
 */
import * as THREE from 'three'
import { createGltfLoader } from './gltfLoader'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { createAnimationController } from './animation'
import { createMediaPanel } from './mediaPanel'
import { isFlatMedia } from './anchors'

const gltfCache = new Map()
const loadGltf = (url) => {
  if (!gltfCache.has(url)) {
    gltfCache.set(
      url,
      new Promise((resolve, reject) => createGltfLoader().load(url, resolve, undefined, reject)).catch((err) => {
        gltfCache.delete(url)
        throw err
      })
    )
  }
  return gltfCache.get(url)
}

/** Use the frontend's media route for API-hosted files, including in dev where
 * the API runs on a different origin and the browser would block the request. */
export const relUrl = (url) => {
  if (!url) return ''
  try {
    const u = new URL(url, window.location.origin)
    if (u.origin === window.location.origin || u.pathname.startsWith('/media/')) {
      return u.pathname + u.search
    }
    return url
  } catch {
    return url
  }
}

/**
 * @param {string} url
 * @param {string} format
 * @param {{ align?: 'center' | 'bottom' }} opts
 * @returns {Promise<{ root: THREE.Group, animation: object|null, update(dt): void, dispose(): void }>}
 */
export async function loadContent(url, format, { align = 'center' } = {}) {
  const root = new THREE.Group()
  if (isFlatMedia(format)) {
    const panel = await createMediaPanel(url, format)
    // Panels are 0.5 wide; normalise to 1.
    panel.mesh.scale.setScalar(2)
    if (align === 'bottom') {
      panel.mesh.geometry.computeBoundingBox()
      const h = panel.mesh.geometry.boundingBox.max.y * 2
      panel.mesh.position.y = h
    }
    root.add(panel.mesh)
    return { root, animation: null, update: () => panel.update(), dispose: () => panel.dispose() }
  }

  const gltf = await loadGltf(url)
  const model = cloneSkinned(gltf.scene)
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  const wrap = new THREE.Group()
  model.position.set(-center.x, align === 'bottom' ? -box.min.y : -center.y, -center.z)
  wrap.add(model)
  wrap.scale.setScalar(1 / maxDim)
  root.add(wrap)

  model.traverse((child) => {
    if (!child.isMesh) return
    child.frustumCulled = false
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    for (const mat of mats) {
      if (!mat) continue
      if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace
      if (mat.emissiveMap) mat.emissiveMap.colorSpace = THREE.SRGBColorSpace
      mat.envMapIntensity = 1.1
    }
  })

  let animation = null
  if (gltf.animations?.length) {
    animation = createAnimationController({ scene: model, animations: gltf.animations })
    animation.setLoop(animation.defaultLoop)
    animation.play()
  }

  return {
    root,
    animation,
    update: (dt) => animation?.update(dt),
    dispose: () => {
      animation?.dispose()
      model.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
      })
    },
  }
}

/** Basic studio-like lighting + environment for a scene. */
export function addDefaultLighting(scene, renderer, camera) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 0.7))
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(1, 2, 3)
  camera.add(key)
  scene.add(camera)
  return () => {}
}

/** Item transform (studio units) → THREE object. Rotation in degrees. */
export function applyItemTransform(object, item, unit = 1) {
  const t = item.transform || {}
  const pos = t.position || [0, 0, 0]
  const rot = t.rotation || [0, 0, 0]
  const scl = t.scale_xyz || [t.scale ?? 1, t.scale ?? 1, t.scale ?? 1]
  object.position.set(pos[0] * unit, pos[1] * unit, pos[2] * unit)
  object.rotation.set(
    THREE.MathUtils.degToRad(rot[0] || 0),
    THREE.MathUtils.degToRad(rot[1] || 0),
    THREE.MathUtils.degToRad(rot[2] || 0),
    'YXZ'
  )
  object.scale.set(scl[0] || 1, scl[1] || 1, scl[2] || 1)
}
