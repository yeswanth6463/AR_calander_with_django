import { useEffect, useMemo, useState } from 'react'
import { markersFromSettings } from '../ar/faceMesh'
import { Link } from 'react-router-dom'
import TrackingStage from '../components/TrackingStage'

/** Public viewer for face-tracking and object-detection projects. */
export default function TrackingViewer({ exp }) {
  const mode = exp.project_type === 'face' ? 'face' : 'object'
  const [started, setStarted] = useState(false)
  const [tracking, setTracking] = useState(false)

  const items = useMemo(() => {
    const list = []
    for (const scene of exp.scenes || []) list.push(...(scene.items || []))
    if (!list.length) list.push(...(exp.items || []))
    return list.filter((item) => item?.model?.url && item.anchor?.type === mode && item.is_active !== false)
  }, [exp, mode])

  const markers = useMemo(() => markersFromSettings(exp.type_settings), [exp.type_settings])
  const labels = useMemo(() => [...new Set(items.map((i) => i.anchor.value))], [items])

  useEffect(() => {
    document.body.classList.add('viewer-mode')
    return () => document.body.classList.remove('viewer-mode')
  }, [])

  const hint =
    mode === 'face'
      ? tracking
        ? ''
        : 'Look at the camera — keep your whole face in view'
      : tracking
        ? ''
        : `Point the camera at: ${labels.join(', ') || 'an object'}`

  return (
    <div className="viewer-root">
      {started ? (
        <TrackingStage
          mode={mode}
          items={items}
          settings={exp.type_settings}
          markers={markers}
          onTracking={setTracking}
          className="viewer-stage"
        />
      ) : (
        <div className="viewer-game-overlay">
          <div className="viewer-game-card">
            <div className="viewer-game-icon" aria-hidden="true">{mode === 'face' ? '🙂' : '📦'}</div>
            <h2 className="viewer-game-title">{exp.name || exp.project || 'AR experience'}</h2>
            <p className="viewer-game-text">
              {mode === 'face'
                ? 'Uses your front camera to put effects on your face. Nothing is recorded or uploaded.'
                : `Uses your camera to find ${labels.join(', ') || 'objects'} around you. Nothing is recorded or uploaded.`}
            </p>
            {!items.length && <p className="viewer-game-hint">This experience has no content yet.</p>}
            <button
              type="button"
              className="btn primary viewer-game-btn"
              onClick={() => setStarted(true)}
              disabled={!items.length}
            >
              Start camera
            </button>
          </div>
        </div>
      )}
      <Link to="/" className="viewer-back">← AR Studio</Link>
      {started && hint && (
        <div className="viewer-hint-pill">
          <span className="hint-dot" />
          <span>{hint}</span>
        </div>
      )}
    </div>
  )
}
