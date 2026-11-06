import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { api } from '../api'
import AssetsPanel from '../components/AssetsPanel'
import TrackingStage from '../components/TrackingStage'
import { FACE_POINTS, IMAGE_FORMATS, OBJECT_LABELS, facePointMeta, isPlaceable, projectTypeMeta } from '../ar/anchors'
import { markersFromSettings } from '../ar/faceMesh'

const TRANSFORM_FIELDS = [
  ['Position', ['position_x', 'position_y', 'position_z'], 0.1],
  ['Rotation', ['rotation_x', 'rotation_y', 'rotation_z'], 1],
  ['Scale', ['scale_x', 'scale_y', 'scale_z'], 0.05],
]

/** Studio for face-tracking and object-detection projects. */
export default function TrackingStudio({ project, assets, experiences, reload, error, notice, onError, onNotice }) {
  const mode = project.project_type === 'face' ? 'face' : 'object'
  const meta = projectTypeMeta(project.project_type)
  const settings = project.type_settings || {}
  const defaultAnchor = mode === 'face' ? settings.default_point || 'eyes' : settings.default_label || 'cup'

  const [drafts, setDrafts] = useState({}) // id -> unsaved / just-saved field values
  const [selectedId, setSelectedId] = useState(null)
  const [newAsset, setNewAsset] = useState('')
  const [newAnchor, setNewAnchor] = useState(defaultAnchor)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(false)
  const [tracking, setTracking] = useState(false)
  // Face markers (landmark points / mesh edges / contours): shown in the
  // preview and, when saved, to viewers of the published link.
  const [markers, setMarkers] = useState(() => markersFromSettings(settings))
  const stageApi = useRef(null)
  const [slug, setSlug] = useState(project.publication_slug && !/^[0-9a-f-]{36}$/.test(project.publication_slug) ? project.publication_slug : '')
  const [published, setPublished] = useState(project.publication_slug ? `/view/${project.publication_slug}` : '')

  // Server items overlaid with local edits, so transform changes move the
  // live preview instantly.
  const items = useMemo(
    () => experiences.flatMap((exp) => exp.items || []).map((item) => ({ ...item, ...(drafts[item.id] || {}) })),
    [experiences, drafts]
  )
  const selected = items.find((i) => i.id === selectedId) || items[0] || null

  const isMaskAnchor = (value) => mode === 'face' && value === 'mesh'
  const placeable = assets.filter((a) => isPlaceable(a) && (!isMaskAnchor(newAnchor) || IMAGE_FORMATS.includes(a.format)))

  const saveMarkers = async (next) => {
    setMarkers(next)
    try {
      await api(`/projects/${project.id}/`, {
        method: 'PATCH',
        body: {
          type_settings: { ...settings, show_points: next.points, show_mesh: next.mesh, show_contours: next.contours },
        },
      })
      onNotice('Face markers saved — republish to update the link.')
    } catch (err) {
      onError(err.message)
    }
  }

  const downloadTemplate = () => {
    const canvas = stageApi.current?.maskTemplate?.()
    if (!canvas) {
      onError('Start the camera preview and look straight at it first, so the face layout can be captured.')
      return
    }
    const a = document.createElement('a')
    a.download = 'face-mask-template.png'
    a.href = canvas.toDataURL('image/png')
    a.click()
    onNotice('Template downloaded. Paint your mask on it, export as PNG, upload it and add it as a Face mask.')
  }
  const assetOf = (item) => assets.find((a) => a.id === item.model_asset)

  const stageItems = useMemo(
    () =>
      items
        .map((item) => {
          const asset = assets.find((a) => a.id === item.model_asset)
          if (!asset) return null
          return {
            id: item.id,
            name: item.name,
            anchor: { type: mode, value: item.anchor_value },
            model: { url: asset.model_file, format: asset.format },
            transform: {
              position: [item.position_x, item.position_y, item.position_z],
              rotation: [item.rotation_x, item.rotation_y, item.rotation_z],
              scale_xyz: [item.scale_x, item.scale_y, item.scale_z],
            },
          }
        })
        .filter(Boolean),
    [items, assets, mode]
  )

  const [slots, setSlots] = useState({ nav: null, status: null })
  useLayoutEffect(() => {
    setSlots({ nav: document.getElementById('studio-nav-slot'), status: document.getElementById('studio-status-slot') })
  }, [])

  const addItem = async (e) => {
    e.preventDefault()
    if (!newAsset) return
    setBusy(true)
    onError('')
    try {
      let experienceId = experiences[0]?.id
      if (!experienceId) {
        const exp = await api('/experiences/', { method: 'POST', body: { project: project.id, name: 'Main' } })
        experienceId = exp.id
      }
      const asset = assets.find((a) => a.id === newAsset)
      // Object content floats just above the object by default.
      const startY = mode === 'object' ? 0.75 : 0
      const created = await api('/items/', {
        method: 'POST',
        body: {
          experience: experienceId,
          model_asset: newAsset,
          anchor_value: newAnchor,
          name: asset?.name || '',
          position_y: startY,
          scale: mode === 'object' ? 0.6 : 1,
        },
      })
      onNotice('Content added.')
      setNewAsset('')
      await reload()
      setSelectedId(created.id)
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const patchItem = (id, values, commit) => {
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] || {}), ...values } }))
    if (!commit) return
    api(`/items/${id}/`, { method: 'PATCH', body: values })
      .then(() => onNotice('Saved.'))
      .catch((err) => onError(err.message))
  }

  const removeItem = async (id) => {
    if (!confirm('Remove this content?')) return
    try {
      await api(`/items/${id}/`, { method: 'DELETE' })
      setSelectedId(null)
      onNotice('Removed.')
      await reload()
    } catch (err) {
      onError(err.message)
    }
  }

  const publish = async () => {
    onError('')
    if (!experiences.length || !items.length) {
      onError('Add some content before publishing.')
      return
    }
    setBusy(true)
    try {
      const body = { scene_ids: experiences.map((e) => e.id) }
      if (slug.trim()) body.slug = slug.trim().toLowerCase()
      const d = await api(`/projects/${project.id}/publish/`, { method: 'POST', body })
      setPublished(d.url)
      if (d.slug) setSlug(d.slug)
      onNotice('Published.')
      await reload()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const link = published ? `${window.location.origin}${published}` : ''
  const anchorOptions =
    mode === 'face'
      ? FACE_POINTS.map((p) => ({ id: p.id, label: p.label }))
      : OBJECT_LABELS.map((l) => ({ id: l, label: l }))

  const breadcrumb = (
    <>
      <Link to="/" className="studio-back">Projects</Link>
      <span className="studio-crumb" aria-hidden="true">/</span>
      <h1>{project.name}</h1>
      <span className="badge">{meta.icon} {meta.title}</span>
    </>
  )
  const status = (
    <>
      {error && <span className="studio-status bad">{error}</span>}
      {notice && !error && <span className="studio-status">{notice}</span>}
    </>
  )

  return (
    <div className="studio">
      {slots.nav ? createPortal(breadcrumb, slots.nav) : <div className="studio-top">{breadcrumb}</div>}
      {slots.status && createPortal(status, slots.status)}

      <div className="studio-grid">
        <aside className="panel sidebar editor-side">
          <div className="side-project">
            <div className="side-project-name">{project.name}</div>
            <div className="tiny muted">{meta.title}</div>
          </div>
          <div className="side-scroll">
            <AssetsPanel
              projectId={project.id}
              assets={assets}
              reload={reload}
              onError={onError}
              onNotice={onNotice}
              selectedId={selected?.model_asset}
            />
            {mode === 'face' && (
              <div className="panel-section">
                <div className="panel-head">
                  <h2>Face markers</h2>
                </div>
                <p className="tiny muted" style={{ margin: '0 0 10px' }}>
                  Turn markers on or off from the checkboxes on the preview screen.
                </p>
                <button type="button" className="btn ghost small add-wide" onClick={downloadTemplate} disabled={!preview}>
                  ⬇ Download face mask template
                </button>
                <p className="tiny muted" style={{ margin: '6px 0 0' }}>
                  Paint over the template, save as PNG (transparent = skin), upload it, then add it as “Face mask”.
                </p>
              </div>
            )}
            <div className="panel-section">
              <p className="tiny muted" style={{ margin: 0 }}>
                {mode === 'face'
                  ? 'Tip: models should face forward (+Z) and be roughly centred. Use the live preview to line them up on your own face.'
                  : 'Tip: content is sized to the detected object — scale 1 ≈ the object’s height. Use the live preview with a real object to check placement.'}
              </p>
            </div>
          </div>
        </aside>

        <section className="panel viewport-panel tracking-preview">
          {preview && mode === 'face' && (
            <div className="preview-marker-toggles" role="group" aria-label="Face markers">
              {[
                ['points', 'Points'],
                ['mesh', 'Mesh'],
                ['contours', 'Contours'],
              ].map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={markers[key]}
                    onChange={(e) => saveMarkers({ ...markers, [key]: e.target.checked })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          )}
          {preview ? (
            <TrackingStage
              mode={mode}
              items={stageItems}
              settings={settings}
              markers={markers}
              onTracking={setTracking}
              onReady={(api) => {
                stageApi.current = api
              }}
              className="tracking-stage"
            />
          ) : (
            <div className="tracking-placeholder">
              <div className="viewer-game-icon" aria-hidden="true">{meta.icon}</div>
              <p>
                {mode === 'face'
                  ? 'Preview your effects live on your face using this device’s camera.'
                  : 'Preview live: point this device’s camera at a real object.'}
              </p>
              <button className="btn primary" onClick={() => setPreview(true)}>
                Start camera preview
              </button>
            </div>
          )}
          <div className="viewport-hint">
            {preview
              ? `${tracking ? (mode === 'face' ? 'Face tracked' : 'Object detected') : mode === 'face' ? 'Looking for a face…' : 'Looking for objects…'} · `
              : ''}
            {stageItems.length} content item{stageItems.length === 1 ? '' : 's'}
            {preview && (
              <>
                {' · '}
                <button className="text-btn" onClick={() => setPreview(false)}>Stop camera</button>
              </>
            )}
          </div>
        </section>

        <aside className="panel inspector">
          <div className="inspector-bar">
            <div className="inspector-bar-title">
              <strong>Content</strong>
              <span className="tiny muted">{items.length} item{items.length === 1 ? '' : 's'}</span>
            </div>
            <div className="inspector-bar-actions">
              {link && <a className="btn ghost small" href={link} target="_blank" rel="noreferrer">Open</a>}
              <button className="btn primary small" onClick={publish} disabled={busy}>Publish</button>
            </div>
          </div>

          <div className="panel-section">
            <form className="model-add-form" onSubmit={addItem}>
              <div className="tiny muted" style={{ fontWeight: 600 }}>
                {mode === 'face' ? 'Add an effect to the face' : 'Add content to an object'}
              </div>
              <select required value={newAsset} onChange={(e) => setNewAsset(e.target.value)}>
                <option value="">
                  {placeable.length
                    ? isMaskAnchor(newAnchor)
                      ? 'Select mask image…'
                      : 'Select model, image or video…'
                    : isMaskAnchor(newAnchor)
                      ? 'Upload a PNG / JPG / WebP mask first'
                      : 'Upload a model first'}
                </option>
                {placeable.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <select
                value={newAnchor}
                onChange={(e) => {
                  setNewAnchor(e.target.value)
                  setNewAsset('')
                }}
                aria-label={mode === 'face' ? 'Face point' : 'Object'}
              >
                {anchorOptions.map((o) => (
                  <option key={o.id} value={o.id}>{mode === 'object' ? `On: ${o.label}` : o.label}</option>
                ))}
              </select>
              <button className="btn small add-wide" disabled={busy || !newAsset}>Add</button>
            </form>

            <div className="models-flat-list">
              {items.map((item) => (
                <div
                  key={item.id}
                  className={`model-item-row ${item.id === selected?.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="tree-label">
                    <span className="name">{item.name || assetOf(item)?.name || 'Content'}</span>
                    <span className="tiny muted">
                      {mode === 'face' ? facePointMeta(item.anchor_value).label : `on ${item.anchor_value}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn ghost small"
                    title="Remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeItem(item.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {!items.length && <p className="muted tiny">No content yet. Upload a model, then add it above.</p>}
            </div>
          </div>

          {selected && (
            <div className="panel-section transform-section">
              <div className="panel-head">
                <div className="transform-title-wrap">
                  <h2>Placement</h2>
                  <span className="tiny muted">
                    {mode === 'face' ? 'Position in cm from the face point' : 'Position in object heights'}
                  </span>
                </div>
              </div>
              <div className="inspector-form">
                <input
                  value={selected.name || ''}
                  placeholder="Name"
                  maxLength={150}
                  onChange={(e) => patchItem(selected.id, { name: e.target.value }, false)}
                  onBlur={(e) => patchItem(selected.id, { name: e.target.value }, true)}
                />
                <select value={selected.anchor_value} onChange={(e) => patchItem(selected.id, { anchor_value: e.target.value }, true)}>
                  {anchorOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
              {isMaskAnchor(selected.anchor_value) ? (
                <label className="mask-opacity">
                  <span>Opacity {Math.round(Math.min(1, Number(selected.scale_x) || 1) * 100)}%</span>
                  <input
                    type="range"
                    min="0.05"
                    max="1"
                    step="0.05"
                    value={Math.min(1, Number(selected.scale_x) || 1)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      patchItem(selected.id, { scale_x: v, scale_y: v, scale_z: v }, false)
                    }}
                    onPointerUp={(e) => {
                      const v = Number(e.target.value)
                      patchItem(selected.id, { scale_x: v, scale_y: v, scale_z: v }, true)
                    }}
                    onKeyUp={(e) => {
                      const v = Number(e.target.value)
                      patchItem(selected.id, { scale_x: v, scale_y: v, scale_z: v }, true)
                    }}
                  />
                  <span className="tiny muted">The mask follows the face automatically — no placement needed.</span>
                </label>
              ) : (
                <>
              <div className="transform-axis-head">
                <span />
                <span>X</span>
                <span>Y</span>
                <span>Z</span>
              </div>
              {TRANSFORM_FIELDS.map(([label, fields, step]) => (
                <div key={label} className="transform-axis-row">
                  <span>{label}</span>
                  {fields.map((field) => (
                    <input
                      key={`${selected.id}-${field}`}
                      type="number"
                      step={step}
                      defaultValue={Number((Number(selected[field]) || 0).toFixed(3))}
                      aria-label={`${label} ${field.slice(-1).toUpperCase()}`}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (e.target.value !== '' && Number.isFinite(v) && (!field.startsWith('scale') || v > 0)) {
                          patchItem(selected.id, { [field]: v }, false)
                        }
                      }}
                      onBlur={(e) => {
                        const v = Number(e.target.value)
                        if (Number.isFinite(v) && (!field.startsWith('scale') || v > 0)) patchItem(selected.id, { [field]: v }, true)
                      }}
                    />
                  ))}
                </div>
              ))}
                </>
              )}
            </div>
          )}

          <div className="panel-section">
            <div className="panel-head"><h2>Publish</h2></div>
            <div className="inspector-form">
              <input placeholder="Link name (optional)" value={slug} onChange={(e) => setSlug(e.target.value)} />
              {link && (
                <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Published link" />
              )}
              <p className="tiny muted" style={{ margin: 0 }}>Republish after changes for them to go live.</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
