/**
 * Real-time object detection: MediaPipe Object Detector (COCO classes) finds
 * objects in the rear-camera feed; items whose anchor label matches are
 * placed on the detected object's bounding box, scaled to its size.
 *
 * Item transform units are "object heights": position [0, 0.6, 0] floats the
 * content 0.6× the object's height above its centre; scale 1 ≈ the object's
 * height.
 */
import * as THREE from 'three'
import { createCameraStage } from './cameraStage'
import { createObjectDetector } from './mediapipe'
import { verticalFovForFrame } from './pose'
import { applyItemTransform, loadContent, relUrl } from './contentLoader'

const DEPTH = 1 // world units; everything is placed on a plane at this depth
const SMOOTHING = 0.4
const LOST_AFTER_MS = 450
const DETECT_EVERY_MS = 50 // ~20 Hz is plenty and keeps phones cool

export async function createObjectStage(
  container,
  { minConfidence = 0.5, showLabels = true, onStatus, onDetections } = {}
) {
  onStatus?.('starting camera…')
  let detector = null
  let lastDetectAt = 0
  let detections = []
  const groups = new Map() // label -> { holder, lastSeen, has, entries: Map }
  const labelLayer = document.createElement('div')
  labelLayer.className = 'camstage-boxes'

  const targetPos = new THREE.Vector3()

  const stage = await createCameraStage(container, {
    facingMode: 'environment',
    mirror: false,
    near: 0.01,
    far: 100,
    onFrame: (now, dt) => {
      for (const g of groups.values()) for (const e of g.entries.values()) e.content?.update(dt)
      if (!detector) return
      const vw = stage.width
      const vh = stage.height
      if (!vw || !vh) return
      const fov = verticalFovForFrame(vw, vh)
      if (Math.abs(stage.camera.fov - fov) > 0.01) {
        stage.camera.fov = fov
        stage.camera.updateProjectionMatrix()
      }

      if (now - lastDetectAt >= DETECT_EVERY_MS) {
        lastDetectAt = now
        detections = detector.detect(stage.video, now)
        onDetections?.(detections)
        if (showLabels) drawLabels(detections, vw, vh)
      }

      const halfH = DEPTH * Math.tan(THREE.MathUtils.degToRad(fov / 2))
      const halfW = halfH * (vw / vh)
      for (const [label, g] of groups) {
        let best = null
        for (const d of detections) if (d.label === label && (!best || d.score > best.score)) best = d
        if (best) {
          const cx = best.box.x + best.box.w / 2
          const cy = best.box.y + best.box.h / 2
          targetPos.set(((cx / vw) * 2 - 1) * halfW, -((cy / vh) * 2 - 1) * halfH, -DEPTH)
          const size = (best.box.h / vh) * 2 * halfH
          if (!g.has) {
            g.holder.position.copy(targetPos)
            g.holder.scale.setScalar(size)
            g.has = true
          } else {
            g.holder.position.lerp(targetPos, SMOOTHING)
            g.holder.scale.setScalar(THREE.MathUtils.lerp(g.holder.scale.x, size, SMOOTHING))
          }
          g.holder.visible = true
          g.lastSeen = now
        } else if (now - g.lastSeen > LOST_AFTER_MS) {
          g.holder.visible = false
          g.has = false
        }
      }
    },
  })
  stage.video.parentElement.append(labelLayer)

  const drawLabels = (list, vw, vh) => {
    // Match the canvas' cover rectangle so boxes line up with the video.
    const s = stage.canvas.style
    Object.assign(labelLayer.style, { width: s.width, height: s.height, left: s.left, top: s.top })
    const watched = new Set(groups.keys())
    labelLayer.replaceChildren(
      ...list.map((d) => {
        const el = document.createElement('div')
        el.className = `camstage-box ${watched.has(d.label) ? 'watched' : ''}`
        el.style.left = `${(d.box.x / vw) * 100}%`
        el.style.top = `${(d.box.y / vh) * 100}%`
        el.style.width = `${(d.box.w / vw) * 100}%`
        el.style.height = `${(d.box.h / vh) * 100}%`
        const tag = document.createElement('span')
        tag.textContent = `${d.label} ${Math.round(d.score * 100)}%`
        el.append(tag)
        return el
      })
    )
  }

  onStatus?.('loading object detector…')
  try {
    detector = await createObjectDetector({ minConfidence })
  } catch (err) {
    stage.dispose()
    throw new Error(`Could not load object detection: ${err?.message || err}`)
  }
  onStatus?.('ready')

  const groupFor = (label) => {
    let g = groups.get(label)
    if (!g) {
      const holder = new THREE.Group()
      holder.visible = false
      stage.scene.add(holder)
      g = { holder, lastSeen: 0, has: false, entries: new Map() }
      groups.set(label, g)
    }
    return g
  }

  const setItems = (items) => {
    const keep = new Map() // label -> Set(ids)
    for (const item of items) {
      const label = item.anchor?.value
      if (!item?.model?.url || item.anchor?.type !== 'object' || !label) continue
      if (!keep.has(label)) keep.set(label, new Set())
      keep.get(label).add(item.id)
      // An item may have moved to another label: drop it from the old group.
      for (const [otherLabel, other] of groups) {
        if (otherLabel !== label && other.entries.has(item.id)) removeEntry(other, item.id)
      }
      const g = groupFor(label)
      const key = `${item.model.url}|${item.model.format}`
      let entry = g.entries.get(item.id)
      if (entry && entry.key !== key) {
        removeEntry(g, item.id)
        entry = null
      }
      if (!entry) {
        const fit = new THREE.Group()
        g.holder.add(fit)
        entry = { fit, key, content: null }
        g.entries.set(item.id, entry)
        const created = entry
        loadContent(relUrl(item.model.url), item.model.format)
          .then((content) => {
            if (g.entries.get(item.id) !== created) return content.dispose()
            created.content = content
            fit.add(content.root)
          })
          .catch((err) => console.warn('[object] content failed', item.model.url, err))
      }
      applyItemTransform(entry.fit, item, 1)
    }
    for (const [label, g] of groups) {
      const ids = keep.get(label) || new Set()
      for (const id of [...g.entries.keys()]) if (!ids.has(id)) removeEntry(g, id)
    }
  }

  const removeEntry = (g, id) => {
    const entry = g.entries.get(id)
    if (!entry) return
    g.entries.delete(id)
    g.holder.remove(entry.fit)
    entry.content?.dispose()
  }

  return {
    setItems,
    dispose() {
      for (const g of groups.values()) for (const id of [...g.entries.keys()]) removeEntry(g, id)
      detector?.dispose()
      labelLayer.remove()
      stage.dispose()
    },
  }
}
