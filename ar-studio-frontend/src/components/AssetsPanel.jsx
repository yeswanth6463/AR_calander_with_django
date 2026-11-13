import { useRef, useState } from 'react'
import { api, apiUpload } from '../api'
import { AUDIO_FORMATS, IMAGE_FORMATS, MODEL_FORMATS, VIDEO_FORMATS } from '../ar/anchors'
import { relUrl } from '../ar/contentLoader'
import {
  MODEL_3D_FORMATS,
  MODEL_MAX_BYTES,
  MODEL_WARN_BYTES,
  formatOf,
  mb,
} from '../ar/modelAssets'

const OPTIMIZE_KEY = 'arOptimizeModels'
const readOptimizePref = () => {
  try {
    return localStorage.getItem(OPTIMIZE_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * The optimiser runs on the main thread and can freeze the tab for minutes on
 * studio-sized models. Above this size we skip it and upload the original, so
 * a big file can never block the upload.
 */
const OPTIMIZE_MAX_BYTES = 20 * 1024 * 1024
/** Never let a stuck optimiser stop the upload: fall back to the original. */
const OPTIMIZE_TIMEOUT_MS = 2 * 60 * 1000

/** Resolve with `promise`, or reject after `ms` so callers can fall back. */
const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} took longer than ${Math.round(ms / 1000)}s`)),
      ms
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })

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
 * `modelsOnly` (custom-model experiences): only .glb/.gltf files are useful.
 */
export default function AssetsPanel({
  projectId,
  assets,
  reload,
  onError,
  onNotice,
  selectedId,
  allowAudio = false,
  modelsOnly = false,
  title = 'Models & Media',
}) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('') // optimiser status line
  const [pct, setPct] = useState(0) // upload progress 0–100
  const [dragging, setDragging] = useState(false)
  const [uploadNote, setUploadNote] = useState(null) // inline result, hard to miss
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

  const formats = modelsOnly
    ? [...MODEL_FORMATS]
    : [...MODEL_FORMATS, ...VIDEO_FORMATS, ...IMAGE_FORMATS, ...(allowAudio ? AUDIO_FORMATS : [])]
  const accept = formats.map((f) => `.${f}`).join(',')

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setBusy(true)
    setPct(0)
    setUploadNote(null)
    onError('')
    const reports = []
    const skipped = []
    let uploaded = 0
    try {
      for (const file of files) {
        const ext = formatOf(file.name)
        if (!formats.includes(ext)) {
          throw new Error(`${file.name}: supported types are ${formats.map((f) => `.${f}`).join(', ')}`)
        }
        if (MODEL_3D_FORMATS.includes(ext)) {
          if (file.size > MODEL_MAX_BYTES) {
            throw new Error(`${file.name} is ${mb(file.size)}. 3D models must be 100 MB or smaller.`)
          }
          if (file.size > MODEL_WARN_BYTES) {
            const go = window.confirm(
              `${file.name} is ${mb(file.size)}. Large models can be slow to open on phones. Continue?`
            )
            if (!go) {
              skipped.push(file.name)
              continue
            }
          }
          if (ext === 'gltf') {
            const go = window.confirm(
              `${file.name} is a .gltf file. External .bin/texture files are not uploaded with it. ` +
                'A self-contained .glb is recommended. Continue?'
            )
            if (!go) {
              skipped.push(file.name)
              continue
            }
          }
        }
        let upload = file
        let optimized = false
        if (optimizeOn && ext === 'glb') {
          if (file.size > OPTIMIZE_MAX_BYTES) {
            reports.push(
              `${file.name}: ${mb(file.size)} is too large to optimise in the browser — uploaded as-is`
            )
          } else {
            try {
              const out = await withTimeout(
                optimizeModelFile(await file.arrayBuffer(), file.name, (label) =>
                  setProgress(`${file.name}: ${label}`)
                ),
                OPTIMIZE_TIMEOUT_MS,
                `Optimising ${file.name}`
              )
              upload = out.file
              optimized = true
              reports.push(describeReport(file.name, out.report))
            } catch (err) {
              console.warn('[optimizer] upload original', err)
              reports.push(
                `${file.name}: could not be optimised (${err.message}) — uploaded as-is`
              )
            }
          }
        }
        setProgress(`Uploading ${file.name}…`)
        setPct(0)
        const fd = new FormData()
        fd.append('project', projectId)
        fd.append('name', file.name.replace(/\.[^.]+$/, ''))
        fd.append('model_file', upload)
        fd.append('format', ext)
        fd.append('optimized', optimized ? 'true' : 'false')
        await apiUpload('/assets/', fd, { onProgress: setPct })
        uploaded += 1
      }
      if (uploaded) {
        const summary =
          `Uploaded ${uploaded} asset${uploaded === 1 ? '' : 's'}` +
          (reports.length ? ` — ${reports.join(' · ')}` : '.')
        onNotice(summary)
        setUploadNote({ kind: 'ok', text: summary })
      } else {
        const text = skipped.length
          ? `Skipped ${skipped.join(', ')} — nothing was uploaded.`
          : 'Nothing was uploaded.'
        onNotice(text)
        setUploadNote({ kind: 'warn', text })
      }
      await reload()
    } catch (err) {
      onError(err.message)
      setUploadNote({ kind: 'error', text: `Upload failed: ${err.message}` })
    } finally {
      setBusy(false)
      setProgress('')
      setPct(0)
    }
  }

  const upload = (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    uploadFiles(files)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    if (!busy) uploadFiles(e.dataTransfer?.files)
  }

  const onDragOver = (e) => {
    e.preventDefault()
    if (!busy) setDragging(true)
  }

  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false)
  }

  /** Optimise an already-uploaded .glb in place (replaces its file). */
  const optimizeExisting = async (asset, e) => {
    e?.stopPropagation?.()
    setBusy(true)
    setUploadNote(null)
    onError('')
    try {
      setProgress(`${asset.name}: downloading…`)
      const res = await fetch(relUrl(asset.model_file))
      if (!res.ok) throw new Error(`Could not download ${asset.name} (${res.status}).`)
      const name = `${asset.name.replace(/\.glb$/i, '') || 'model'}.glb`
      const { file, report } = await withTimeout(
        optimizeModelFile(await res.arrayBuffer(), name, (label) =>
          setProgress(`${asset.name}: ${label}`)
        ),
        OPTIMIZE_TIMEOUT_MS * 2,
        `Optimising ${asset.name}`
      )
      setProgress(`${asset.name}: uploading…`)
      const fd = new FormData()
      fd.append('model_file', file)
      fd.append('optimized', 'true')
      await api(`/assets/${asset.id}/`, { method: 'PATCH', formData: fd })
      const summary = `${describeReport(asset.name, report)}. Republish to update live links.`
      onNotice(summary)
      setUploadNote({ kind: 'ok', text: summary })
      await reload()
    } catch (err) {
      onError(err.message)
      setUploadNote({ kind: 'error', text: err.message })
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
    <div
      className={`panel-section asset-drop-zone ${dragging ? 'dragging' : ''}`}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="asset-drop-overlay" aria-hidden="true">
          <span>⬇</span>
          <strong>Drop to upload</strong>
        </div>
      )}
      <div className="panel-head">
        <button className="panel-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          <h2>{title}</h2>
          <span className="tiny muted panel-count">({assets.length})</span>
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
            title="Shrink textures, merge meshes and compress geometry before upload (.glb). Keeps the look; much faster on phones. Files over 20 MB are uploaded as-is because optimising them in the browser freezes the tab."
          >
            <input type="checkbox" checked={optimizeOn} onChange={(e) => toggleOptimize(e.target.checked)} disabled={busy} />
            <span>Optimize 3D models for AR</span>
          </label>
          {progress && (
            <div className="optimize-progress" role="status">
              <span className="compile-dot" aria-hidden="true" />
              <span>{progress}{busy && pct > 0 ? ` · ${pct}%` : ''}</span>
            </div>
          )}
          {busy && pct > 0 && (
            <div className="asset-upload-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
          )}
          {uploadNote && (
            <div
              className={`asset-upload-note ${uploadNote.kind}`}
              role={uploadNote.kind === 'error' ? 'alert' : 'status'}
            >
              {uploadNote.text}
            </div>
          )}
          {assets.length === 0 && (
            <p className="muted small-text">
              {modelsOnly ? (
                <>
                  Upload a 3D model (.glb or .gltf). A self-contained .glb keeps
                  its textures in one file and opens fastest on phones.
                </>
              ) : (
                <>
                  Upload 3D models (.glb/.gltf), videos (.mp4/.webm/.gif) or images (.png/.jpg/.webp)
                  {allowAudio ? ', plus sounds (.mp3/.wav/.ogg) for your game logic' : ''}.
                </>
              )}
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
