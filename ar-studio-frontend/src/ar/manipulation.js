import * as THREE from 'three'

/**
 * User manipulation engine for AR content.
 *
 * Scene graph it expects (the tracking pose is applied *above* the target, so
 * moving/rotating/scaling the model can never disturb the tracker):
 *
 *   Camera / World
 *     └── Tracking Anchor            (written only by the tracker)
 *           └── Orientation Group    (coordinate-convention alignment)
 *                 └── target group   ← this module only mutates this group
 *                       └── 3D model
 *
 * Gestures:
 *   move    single-finger / left-drag across a camera-facing plane
 *   rotate  horizontal = yaw (Y), vertical = pitch (X), two-finger twist = roll (Z)
 *           axis pill locks rotation to one local axis
 *   scale   pinch (two fingers), mouse wheel, or the on-screen slider
 *
 * Rotation and scaling compensate the group position so they happen around the
 * model's true centre (`pivot`), not the marker origin.
 */

const MIN_SCALE = 0.1
const MAX_SCALE = 10
const ROT_PER_PX = 0.0075
const WHEEL_SCALE = 0.0015

const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

/** Offset of a local pivot from the group origin: R * S * pivot. */
const offsetOf = (pivot, quat, scale, out) =>
  out.copy(pivot).multiply(scale).applyQuaternion(quat)

const isUiTarget = (el) =>
  !!el?.closest?.(
    'button, a, input, select, textarea, label, [role="button"], [data-ar-manip-ignore], ' +
      '.viewer-manip-bar, .viewer-model-drawer, .viewer-models-toggle, .viewer-anim-toggle, ' +
      '.anim-panel, .viewer-game-overlay, .viewer-error-overlay, .viewer-back'
  )

export function createManipulation({
  root,
  canvas,
  camera,
  minScale = MIN_SCALE,
  maxScale = MAX_SCALE,
  onChange,
} = {}) {
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const plane = new THREE.Plane()
  const normal = new THREE.Vector3()
  const worldPoint = new THREE.Vector3()
  const parentPoint = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const pivotBefore = new THREE.Vector3()
  const pivotAfter = new THREE.Vector3()
  const pivot = new THREE.Vector3()

  const pointers = new Map() // pointerId → { x, y }
  let target = null
  let base = null // { position, quaternion, scale }
  let mode = 'move'
  let axis = null
  let enabled = false
  let scaleFactor = 1
  let gesture = null

  const notify = () => {
    if (!onChange) return
    onChange({
      mode,
      axis,
      scaleFactor,
      enabled,
      hasTarget: Boolean(target),
      position: target ? target.position.toArray() : null,
      rotation: target
        ? (() => {
            const e = new THREE.Euler().setFromQuaternion(target.quaternion, 'YXZ')
            return [THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)]
          })()
        : null,
      scale: target ? target.scale.toArray() : null,
    })
  }

  const ensureCurrent = () => {
    if (!target) return false
    target.updateWorldMatrix(true, false)
    return true
  }

  /** Convert a screen point to a point on a camera-facing plane at the target. */
  const screenToPlane = (clientX, clientY) => {
    if (!ensureCurrent()) return null
    const rect = canvas?.getBoundingClientRect?.()
    if (!rect?.width || !rect?.height) return null
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    target.getWorldPosition(tmp)
    camera.getWorldDirection(normal)
    plane.setFromNormalAndCoplanarPoint(normal, tmp)
    return raycaster.ray.intersectPlane(plane, worldPoint) ? worldPoint.clone() : null
  }

  const beginMove = (pointer) => {
    const startWorld = screenToPlane(pointer.x, pointer.y)
    if (!startWorld || !target?.parent) return null
    const startLocal = target.parent.worldToLocal(startWorld.clone())
    return {
      type: 'move',
      startPosition: target.position.clone(),
      startLocal,
    }
  }

  const beginRotate = (pointer) => ({
    type: 'rotate',
    lastX: pointer.x,
    lastY: pointer.y,
  })

  const beginPinch = () => {
    const [a, b] = [...pointers.values()]
    if (!a || !b) return null
    const dx = b.x - a.x
    const dy = b.y - a.y
    return {
      type: 'pinch',
      startDist: Math.max(1, Math.hypot(dx, dy)),
      startAngle: Math.atan2(dy, dx),
      startFactor: scaleFactor,
    }
  }

  const beginGesture = () => {
    if (!enabled || !target) return
    gesture = null
    if (pointers.size >= 2) {
      gesture = beginPinch()
      return
    }
    const pointer = [...pointers.values()][0]
    if (!pointer) return
    gesture = mode === 'move' ? beginMove(pointer) : mode === 'rotate' ? beginRotate(pointer) : null
  }

  /** Rotate around a local axis while keeping the pivot point fixed. */
  const applyRotation = (deltaQuat) => {
    if (!target) return
    const before = offsetOf(pivot, target.quaternion, target.scale, pivotBefore)
    target.quaternion.multiply(deltaQuat).normalize()
    const after = offsetOf(pivot, target.quaternion, target.scale, pivotAfter)
    target.position.add(before.sub(after))
  }

  const rotateBy = (deltaX, deltaY) => {
    if (!target) return
    if (axis && AXES[axis]) {
      const angle = (deltaX + deltaY) * ROT_PER_PX
      applyRotation(tmpQuat.setFromAxisAngle(AXES[axis], angle))
      return
    }
    if (deltaX) applyRotation(tmpQuat.setFromAxisAngle(AXES.y, -deltaX * ROT_PER_PX))
    if (deltaY) applyRotation(tmpQuat.setFromAxisAngle(AXES.x, -deltaY * ROT_PER_PX))
  }

  const rotateRoll = (angle) => {
    if (!target) return
    applyRotation(tmpQuat.setFromAxisAngle(AXES.z, -angle))
  }

  /** Scale uniformly from `base.scale`, keeping the pivot point fixed. */
  const applyScaleFactor = (next) => {
    if (!target || !base) return
    const factor = clamp(Number(next) || 1, minScale, maxScale)
    const nextScale = base.scale.clone().multiplyScalar(factor)
    const before = offsetOf(pivot, target.quaternion, target.scale, pivotBefore)
    const after = offsetOf(pivot, target.quaternion, nextScale, pivotAfter)
    target.position.add(before.sub(after))
    target.scale.copy(nextScale)
    scaleFactor = factor
    notify()
  }

  const applyMove = (g, pointer) => {
    if (!target?.parent) return
    const world = screenToPlane(pointer.x, pointer.y)
    if (!world) return
    parentPoint.copy(world)
    target.parent.worldToLocal(parentPoint)
    target.position.copy(g.startPosition).add(parentPoint.sub(g.startLocal))
  }

  const onPointerDown = (e) => {
    if (!enabled || !target) return
    if (isUiTarget(e.target)) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (pointers.has(e.pointerId)) return

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try {
      root.setPointerCapture?.(e.pointerId)
    } catch {
      /* some browsers refuse capture on non-canvas roots */
    }
    beginGesture()
  }

  const onPointerMove = (e) => {
    const pointer = pointers.get(e.pointerId)
    if (!pointer) return
    pointer.x = e.clientX
    pointer.y = e.clientY
    if (!enabled || !target || !gesture) return

    if (gesture.type === 'pinch') {
      if (pointers.size < 2) return
      const [a, b] = [...pointers.values()]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(1, Math.hypot(dx, dy))
      applyScaleFactor(gesture.startFactor * (dist / gesture.startDist))
      if (mode === 'rotate') {
        const angle = Math.atan2(dy, dx)
        rotateRoll(angle - gesture.startAngle)
        gesture.startAngle = angle
      }
      return
    }

    if (gesture.type === 'move') {
      applyMove(gesture, pointer)
      return
    }

    if (gesture.type === 'rotate') {
      const dx = pointer.x - gesture.lastX
      const dy = pointer.y - gesture.lastY
      gesture.lastX = pointer.x
      gesture.lastY = pointer.y
      rotateBy(dx, dy)
    }
  }

  const finishPointer = (e) => {
    if (!pointers.has(e.pointerId)) return
    pointers.delete(e.pointerId)
    try {
      root.releasePointerCapture?.(e.pointerId)
    } catch {
      /* ignore */
    }
    if (!enabled || !target) {
      gesture = null
      return
    }
    // Continue with the remaining finger after a pinch.
    beginGesture()
  }

  const onWheel = (e) => {
    if (!enabled || !target || mode !== 'scale') return
    if (isUiTarget(e.target)) return
    e.preventDefault()
    applyScaleFactor(scaleFactor * Math.exp(-e.deltaY * WHEEL_SCALE))
  }

  root?.addEventListener?.('pointerdown', onPointerDown)
  root?.addEventListener?.('pointermove', onPointerMove)
  root?.addEventListener?.('pointerup', finishPointer)
  root?.addEventListener?.('pointercancel', finishPointer)
  root?.addEventListener?.('wheel', onWheel, { passive: false })

  return {
    setMode(next) {
      mode = ['move', 'rotate', 'scale'].includes(next) ? next : 'move'
      gesture = null
      notify()
    },
    setAxis(next) {
      axis = AXES[next] ? next : null
      gesture = null
      notify()
    },
    setEnabled(next) {
      enabled = Boolean(next)
      if (!enabled) {
        gesture = null
        pointers.clear()
      }
      notify()
    },
    isEnabled: () => enabled,
    /** Attach a new user-manipulation group (the authored transform is its base). */
    setTarget(group, { pivot: pivotPoint } = {}) {
      target = group || null
      gesture = null
      scaleFactor = 1
      if (target) {
        base = {
          position: target.position.clone(),
          quaternion: target.quaternion.clone(),
          scale: target.scale.clone(),
        }
        if (pivotPoint) pivot.copy(pivotPoint)
        else pivot.set(0, 0, 0)
      } else {
        base = null
        pivot.set(0, 0, 0)
      }
      notify()
    },
    /** Recompute the rotation/scale centre (called after a model swap). */
    setPivot(point) {
      if (point) pivot.copy(point)
      else pivot.set(0, 0, 0)
    },
    setScaleFactor(next) {
      applyScaleFactor(next)
    },
    getScaleFactor: () => scaleFactor,
    reset() {
      if (!target || !base) return
      target.position.copy(base.position)
      target.quaternion.copy(base.quaternion)
      target.scale.copy(base.scale)
      scaleFactor = 1
      gesture = null
      notify()
    },
    dispose() {
      root?.removeEventListener?.('pointerdown', onPointerDown)
      root?.removeEventListener?.('pointermove', onPointerMove)
      root?.removeEventListener?.('pointerup', finishPointer)
      root?.removeEventListener?.('pointercancel', finishPointer)
      root?.removeEventListener?.('wheel', onWheel)
      pointers.clear()
      gesture = null
      target = null
      base = null
    },
  }
}
