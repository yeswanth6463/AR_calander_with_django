import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

/**
 * Blender / Unity style view-axis gizmo for the editor viewport.
 *
 * Shows the world X / Y / Z axes as seen by the camera (redrawn every frame
 * without React re-renders). Click an axis to look straight along it; the
 * camera swings around the orbit target and keeps its distance.
 *
 * props:
 *   controlsRef  ref to the viewport's OrbitControls (camera = controls.object)
 */

const SIZE = 96
const C = SIZE / 2
const ARM = 32 // axis length in px
const R_POS = 10
const R_NEG = 7.5

// Colors match the TransformControls gizmo (X red, Y green, Z blue).
const AXES = [
  { id: 'px', dir: [1, 0, 0], color: '#ff385c', label: 'X', view: 'Right' },
  { id: 'nx', dir: [-1, 0, 0], color: '#ff385c', label: '-X', view: 'Left' },
  { id: 'py', dir: [0, 1, 0], color: '#22cc55', label: 'Y', view: 'Top' },
  { id: 'ny', dir: [0, -1, 0], color: '#22cc55', label: '-Y', view: 'Bottom', blocked: true },
  { id: 'pz', dir: [0, 0, 1], color: '#2988ff', label: 'Z', view: 'Front' },
  { id: 'nz', dir: [0, 0, -1], color: '#2988ff', label: '-Z', view: 'Back' },
]

const SNAP_MS = 280
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

export default function ViewAxisGizmo({ controlsRef }) {
  const groupRefs = useRef({})
  const lineRefs = useRef({})
  const [hover, setHover] = useState(null)
  const [hoverPad, setHoverPad] = useState(false)
  const snapRef = useRef(null)

  useEffect(() => {
    let raf = 0
    const inv = new THREE.Quaternion()
    const v = new THREE.Vector3()
    const lastQ = new THREE.Quaternion(NaN, 0, 0, 0)

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const controls = controlsRef.current
      const camera = controls?.object
      if (!camera) return

      // Camera snap animation (slerp the view direction around the target).
      const snap = snapRef.current
      if (snap) {
        if (snap.start == null) snap.start = performance.now()
        const t = Math.min(1, (performance.now() - snap.start) / SNAP_MS)
        const q = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), snap.rot, easeInOut(t))
        v.copy(snap.from).applyQuaternion(q).setLength(snap.dist)
        camera.position.copy(controls.target).add(v)
        camera.lookAt(controls.target)
        if (t >= 1) snapRef.current = null
      }

      if (camera.quaternion.equals(lastQ)) return
      lastQ.copy(camera.quaternion)
      inv.copy(camera.quaternion).invert()

      // Project each axis into view space; draw far ones first.
      const projected = AXES.map((a) => {
        v.set(a.dir[0], a.dir[1], a.dir[2]).applyQuaternion(inv)
        return { a, x: C + v.x * ARM, y: C - v.y * ARM, z: v.z }
      }).sort((p, q) => p.z - q.z)

      projected.forEach(({ a, x, y, z }, order) => {
        const g = groupRefs.current[a.id]
        if (!g) return
        g.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`)
        // Axes pointing away from the viewer fade a little, like Blender.
        g.style.opacity = String(0.55 + 0.45 * ((z + 1) / 2))
        g.parentNode?.appendChild(g) // re-order = depth sort in SVG
        g.dataset.order = String(order)
        const line = lineRefs.current[a.id]
        if (line) {
          line.setAttribute('x2', x.toFixed(2))
          line.setAttribute('y2', y.toFixed(2))
          line.style.opacity = g.style.opacity
        }
      })
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [controlsRef])

  const snapTo = (axis) => {
    const controls = controlsRef.current
    const camera = controls?.object
    if (!camera || axis.blocked) return
    const from = camera.position.clone().sub(controls.target)
    const dist = from.length() || 2
    // Straight top-down is degenerate for OrbitControls (up = +Y): tilt a hair.
    const to = new THREE.Vector3(...axis.dir)
    if (axis.id === 'py') to.set(0, 1, 0.0005)
    to.normalize()
    const rot = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to)
    snapRef.current = { start: null, from, dist, rot }
  }

  return (
    <div
      className={`view-axis-gizmo ${hoverPad ? 'hover' : ''}`}
      onPointerEnter={() => setHoverPad(true)}
      onPointerLeave={() => {
        setHoverPad(false)
        setHover(null)
      }}
      aria-label="View axis gizmo"
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle className="vag-pad" cx={C} cy={C} r={C - 2} />
        {/* Lines for the positive axes sit under every handle. */}
        <g>
          {AXES.filter((a) => !a.id.startsWith('n')).map((a) => (
            <line
              key={a.id}
              ref={(el) => (lineRefs.current[a.id] = el)}
              x1={C}
              y1={C}
              x2={C}
              y2={C}
              stroke={a.color}
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          ))}
        </g>
        <g>
          {AXES.map((a) => {
            const positive = !a.id.startsWith('n')
            const active = hover === a.id
            return (
              <g
                key={a.id}
                ref={(el) => (groupRefs.current[a.id] = el)}
                className={`vag-handle ${a.blocked ? 'blocked' : ''}`}
                onPointerEnter={() => setHover(a.id)}
                onPointerLeave={() => setHover((h) => (h === a.id ? null : h))}
                onClick={() => snapTo(a)}
                role="button"
                aria-label={`${a.view} view`}
              >
                <title>{a.blocked ? `${a.view} (below the ground plane)` : `${a.view} view (${a.label})`}</title>
                <circle
                  r={positive ? R_POS : R_NEG}
                  fill={positive || active ? a.color : 'var(--vag-neg-fill)'}
                  stroke={a.color}
                  strokeWidth={positive ? 0 : 2}
                  className={active ? 'vag-active' : ''}
                />
                {(positive || active) && (
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    className={`vag-label ${positive ? '' : 'small'}`}
                  >
                    {a.label}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
