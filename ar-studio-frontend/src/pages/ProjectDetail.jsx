import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import PreviewViewport from '../components/PreviewViewport'

const rel = (url) => {
  try {
    return new URL(url, window.location.origin).pathname
  } catch {
    return url
  }
}

export default function ProjectDetail() {
  const { id } = useParams()
  const [project, setProject] = useState(null)
  const [targets, setTargets] = useState([])
  const [assets, setAssets] = useState([])
  const [experiences, setExperiences] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedId, setSelectedId] = useState(null)

  const load = useCallback(async () => {
    try {
      const [p, t, a, e] = await Promise.all([
        api(`/projects/${id}/`),
        api(`/targets/?project=${id}`),
        api(`/assets/?project=${id}`),
        api(`/experiences/?project=${id}`),
      ])
      setProject(p)
      setTargets(t.results ?? t)
      setAssets(a.results ?? a)
      setExperiences(e.results ?? e)
    } catch (err) {
      setError(err.message)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const selected = experiences.find((e) => e.id === selectedId) || null
  const previewTarget = useMemo(
    () => targets.find((t) => t.id === selected?.target_image) || null,
    [targets, selected]
  )
  const previewAsset = useMemo(
    () => assets.find((a) => a.id === selected?.model_asset) || null,
    [assets, selected]
  )
  const previewTransform = selected
    ? {
        position: [selected.position_x, selected.position_y, selected.position_z],
        rotation: [selected.rotation_x, selected.rotation_y, selected.rotation_z],
        scale: selected.scale,
      }
    : null

  if (error && !project) return <div className="error-box">{error}</div>
  if (!project) return <p className="muted center">Loading…</p>

  return (
    <div className="studio">
      <div className="studio-top">
        <Link to="/" className="muted">← Projects</Link>
        <h1>{project.name}</h1>
        <span className="badge">{project.slug}</span>
        <div className="spacer" />
        {error && <span className="auth-error">{error}</span>}
        {notice && <span className="muted">{notice}</span>}
      </div>

      <div className="studio-grid">
        <aside className="panel">
          <TargetsPanel
            projectId={id}
            targets={targets}
            reload={load}
            onError={setError}
            onNotice={setNotice}
            selectedId={selected?.target_image}
          />
          <AssetsPanel
            projectId={id}
            assets={assets}
            reload={load}
            onError={setError}
            onNotice={setNotice}
            selectedId={selected?.model_asset}
          />
        </aside>

        <section className="panel viewport-panel">
          <PreviewViewport
            target={previewTarget}
            asset={previewAsset}
            transform={previewTransform}
          />
          <div className="viewport-hint">
            {selected
              ? `${selected.name || 'experience'} — drag to orbit · scroll to zoom`
              : 'Select an experience in the Inspector →'}
          </div>
        </section>

        <aside className="panel inspector">
          <InspectorPanel
            projectId={id}
            targets={targets}
            assets={assets}
            experiences={experiences}
            selected={selected}
            onSelect={setSelectedId}
            reload={load}
            onError={setError}
            onNotice={setNotice}
          />
        </aside>
      </div>
    </div>
  )
}

function TargetsPanel({ projectId, targets, reload, onError, onNotice, selectedId }) {
  const [busy, setBusy] = useState(false)

  const upload = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setBusy(true)
    onError('')
    try {
      for (const file of files) {
        const fd = new FormData()
        fd.append('project', projectId)
        fd.append('name', file.name.replace(/\.[^.]+$/, ''))
        fd.append('image', file)
        fd.append('target_width', 0.2)
        await api('/targets/', { method: 'POST', formData: fd })
      }
      onNotice(`Uploaded ${files.length} target${files.length > 1 ? 's' : ''}.`)
      e.target.value = ''
      await reload()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const register = async (targetId) => {
    onError('')
    try {
      const d = await api(`/targets/${targetId}/register/`, { method: 'POST' })
      onNotice(`Registered ${d.feature_count} features.`)
      await reload()
    } catch (err) {
      onError(err.message)
    }
  }

  const remove = async (targetId) => {
    if (!confirm('Delete this target image?')) return
    await api(`/targets/${targetId}/`, { method: 'DELETE' })
    await reload()
  }

  return (
    <div className="panel-section">
      <div className="panel-head">
        <h2>Targets</h2>
        <label className={`btn small ${busy ? 'ghost' : ''}`}>
          {busy ? '…' : '+ Upload'}
          <input type="file" accept="image/*" multiple hidden onChange={upload} disabled={busy} />
        </label>
      </div>
      {targets.length === 0 && (
        <p className="muted small-text">Drop detailed, high-contrast images. Multiple files supported.</p>
      )}
      <div className="asset-list">
        {targets.map((t) => (
          <div key={t.id} className={`asset-item ${selectedId === t.id ? 'active' : ''}`}>
            {t.image && <img className="thumb" src={rel(t.image)} alt="" />}
            <div className="grow">
              <div className="name">{t.name}</div>
              <div className="muted tiny">
                {t.target_width} m · {t.tracking_data ? '✓ features' : 'needs register'}
              </div>
            </div>
            <div className="item-actions">
              {!t.tracking_data && (
                <button className="btn small" onClick={() => register(t.id)}>Register</button>
              )}
              <button className="btn ghost small" onClick={() => remove(t.id)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AssetsPanel({ projectId, assets, reload, onError, onNotice, selectedId }) {
  const [busy, setBusy] = useState(false)

  const upload = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setBusy(true)
    onError('')
    try {
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase()
        if (!['glb', 'gltf'].includes(ext)) {
          throw new Error(`${file.name}: only .glb / .gltf are supported`)
        }
        const fd = new FormData()
        fd.append('project', projectId)
        fd.append('name', file.name.replace(/\.[^.]+$/, ''))
        fd.append('model_file', file)
        fd.append('format', ext)
        await api('/assets/', { method: 'POST', formData: fd })
      }
      onNotice(`Uploaded ${files.length} model${files.length > 1 ? 's' : ''}.`)
      e.target.value = ''
      await reload()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (assetId) => {
    if (!confirm('Delete this model?')) return
    await api(`/assets/${assetId}/`, { method: 'DELETE' })
    await reload()
  }

  return (
    <div className="panel-section">
      <div className="panel-head">
        <h2>Models</h2>
        <label className={`btn small ${busy ? 'ghost' : ''}`}>
          {busy ? '…' : '+ Upload'}
          <input type="file" accept=".glb,.gltf" multiple hidden onChange={upload} disabled={busy} />
        </label>
      </div>
      {assets.length === 0 && <p className="muted small-text">Upload .glb files. Multiple supported.</p>}
      <div className="asset-list">
        {assets.map((a) => (
          <div key={a.id} className={`asset-item ${selectedId === a.id ? 'active' : ''}`}>
            <div className="cube-icon">◆</div>
            <div className="grow">
              <div className="name">{a.name}</div>
              <div className="muted tiny">{a.format.toUpperCase()}</div>
            </div>
            <div className="item-actions">
              <button className="btn ghost small" onClick={() => remove(a.id)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function InspectorPanel({
  projectId,
  targets,
  assets,
  experiences,
  selected,
  onSelect,
  reload,
  onError,
  onNotice,
}) {
  const [targetId, setTargetId] = useState('')
  const [assetId, setAssetId] = useState('')
  const [expName, setExpName] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(null)
  const [slug, setSlug] = useState('')

  useEffect(() => {
    if (selected) {
      setForm({
        position_x: selected.position_x,
        position_y: selected.position_y,
        position_z: selected.position_z,
        rotation_x: selected.rotation_x,
        rotation_y: selected.rotation_y,
        rotation_z: selected.rotation_z,
        scale: selected.scale,
      })
      setSlug(selected.published_slug || '')
    } else {
      setForm(null)
      setSlug('')
    }
  }, [selected])

  const create = async (e) => {
    e.preventDefault()
    setBusy(true)
    onError('')
    try {
      const d = await api('/experiences/', {
        method: 'POST',
        body: {
          project: projectId,
          name: expName,
          target_image: targetId,
          model_asset: assetId,
        },
      })
      onNotice('Experience created.')
      setTargetId('')
      setAssetId('')
      setExpName('')
      await reload()
      onSelect(d.id)
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const saveTransform = async () => {
    if (!selected || !form) return
    setBusy(true)
    try {
      await api(`/experiences/${selected.id}/`, { method: 'PATCH', body: form })
      onNotice('Transform saved.')
      await reload()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    if (!selected) return
    setBusy(true)
    onError('')
    try {
      const body = slug.trim() ? { slug: slug.trim().toLowerCase() } : {}
      const d = await api(`/experiences/${selected.id}/publish/`, {
        method: 'POST',
        body,
      })
      setSlug(d.slug || slug)
      onNotice(`Published → ${d.url}`)
      await reload()
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!selected || !confirm('Delete this experience?')) return
    await api(`/experiences/${selected.id}/`, { method: 'DELETE' })
    onSelect(null)
    await reload()
  }

  const link = selected?.published_slug
    ? `${window.location.origin}/view/${selected.published_slug}`
    : null

  return (
    <>
      <div className="panel-section">
        <div className="panel-head"><h2>Inspector</h2></div>

        <form className="inspector-form" onSubmit={create}>
          <div className="tiny muted">New experience</div>
          <input placeholder="Name (optional)" value={expName} onChange={(e) => setExpName(e.target.value)} />
          <select required value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">choose target…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <select required value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">choose model…</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button className="btn small" disabled={busy || !targetId || !assetId}>+ Create</button>
        </form>
      </div>

      <div className="panel-section">
        <div className="panel-head"><h2>Experiences</h2></div>
        <div className="asset-list">
          {experiences.length === 0 && (
            <p className="muted small-text">Bind a target to a model to create one.</p>
          )}
          {experiences.map((exp) => (
            <div
              key={exp.id}
              className={`asset-item clickable ${selected?.id === exp.id ? 'active' : ''}`}
              onClick={() => onSelect(exp.id)}
            >
              <div className="grow">
                <div className="name">{exp.name || 'Untitled'}</div>
                <div className="muted tiny">
                  {targets.find((t) => t.id === exp.target_image)?.name ?? '?'} →{' '}
                  {assets.find((a) => a.id === exp.model_asset)?.name ?? '?'}
                </div>
              </div>
              <span className={`badge ${exp.status === 'published' ? 'ok' : 'warn'}`}>
                {exp.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      {selected && form && (
        <div className="panel-section">
          <div className="panel-head"><h2>Transform</h2></div>
          <Slider label="Pos X" v={form.position_x} min={-0.5} max={0.5} step={0.01} onChange={(v) => setForm({ ...form, position_x: v })} />
          <Slider label="Pos Y" v={form.position_y} min={-0.5} max={0.5} step={0.01} onChange={(v) => setForm({ ...form, position_y: v })} />
          <Slider label="Pos Z" v={form.position_z} min={-0.2} max={1} step={0.01} onChange={(v) => setForm({ ...form, position_z: v })} />
          <Slider label="Rot X" v={form.rotation_x} min={0} max={360} step={1} onChange={(v) => setForm({ ...form, rotation_x: v })} />
          <Slider label="Rot Y" v={form.rotation_y} min={0} max={360} step={1} onChange={(v) => setForm({ ...form, rotation_y: v })} />
          <Slider label="Rot Z" v={form.rotation_z} min={0} max={360} step={1} onChange={(v) => setForm({ ...form, rotation_z: v })} />
          <Slider label="Scale" v={form.scale} min={0.1} max={3} step={0.05} onChange={(v) => setForm({ ...form, scale: v })} />
          <div className="row">
            <button className="btn small" onClick={saveTransform} disabled={busy}>Save</button>
            <button className="btn danger small" onClick={remove} disabled={busy}>Delete</button>
          </div>
        </div>
      )}

      {selected && (
        <div className="panel-section">
          <div className="panel-head"><h2>Publish</h2></div>
          <div className="inspector-form">
            <div className="tiny muted">Custom link name</div>
            <input
              placeholder="e.g. my-drone-demo"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            <button className="btn small" onClick={publish} disabled={busy}>
              {selected.status === 'published' ? 'Republish' : 'Publish'}
            </button>
            {link && (
              <div className="publish-link">
                <input readOnly value={link} onFocus={(e) => e.target.select()} />
                <button className="btn ghost small" onClick={() => navigator.clipboard?.writeText(link)}>
                  Copy
                </button>
                <a className="btn small" href={link} target="_blank" rel="noreferrer">Open</a>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function Slider({ label, v, min, max, step, onChange }) {
  return (
    <div className="slider-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => onChange(Number(e.target.value))} />
      <input type="number" min={min} max={max} step={step} value={v} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  )
}
