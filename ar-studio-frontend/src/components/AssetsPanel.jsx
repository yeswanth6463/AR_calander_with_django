import { useRef, useState } from 'react'
import { api } from '../api'
import { AUDIO_FORMATS, IMAGE_FORMATS, MODEL_FORMATS, VIDEO_FORMATS } from '../ar/anchors'
import { relUrl } from '../ar/contentLoader'

const OPTIMIZE_KEY = 'arOptimizeModels'
const readOptimizePref = () => {
  try {
    return localStorage.getItem(OPTIMIZE_KEY) !== '0'
  } catch {
    return true
  }
}
const mb = (bytes) => (bytes == null ? '' : `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`)

/** Run the AR optimiser on a .glb (lazy-loaded, so the studio bundle stays small). */
async function optimizeModelFile(bytes, name, onProgress) {
  const { optimizeGlb } = await import('../ar/modelOptimizer')
  const { glb, report } = await optimizeGlb(new Uint8Array(bytes), { onProgress })
  return { file: new File([glb], name, { type: 'model/gltf-binary' }), report }
}

const describeReport = (name, r) =>
  `${name}: ${mb(r.bytesBefore)} → ${mb(r.bytesAfter)}, ${r.drawCallsBefore} → ${r.drawCallsAfter} draw calls` +
  (r.maxTextureBefore > r.maxTextureAfter ? `, textures ≤ ${r.maxTextureAfter}px` : '')

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
  const [progress, setProgress] = useState('') // optimiser status line
  const [optimizeOn, setOptimizeOn] = useState(readOptimizePref)
  const [expanded, setExpanded] = useState(true)
  const audioRef = useRef(null)

  const toggleOptimize = (on) => {
    setOptimizeOn(on)
    try {
      localStorage.setItem(OPTIMIZE_KEY, on ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  const formats = [...MODEL_FORMATS, ...VIDEO_FORMATS, ...IMAGE_FORMATS, ...(allowAudio ? AUDIO_FORMATS : [])]
  const accept = formats.map((f) => `.${f}`).join(',')

  const upload = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setBusy(true)
    onError('')
    const reports = []
    try {
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase()
        if (!formats.includes(ext)) {
          throw new Error(`${file.name}: supported types are ${formats.map((f) => `.${f}`).join(', ')}`)
        }
        let upload = file
        let optimized = false
        if (optimizeOn && ext === 'glb') {
          try {
            const out = await optimizeModelFile(await file.arrayBuffer(), file.name, (label) =>
              setProgress(`${file.name}: ${label}`)
            )
            upload = out.file
            optimized = true
            reports.push(describeReport(file.name, out.report))
          } catch (err) {
            console.warn('[optimizer] upload original', err)
            reports.push(`${file.name}: could not be optimised, uploaded as-is`)
          }
        }
        setProgress(`Uploading ${file.name}…`)
        const fd = new FormData()
        fd.append('project', projectId)
        fd.append('name', file.name.replace(/\.[^.]+$/, ''))
        fd.append('model_file', upload)
        fd.append('format', ext)
        fd.append('optimized', optimized ? 'true' : 'false')
        await api('/assets/', { method: 'POST', formData: fd })
      }
      onNotice(
        reports.length
          ? `Uploaded and optimised — ${reports.join(' · ')}`
          : `Uploaded ${files.length} asset${files.length > 1 ? 's' : ''}.`
      )
      e.target.value = ''
      await reload()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  /** Optimise an already-uploaded .glb in place (replaces its file). */
  const optimizeExisting = async (asset, e) => {
    e?.stopPropagation?.()
    setBusy(true)
    onError('')
    try {
      setProgress(`${asset.name}: downloading…`)
      const res = await fetch(relUrl(asset.model_file))
      if (!res.ok) throw new Error(`Could not download ${asset.name} (${res.status}).`)
      const name = `${asset.name.replace(/\.glb$/i, '') || 'model'}.glb`
      const { file, report } = await optimizeModelFile(await res.arrayBuffer(), name, (label) =>
        setProgress(`${asset.name}: ${label}`)
      )
      setProgress(`${asset.name}: uploading…`)
      const fd = new FormData()
      fd.append('model_file', file)
      fd.append('optimized', 'true')
      await api(`/assets/${asset.id}/`, { method: 'PATCH', formData: fd })
      onNotice(`${describeReport(asset.name, report)}. Republish to update live links.`)
      await reload()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
      setProgress('')
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
          <label
            className="optimize-toggle"
            title="Shrink textures, merge meshes and compress geometry before upload (.glb). Keeps the look; much faster on phones."
          >
            <input type="checkbox" checked={optimizeOn} onChange={(e) => toggleOptimize(e.target.checked)} disabled={busy} />
            <span>Optimize 3D models for AR</span>
          </label>
          {progress && (
            <div className="optimize-progress" role="status">
              <span className="compile-dot" aria-hidden="true" />
              <span>{progress}</span>
            </div>
          )}
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
                  <span className="tiny muted asset-meta">
                    {a.format.toUpperCase()}
                    {a.file_size != null && ` · ${mb(a.file_size)}`}
                    {a.optimized && <span className="asset-optimized"> · optimised</span>}
                    {!a.optimized && a.format === 'glb' && a.file_size > 15e6 && (
                      <span className="asset-heavy"> · heavy for phones</span>
                    )}
                  </span>
                </span>
                <div className="item-actions">
                  {a.format === 'glb' && !a.optimized && (
                    <button
                      type="button"
                      className="btn ghost small"
                      title="Optimise for AR (smaller textures, fewer draw calls, compressed geometry)"
                      onClick={(e) => optimizeExisting(a, e)}
                      disabled={busy}
                    >
                      ⚡
                    </button>
                  )}
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
