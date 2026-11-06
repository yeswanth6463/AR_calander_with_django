import * as THREE from 'three'

/**
 * Tap-to-interact for the AR viewer.
 *
 * Listens for taps on the viewer root, raycasts into the scene and reports
 * which experience item was hit. Taps that land on UI (buttons, links,
 * panels) are ignored — only taps that fall through to the camera / GL
 * layers count.
 *
 * Usage:
 *   const tap = createTapInteraction({ root, canvas, camera })
 *   tap.register(fitGroup, item, anchor)        // per loaded item
 *   tap.onTap(({ item, object, point }) => …)   // subscribe
 *   tap.update(dt)                              // per frame (bounce feedback)
 *   tap.dispose()
 *
 * Every tap also dispatches a `ar-item-tap` CustomEvent on `window`
 * (detail: { itemId, itemName }) so future game logic can hook in without
 * touching the viewer.
 */

const TAP_MAX_MOVE_PX = 12
const TAP_MAX_MS = 400
const BOUNCE_MS = 320
const BOUNCE_AMOUNT = 0.18

export function createTapInteraction({ root, canvas, camera }) {
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  /** @type {{ group: THREE.Object3D, item: any, anchor: THREE.Object3D }[]} */
  const targets = []
  const listeners = new Set()
  const bounces = new Map() // group -> { t, base: Vector3 }
  let down = null

  const isUiTarget = (el) =>
    !!el?.closest?.('button, a, input, select, textarea, [role="button"], .anim-panel, .viewer-anim-toggle')

  const onPointerDown = (e) => {
    if (!e.isPrimary || isUiTarget(e.target)) return
    down = { x: e.clientX, y: e.clientY, t: performance.now() }
  }

  const onPointerUp = (e) => {
    if (!down || !e.isPrimary) return
    const start = down
    down = null
    if (isUiTarget(e.target)) return
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
    if (moved > TAP_MAX_MOVE_PX || performance.now() - start.t > TAP_MAX_MS) return
    handleTap(e.clientX, e.clientY)
  }

  const onPointerCancel = () => {
    down = null
  }

  const handleTap = (clientX, clientY) => {
    // The GL canvas is laid out as a "cover" rect that can extend past the
    // screen, so map through its own bounding box, not the viewport.
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)

    let best = null
    for (const entry of targets) {
      // Raycaster does not skip invisible objects; only hit tracked anchors.
      if (!entry.anchor.visible) continue
      const hits = raycaster.intersectObject(entry.group, true)
      const hit = hits.find((h) => isHittable(h.object))
      if (hit && (!best || hit.distance < best.hit.distance)) best = { entry, hit }
    }
    if (!best) return

    const { entry, hit } = best
    startBounce(entry.group)
    const payload = { item: entry.item, object: entry.group, point: hit.point.clone() }
    for (const fn of listeners) {
      try {
        fn(payload)
      } catch (err) {
        console.warn('[AR tap] listener failed', err)
      }
    }
    window.dispatchEvent(
      new CustomEvent('ar-item-tap', {
        detail: { itemId: entry.item?.id, itemName: entry.item?.name || entry.item?.model?.name || '' },
      })
    )
  }

  // Skip helper geometry (contact shadows etc.) and hidden models — the
  // raycaster itself ignores `visible`.
  const isHittable = (obj) => {
    let o = obj
    while (o) {
      if (o.userData?.noTap || !o.visible) return false
      o = o.parent
    }
    return true
  }

  const startBounce = (group) => {
    const existing = bounces.get(group)
    bounces.set(group, { t: 0, base: existing ? existing.base : group.scale.clone() })
  }

  const update = (dt) => {
    for (const [group, b] of bounces) {
      b.t += dt * 1000
      const p = Math.min(b.t / BOUNCE_MS, 1)
      // Quick squash-and-stretch pop that settles back to the base scale.
      const k = 1 + BOUNCE_AMOUNT * Math.sin(p * Math.PI) * (1 - p * 0.5)
      group.scale.copy(b.base).multiplyScalar(k)
      if (p >= 1) {
        group.scale.copy(b.base)
        bounces.delete(group)
      }
    }
  }

  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('pointerup', onPointerUp)
  root.addEventListener('pointercancel', onPointerCancel)

  return {
    register(group, item, anchor) {
      targets.push({ group, item, anchor })
    },
    onTap(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    update,
    dispose() {
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointerup', onPointerUp)
      root.removeEventListener('pointercancel', onPointerCancel)
      for (const [group, b] of bounces) group.scale.copy(b.base)
      bounces.clear()
      targets.length = 0
      listeners.clear()
    },
  }
}
