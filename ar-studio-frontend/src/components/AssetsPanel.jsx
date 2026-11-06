import { useRef, useState } from 'react'
import { api } from '../api'
import { AUDIO_FORMATS, IMAGE_FORMATS, MODEL_FORMATS, VIDEO_FORMATS } from '../ar/anchors'
import { relUrl } from '../ar/contentLoader'

const icon = (format) => {
  if (AUDIO_FORMATS.includes(format)) return '♪'
  if (IMAGE_FORMATS.includes(format)) return '▣'
  if (VIDEO_FORMATS.includes(format)) return '▶'
  return '◆'
}

/**
 * Upload / list / delete project assets.
 * `allowAudio` (game projects): also accepts sounds for game logic.
 */
export default function AssetsPanel({
  projectId,
  assets,
  reload,
  onError,
  onNotice,
  selectedId,
  allowAudio = false,
  title = 'Models & Media',
}) {
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const audioRef = useRef(null)

  const formats = [...MODEL_FORMATS, ...VIDEO_FORMATS, ...IMAGE_FORMATS, ...(allowAudio ? AUDIO_FORMATS : [])]
  const accept = formats.map((f) => `.${f}`).join(',')

  const upload = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setBusy(true)
    onError('')
    try {
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase()
        if (!formats.includes(ext)) {
          throw new Error(`${file.name}: supported types are ${formats.map((f) => `.${f}`).join(', ')}`)
        }
        const fd = new FormData()
        fd.append('project', projectId)
        fd.append('name', file.name.replace(/\.[^.]+$/, ''))
        fd.append('model_file', file)
        fd.append('format', ext)
        await api('/assets/', { method: 'POST', formData: fd })
      }
      onNotice(`Uploaded ${files.length} asset${files.length > 1 ? 's' : ''}.`)
      e.target.value = ''
      await reload()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (assetId, e) => {
    e?.stopPropagation?.()
    e?.preventDefault?.()
    if (!confirm('Delete this asset? Scene items that use it will be removed.')) return
    onError('')
    try {
      await api(`/assets/${assetId}/`, { method: 'DELETE' })
      onNotice('Asset deleted.')
      await reload()
    } catch (err) {
      onError(err.message)
    }
  }

  const preview = (asset) => {
    try {
      audioRef.current?.pause()
      const audio = new Audio(relUrl(asset.model_file))
      audioRef.current = audio
      audio.play().catch(() => {})
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="panel-section">
      <div className="panel-head">
        <button className="panel-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          <h2>{title}</h2>
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        </button>
        <label className={`btn small ${busy ? 'ghost' : ''}`}>
          {busy ? '…' : '+ Upload'}
          <input type="file" accept={accept} multiple hidden onChange={upload} disabled={busy} />
        </label>
      </div>
      {expanded && (
        <>
          {assets.length === 0 && (
            <p className="muted small-text">
              Upload 3D models (.glb/.gltf), videos (.mp4/.webm/.gif) or images (.png/.jpg/.webp)
              {allowAudio ? ', plus sounds (.mp3/.wav/.ogg) for your game logic' : ''}.
            </p>
          )}
          <div className="tree-list">
            {assets.map((a) => (
              <div key={a.id} className={`tree-row ${selectedId === a.id ? 'active' : ''}`}>
                <span className="tree-ico">{icon(a.format)}</span>
                <span className="tree-label">
                  <span className="name">{a.name}</span>
                  <span className="tiny muted">{a.format.toUpperCase()}</span>
                </span>
                <div className="item-actions">
                  {AUDIO_FORMATS.includes(a.format) && (
                    <button type="button" className="btn ghost small" title="Play sound" onClick={() => preview(a)}>
                      ▶
                    </button>
                  )}
                  <button type="button" className="btn ghost small" title="Delete asset" onClick={(e) => remove(a.id, e)}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
