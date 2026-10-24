import { useEffect, useState } from 'react'
import { FRAME_RATE } from '../ar/animation'

const fmt = (t) => (Number.isFinite(t) ? t.toFixed(2) : '0.00')

export default function AnimationPanel({ controller, className = '' }) {
  const [st, setSt] = useState(() => controller.getState())
  const [timelineOpen, setTimelineOpen] = useState(true)

  // Re-sync when a new controller arrives (model rebuilt)
  const [prevCtl, setPrevCtl] = useState(controller)
  if (prevCtl !== controller) {
    setPrevCtl(controller)
    setSt(controller.getState())
  }

  useEffect(() => controller.subscribe(setSt), [controller])

  if (!st?.clips?.length) return null

  const activeIndices = Array.isArray(st.activeIndices)
    ? st.activeIndices
    : [st.index ?? 0]

  const isLooping = st.loop === 'repeat'
  const duration = st.duration || 0
  const totalFrames = Math.max(1, Math.round(duration * FRAME_RATE))
  const frame = Math.min(totalFrames, Math.floor(st.time * FRAME_RATE) + 1)
  const step = (dir) => controller.seek(st.time + dir / FRAME_RATE)

  const speeds = [0.1, 0.25, 0.5, 1, 1.5, 2]
  if (!speeds.includes(st.speed)) speeds.push(st.speed)
  speeds.sort((a, b) => a - b)

  const handleToggleLoop = () => {
    if (controller.toggleLoop) {
      controller.toggleLoop()
    } else {
      controller.setLoop(isLooping ? 'once' : 'repeat')
    }
  }

  return (
    <div className={`anim-panel ${className}`}>
      {/* Animation Clips List with Checkboxes */}
      <div className="anim-clips-container">
        <div className="anim-clips-header">
          <span className="anim-clips-title">
            Clips ({st.clips.length})
          </span>
          <div className="anim-clips-actions">
            <button
              type="button"
              className="anim-btn-text"
              onClick={() => controller.selectAll?.()}
              title="Select all animation clips"
            >
              All
            </button>
            <span className="anim-sep">·</span>
            <button
              type="button"
              className="anim-btn-text"
              onClick={() => controller.deselectAll?.()}
              title="Deselect all animation clips"
            >
              None
            </button>
          </div>
        </div>

        <div className="anim-clips-list" role="list" aria-label="Animation clips">
          {st.clips.map((c, i) => {
            const isChecked = activeIndices.includes(i)
            return (
              <label
                key={`${c.name}-${i}`}
                className={`anim-clip-item ${isChecked ? 'active' : ''}`}
              >
                <input
                  type="checkbox"
                  className="anim-checkbox"
                  checked={isChecked}
                  onChange={() => controller.toggleClip?.(i)}
                />
                <span className="anim-clip-name" title={c.name}>
                  {c.name}
                </span>
                <span className="anim-clip-dur">
                  {fmt(c.duration)}s
                </span>
              </label>
            )
          })}
        </div>
      </div>

      {/* Playback Transport Row 1: Core Controls */}
      <div className="anim-row anim-controls-row">
        <button
          type="button"
          onClick={() => controller.seek(0)}
          title="Jump to start"
        >
          ⏮
        </button>
        <button
          type="button"
          onClick={() => step(-1)}
          title="Previous frame"
        >
          ‹
        </button>
        <button
          type="button"
          className="anim-primary"
          onClick={() => controller.toggle()}
          title={st.playing ? 'Pause' : 'Play'}
        >
          {st.playing ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          title="Next frame"
        >
          ›
        </button>
        <button
          type="button"
          onClick={() => controller.seek(duration)}
          title="Jump to end"
        >
          ⏭
        </button>
        <button
          type="button"
          onClick={() => controller.stop()}
          title="Stop and rewind"
        >
          ■
        </button>
      </div>

      {/* Playback Transport Row 2: Loop Toggle, Speed, and Timeline Toggle */}
      <div className="anim-row anim-options-row">
        {/* Dedicated Loop Button */}
        <button
          type="button"
          className={`anim-loop-btn ${isLooping ? 'active' : ''}`}
          onClick={handleToggleLoop}
          title={isLooping ? 'Loop: ON (continuous) — Click to play once' : 'Loop: OFF (plays once) — Click to loop'}
          aria-pressed={isLooping}
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          <span>{isLooping ? 'Loop ON' : 'Loop OFF'}</span>
        </button>

        <select
          className="anim-speed-select"
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

        <button
          type="button"
          className="anim-collapse"
          onClick={() => setTimelineOpen((o) => !o)}
          title={timelineOpen ? 'Hide timeline slider' : 'Show timeline slider'}
        >
          {timelineOpen ? '▾ Timeline' : '▴ Timeline'}
        </button>
      </div>

      {/* Timeline Slider and Frame Readout */}
      {timelineOpen && (
        <div className="anim-row anim-timeline">
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.001}
            value={Math.min(st.time, duration || 1)}
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
