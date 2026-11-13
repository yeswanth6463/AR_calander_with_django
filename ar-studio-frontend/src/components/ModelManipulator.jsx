import { Link } from 'react-router-dom'
import { mb } from '../ar/modelAssets'

/**
 * On-screen controls shared by the marker AR viewer and the free "custom model"
 * viewer. Purely presentational: the manipulation engine handles the gestures.
 */

const MODES = [
  { id: 'move', icon: '✥', label: 'Move' },
  { id: 'rotate', icon: '⟳', label: 'Rotate' },
  { id: 'scale', icon: '⤢', label: 'Scale' },
]

const AXIS_LABELS = [
  { id: 'x', label: 'X' },
  { id: 'y', label: 'Y' },
  { id: 'z', label: 'Z' },
]

export function ViewerManipulationHud({
  mode = 'move',
  onMode,
  axis = null,
  onAxis,
  scaleFactor = 1,
  onScale,
  onReset,
  label = '3D model',
}) {
  return (
    <div className="viewer-manip-bar" role="toolbar" aria-label="3D model controls">
      <div className="viewer-manip-head">
        <span className="viewer-manip-name" title={label}>{label}</span>
        <button type="button" className="viewer-manip-reset" onClick={onReset} title="Reset position, rotation and scale">
          ↺ Reset
        </button>
      </div>

      <div className="viewer-manip-row">
        <div className="viewer-manip-modes">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`viewer-manip-mode ${mode === m.id ? 'active' : ''}`}
              aria-pressed={mode === m.id}
              onClick={() => onMode?.(m.id)}
            >
              <span aria-hidden="true">{m.icon}</span>
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        {mode === 'rotate' && (
          <div className="viewer-manip-axis" role="group" aria-label="Rotation axis">
            {AXIS_LABELS.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`viewer-manip-pill ${axis === a.id ? 'active' : ''}`}
                aria-pressed={axis === a.id}
                onClick={() => onAxis?.(a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === 'scale' && (
        <div className="viewer-manip-scale">
          <input
            type="range"
            min="0.1"
            max="10"
            step="0.05"
            value={scaleFactor}
            onChange={(e) => onScale?.(Number(e.target.value))}
            aria-label="Model scale"
          />
          <span className="viewer-manip-scale-value">{scaleFactor.toFixed(2)}×</span>
        </div>
      )}

      <div className="viewer-manip-tip">
        {mode === 'move' && 'Drag to move · pinch to scale'}
        {mode === 'rotate' && (axis ? `Swipe to rotate ${axis.toUpperCase()} axis` : 'Drag yaw / pitch · twist to roll')}
        {mode === 'scale' && 'Pinch, scroll or use the slider'}
      </div>
    </div>
  )
}

export function ModelSwitcherDrawer({
  open,
  onClose,
  models = [],
  activeId = null,
  onSelect,
  onUpload,
  uploading = false,
  busy = false,
  uploadPct = 0,
  error = '',
  title = '3D models',
  hint = '',
  canUpload = true,
}) {
  if (!open) return null

  const pick = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onUpload?.(file)
  }

  return (
    <div className="viewer-model-drawer" role="dialog" aria-modal="false" aria-label={title}>
      <div className="viewer-model-head">
        <div>
          <h3>{title}</h3>
          <span className="tiny muted">
            {models.length} model{models.length === 1 ? '' : 's'} in this project
          </span>
        </div>
        <button type="button" className="viewer-model-close" onClick={onClose} aria-label="Close model list">
          ✕
        </button>
      </div>

      {hint && <p className="viewer-model-hint">{hint}</p>}
      {error && <div className="viewer-model-error" role="alert">{error}</div>}

      <div className="viewer-model-list">
        {models.map((model) => {
          const active = String(model.id) === String(activeId)
          return (
            <button
              key={model.id}
              type="button"
              className={`viewer-model-row ${active ? 'active' : ''}`}
              onClick={() => onSelect?.(model)}
              disabled={uploading || busy}
            >
              <span className="viewer-model-ico" aria-hidden="true">◆</span>
              <span className="viewer-model-text">
                <span className="viewer-model-name">{model.name}</span>
                <span className="tiny muted">
                  {String(model.format || '').toUpperCase()}
                  {model.file_size != null && ` · ${mb(model.file_size)}`}
                  {model.optimized && ' · optimised'}
                </span>
              </span>
              {active && <span className="viewer-model-badge">Showing</span>}
            </button>
          )
        })}
        {!models.length && (
          <p className="muted small-text viewer-model-empty">
            {canUpload
              ? 'No 3D models yet. Upload a .glb or .gltf to try it in AR.'
              : 'No 3D models have been added to this experience yet.'}
          </p>
        )}
      </div>

      {canUpload ? (
        <label className={`btn primary viewer-model-upload ${uploading || busy ? 'busy' : ''}`}>
          {uploading ? `Uploading… ${uploadPct}%` : '+ Upload New Model'}
          <input
            type="file"
            accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
            hidden
            disabled={uploading || busy}
            onChange={pick}
          />
        </label>
      ) : (
        <p className="tiny muted viewer-model-signin">
          <Link to="/login">Sign in to AR Studio</Link> to upload a 3D model to this project.
        </p>
      )}

      {uploading && (
        <div className="viewer-upload-track" role="progressbar" aria-valuenow={uploadPct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${Math.max(2, uploadPct)}%` }} />
        </div>
      )}
    </div>
  )
}
