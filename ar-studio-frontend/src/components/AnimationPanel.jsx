import { useEffect, useState } from 'react'
import { FRAME_RATE } from '../ar/animation'

const LOOP_ICON = { repeat: '↻', once: '1', pingpong: '⇄' }
const LOOP_ORDER = ['repeat', 'once', 'pingpong']

const fmt = (t) => (Number.isFinite(t) ? t.toFixed(2) : '0.00')

export default function AnimationPanel({ controller, className = '' }) {
  const [st, setSt] = useState(() => controller.getState())
  const [open, setOpen] = useState(true)
  // Re-sync when a new controller arrives (model rebuilt) — render-phase state
  // adjustment avoids a stale snapshot until the next playback tick.
  const [prevCtl, setPrevCtl] = useState(controller)
  if (prevCtl !== controller) {
    setPrevCtl(controller)
    setSt(controller.getState())
  }

  useEffect(() => controller.subscribe(setSt), [controller])

  if (!st.clips.length) return null

  const duration = st.duration || 0
  const totalFrames = Math.max(1, Math.round(duration * FRAME_RATE))
  const frame = Math.min(totalFrames, Math.floor(st.time * FRAME_RATE) + 1)
  const step = (dir) => controller.seek(st.time + dir / FRAME_RATE)

  const speeds = [0.1, 0.25, 0.5, 1, 1.5, 2]
  if (!speeds.includes(st.speed)) speeds.push(st.speed)
  speeds.sort((a, b) => a - b)

  const cycleLoop = () => {
    const next = LOOP_ORDER[(LOOP_ORDER.indexOf(st.loop) + 1) % LOOP_ORDER.length]
    controller.setLoop(next)
  }

  return (
    <div className={`anim-panel ${className}`}>
      <div className="anim-row">
        <button
          className="anim-collapse"
          onClick={() => setOpen((o) => !o)}
          title={open ? 'Hide timeline' : 'Show timeline'}
        >
          {open ? '▾' : '▴'}
        </button>
        {st.clips.length > 1 && (
          <select
            className="anim-clip"
            value={st.index}
            onChange={(e) => controller.selectClip(Number(e.target.value))}
            title="Animation clip"
          >
            {st.clips.map((c, i) => (
              <option key={`${c.name}-${i}`} value={i}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <button onClick={() => controller.seek(0)} title="Jump to start">
          ⏮
        </button>
        <button onClick={() => step(-1)} title="Previous frame">
          ‹
        </button>
        <button
          className="anim-primary"
          onClick={() => controller.toggle()}
          title={st.playing ? 'Pause' : 'Play'}
        >
          {st.playing ? '⏸' : '▶'}
        </button>
        <button onClick={() => step(1)} title="Next frame">
          ›
        </button>
        <button onClick={() => controller.seek(duration)} title="Jump to end">
          ⏭
        </button>
        <button onClick={() => controller.stop()} title="Stop and rewind">
          ■
        </button>
        <button onClick={cycleLoop} title={`Loop mode: ${st.loop}`}>
          {LOOP_ICON[st.loop]}
        </button>
        <select
          value={st.speed}
          onChange={(e) => controller.setSpeed(Number(e.target.value))}
          title="Playback speed"
        >
          {speeds.map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
      </div>
      {open && (
        <div className="anim-row anim-timeline">
          <input
            type="range"
            min={0}
            max={duration}
            step={0.001}
            value={Math.min(st.time, duration)}
            onChange={(e) => controller.seek(Number(e.target.value))}
            aria-label="Timeline"
          />
          <span className="anim-readout">
            {fmt(st.time)} / {fmt(duration)}s · f{frame}/{totalFrames}
          </span>
        </div>
      )}
    </div>
  )
}
