import { useState } from 'react'
import { api } from '../api'
import { relUrl } from '../ar/contentLoader'

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|bmp|gif)$/i

const Stars = ({ rating }) => (
  <span className={`target-stars r${rating}`} aria-label={`${rating} of 5`}>
    {'★'.repeat(rating)}
    <span className="off">{'★'.repeat(5 - rating)}</span>
  </span>
)

const ago = (iso) => {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

/** Per-target compile state from its tracking_data (written by the server compiler). */
const targetState = (t, version) => {
  const d = t.tracking_data
  if (!d || d.compiler_version !== version) return { kind: 'pending' }
  if (d.status === 'ready') return { kind: 'ready', index: d.index, rating: d.rating || 0, features: d.feature_count || 0 }
  return { kind: 'failed', error: d.error || 'Not trackable' }
}

/**
 * Image-target library + compiler (MindAR-style): add one or many images,
 * see them listed with their bundle index and tracking quality, and compile
 * them all on the server into one bundle the AR viewer loads.
 */
export default function TargetsPanel({
  projectId,
  targets,
  compileStatus,
  reload,
  onError,
  onNotice,
  selectedId,
  onPreviewTarget,
}) {
  const [expanded, setExpanded] = useState(true)
  const [uploading, setUploading] = useState(null) // { done, total }
  const [compiling, setCompiling] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Bundle order = upload order (oldest first), matching the server index.
  const ordered = [...targets].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id))
  )
  const busy = compiling || !!uploading

  const compile = async ({ quiet = false } = {}) => {
    setCompiling(true)
    onError('')
    try {
      const res = await api(`/projects/${projectId}/compile-targets/`, { method: 'POST' })
      const failed = res.total - res.compiled
      if (!quiet || failed) {
        onNotice(
          `Compiled ${res.compiled} of ${res.total} target${res.total === 1 ? '' : 's'}` +
            (failed ? ` — ${failed} not trackable.` : '.')
        )
      }
      await reload()
    } catch (err) {
      onError(err.message)
    } finally {
      setCompiling(false)
    }
  }

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => IMAGE_TYPES.test(f.type))
    if (!files.length) {
      onError('Choose PNG, JPG or WebP images.')
      return
    }
    onError('')
    setUploading({ done: 0, total: files.length })
    let uploaded = 0
    try {
      for (const file of files) {
        const fd = new FormData()
        fd.append('project', projectId)
        fd.append('name', file.name.replace(/\.[^.]+$/, ''))
        fd.append('image', file)
        fd.append('target_width', 0.2)
        await api('/targets/', { method: 'POST', formData: fd })
        uploaded += 1
        setUploading({ done: uploaded, total: files.length })
      }
    } catch (err) {
      onError(err.message)
    } finally {
      setUploading(null)
    }
    if (uploaded) {
      onNotice(`Added ${uploaded} target${uploaded === 1 ? '' : 's'}. Compiling…`)
      await compile({ quiet: true })
    }
  }

  const remove = async (target, e) => {
    e?.stopPropagation?.()
    if (!confirm(`Delete target "${target.name}"? Scene items that use it will be removed.`)) return
    onError('')
    try {
      await api(`/targets/${target.id}/`, { method: 'DELETE' })
      onNotice('Target deleted.')
      await reload()
    } catch (err) {
      onError(err.message)
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    if (!busy) uploadFiles(e.dataTransfer?.files)
  }
  const onDragOver = (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
    e.preventDefault()
    if (!dragging) setDragging(true)
  }

  const status = compileStatus || {}
  let statusText
  let statusKind
  if (compiling) {
    statusText = 'Compiling targets…'
    statusKind = 'busy'
  } else if (uploading) {
    statusText = `Uploading ${uploading.done + 1} of ${uploading.total}…`
    statusKind = 'busy'
  } else if (!ordered.length) {
    statusText = 'No targets yet'
    statusKind = 'idle'
  } else if (!status.url) {
    statusText = 'Not compiled'
    statusKind = 'stale'
  } else if (status.stale) {
    statusText = 'Targets changed — recompile'
    statusKind = 'stale'
  } else {
    statusText = `${status.compiled}/${status.total} compiled · ${ago(status.compiled_at)}`
    statusKind = status.compiled < status.total ? 'warn' : 'ok'
  }

  return (
    <div
      className={`panel-section targets-panel ${dragging ? 'is-dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="panel-head">
        <button className="panel-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          <h2>Image targets</h2>
          {ordered.length > 0 && <span className="count-badge">{ordered.length}</span>}
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        </button>
        <label className={`btn small ${busy ? 'ghost' : ''}`} title="Add one or more target images">
          + Add
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            disabled={busy}
            onChange={(e) => {
              uploadFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
      </div>

      {expanded && (
        <>
          {ordered.length > 0 && (
            <div className={`compile-bar ${statusKind}`}>
              <span className="compile-dot" aria-hidden="true" />
              <span className="compile-text">{statusText}</span>
              <button
                type="button"
                className={`btn small ${statusKind === 'stale' ? '' : 'ghost'}`}
                onClick={() => compile()}
                disabled={busy}
                title="Compile all target images into one tracking file"
              >
                {compiling ? '…' : status.url && !status.stale ? 'Recompile' : 'Compile'}
              </button>
              {busy && <span className="compile-progress" aria-hidden="true" />}
            </div>
          )}

          {ordered.length === 0 ? (
            <label className="target-dropzone">
              <strong>Drop target images here</strong>
              <span className="tiny muted">or click to choose · several at once · detailed, high-contrast images track best</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                disabled={busy}
                onChange={(e) => {
                  uploadFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
          ) : (
            <div className="tree-list">
              {ordered.map((t) => {
                const st = targetState(t, status.version)
                return (
                  <div
                    key={t.id}
                    className={`tree-row target-tree-row ${selectedId === t.id ? 'active' : ''} ${st.kind}`}
                    onClick={() => onPreviewTarget?.(t)}
                    title="Click to preview tracked feature points"
                  >
                    <span className="target-index">{st.kind === 'ready' ? `#${st.index}` : '–'}</span>
                    {t.image && <img className="tree-thumb target-thumb" src={relUrl(t.image)} alt="" />}
                    <span className="tree-label">
                      <span className="name">{t.name}</span>
                      <span className="tiny muted target-meta">
                        {st.kind === 'ready' && (
                          <>
                            <Stars rating={st.rating} /> {st.features.toLocaleString()} pts
                          </>
                        )}
                        {st.kind === 'pending' && 'Not compiled'}
                        {st.kind === 'failed' && <span className="target-failed">{st.error}</span>}
                      </span>
                    </span>
                    <div className="item-actions">
                      <button
                        type="button"
                        className="btn ghost small"
                        title="Delete target"
                        aria-label={`Delete ${t.name}`}
                        onClick={(e) => remove(t, e)}
                        disabled={busy}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {dragging && <div className="target-drop-hint">Drop images to add targets</div>}
        </>
      )}
    </div>
  )
}
