/**
 * Real-time face tracking: MediaPipe Face Landmarker gives a 4x4 facial
 * transformation matrix (canonical face space, centimetres) per face; items
 * are attached to face points inside that space and follow the head.
 *
 * Item shape (published payload or studio draft):
 *   { id, anchor: { type: 'face', value: 'eyes' }, model: { url, format },
 *     transform: { position: [cm], rotation: [deg], scale_xyz: [..] } }
 */
import * as THREE from 'three'
import { createCameraStage } from './cameraStage'
import { createFaceTracker } from './mediapipe'
import { facePointMeta } from './anchors'
import { applyItemTransform, loadContent, relUrl } from './contentLoader'
import { createFaceMeshLayer } from './faceMesh'
import { IMAGE_FORMATS } from './anchors'

/** Items anchored to the whole face mesh with an image become wrap-around masks. */
export const isMaskItem = (item) => item?.anchor?.value === 'mesh' && IMAGE_FORMATS.includes(item?.model?.format)

// MediaPipe's face geometry assumes a perspective camera with a 63° vertical
// FOV and near/far of 1 / 10000 (units: cm).
const FACE_FOV = 63
const POSE_SMOOTHING = 0.55 // 0 = frozen, 1 = raw
const LOST_AFTER_MS = 250

export async function createFaceStage(container, { occlusion = false, markers, onStatus, onFaceChange } = {}) {
  onStatus?.('starting camera…')
  const meshLayer = createFaceMeshLayer()
  meshLayer.setMarkers(markers)
  let tracker = null
  const anchor = new THREE.Group()
  anchor.matrixAutoUpdate = false
  anchor.visible = false
  const smoothPos = new THREE.Vector3()
  const smoothQuat = new THREE.Quaternion()
  const smoothScale = new THREE.Vector3(1, 1, 1)
  const rawMatrix = new THREE.Matrix4()
  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const tmpScale = new THREE.Vector3()
  let hasPose = false
  let lastSeen = 0
  let faceVisible = false

  const entries = new Map() // id -> { holder, fit, key, content, loading }

  const stage = await createCameraStage(container, {
    facingMode: 'user',
    fov: FACE_FOV,
    near: 1,
    far: 10000,
    onFrame: (now, dt) => {
      for (const e of entries.values()) e.content?.update(dt)
      if (!tracker) return
      const faces = tracker.detect(stage.video, now)
      meshLayer.update(faces[0]?.landmarks || null, faces[0]?.matrix || null, stage.width, stage.height)
      if (faces.length) {
        rawMatrix.fromArray(faces[0].matrix)
        rawMatrix.decompose(tmpPos, tmpQuat, tmpScale)
        if (!hasPose) {
          smoothPos.copy(tmpPos)
          smoothQuat.copy(tmpQuat)
          smoothScale.copy(tmpScale)
          hasPose = true
        } else {
          smoothPos.lerp(tmpPos, POSE_SMOOTHING)
          smoothQuat.slerp(tmpQuat, POSE_SMOOTHING)
          smoothScale.lerp(tmpScale, POSE_SMOOTHING)
        }
        anchor.matrix.compose(smoothPos, smoothQuat, smoothScale)
        anchor.matrixWorldNeedsUpdate = true
        anchor.visible = true
        lastSeen = now
      } else if (now - lastSeen > LOST_AFTER_MS) {
        anchor.visible = false
        hasPose = false
      }
      if (anchor.visible !== faceVisible) {
        faceVisible = anchor.visible
        onFaceChange?.(faceVisible)
      }
    },
  })
  stage.scene.add(anchor)
  // Masks sit under 3D models; markers/edges draw on top of everything.
  const markerLayer = { scene: new THREE.Scene(), camera: meshLayer.camera }
  stage.underlays.push(meshLayer)
  stage.overlays.push(markerLayer)
  meshLayer.overlayTo(markerLayer.scene)

  // Invisible head that hides the parts of models behind it (hat backs,
  // glasses arms). Rough ellipsoid in canonical-face centimetres.
  let occluder = null
  if (occlusion) {
    occluder = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshBasicMaterial({ colorWrite: false })
    )
    occluder.scale.set(7.4, 10, 8.4)
    occluder.position.set(0, 0.8, -3.6)
    occluder.renderOrder = -1
    anchor.add(occluder)
  }

  onStatus?.('loading face tracker…')
  try {
    tracker = await createFaceTracker()
  } catch (err) {
    stage.dispose()
    throw new Error(`Could not load face tracking: ${err?.message || err}`)
  }
  onStatus?.('ready')

  const place = (entry, item) => {
    const point = facePointMeta(item.anchor?.value)
    entry.holder.position.fromArray(point.offset)
    applyItemTransform(entry.fit, item, 1) // position in cm
    if (entry.content) entry.content.root.scale.setScalar(point.fit)
  }

  const setItems = (items) => {
    const keep = new Set()
    meshLayer.setMasks(
      items.filter(isMaskItem).map((item) => ({
        id: item.id,
        url: relUrl(item.model.url),
        opacity: Math.min(1, Math.max(0.05, item.transform?.scale_xyz?.[0] ?? 1)),
      }))
    )
    for (const item of items) {
      if (!item?.model?.url || item.anchor?.type !== 'face' || isMaskItem(item)) continue
      keep.add(item.id)
      const key = `${item.model.url}|${item.model.format}`
      let entry = entries.get(item.id)
      if (entry && entry.key !== key) {
        removeEntry(item.id)
        entry = null
      }
      if (!entry) {
        const holder = new THREE.Group()
        const fit = new THREE.Group()
        holder.add(fit)
        anchor.add(holder)
        entry = { holder, fit, key, content: null, item }
        entries.set(item.id, entry)
        const created = entry
        loadContent(relUrl(item.model.url), item.model.format)
          .then((content) => {
            if (entries.get(item.id) !== created) return content.dispose()
            created.content = content
            fit.add(content.root)
            place(created, created.item)
          })
          .catch((err) => console.warn('[face] content failed', item.model.url, err))
      }
      entry.item = item
      place(entry, item)
    }
    for (const id of [...entries.keys()]) if (!keep.has(id)) removeEntry(id)
  }

  const removeEntry = (id) => {
    const entry = entries.get(id)
    if (!entry) return
    entries.delete(id)
    anchor.remove(entry.holder)
    entry.content?.dispose()
  }

  return {
    setItems,
    setMarkers: (next) => meshLayer.setMarkers(next),
    /** Canvas with the mask design template, or null before a face was seen. */
    maskTemplate: () => meshLayer.maskTemplate(),
    get hasMaskTemplate() {
      return meshLayer.hasTemplate
    },
    dispose() {
      meshLayer.dispose()
      for (const id of [...entries.keys()]) removeEntry(id)
      occluder?.geometry.dispose()
      occluder?.material.dispose()
      tracker?.dispose()
      stage.dispose()
    },
  }
}
