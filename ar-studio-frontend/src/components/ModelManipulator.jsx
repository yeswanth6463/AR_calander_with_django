import { Link } from 'react-router-dom'
import { mb } from '../ar/modelAssets'

/**
 * On-screen controls shared by the marker AR viewer and the free "custom model"
 * viewer. Purely presentational: the manipulation engine handles the gestures.
 */

export function ViewerManipulationHud({ onReset }) {
  return (
    <button
      type="button"
      className="viewer-manip-reset"
      onClick={onReset}
      title="Reset position, rotation and scale"
      aria-label="Reset model position, rotation and scale"
      style={{
        position: 'absolute',
        right: '12px',
        bottom: 'max(74px, calc(env(safe-area-inset-bottom) + 68px))',
        zIndex: 16,
      }}
    >
      ↺ Reset
    </button>
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
