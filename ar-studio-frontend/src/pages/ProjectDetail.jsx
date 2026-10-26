import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import AnimationPanel from '../components/AnimationPanel'
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
  const [animationController, setAnimationController] = useState(null)
  const [animationExpanded, setAnimationExpanded] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [selectedItemId, setSelectedItemId] = useState(null)

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
  const selectedItems = useMemo(() => {
    if (!selected) return []
    if (selected.items && selected.items.length > 0) {
      return selected.items
    }
    if (selected.target_image && selected.model_asset) {
      return [
        {
          id: selected.id,
          target_image: selected.target_image,
          model_asset: selected.model_asset,
          position_x: selected.position_x ?? 0,
          position_y: selected.position_y ?? 0,
          position_z: selected.position_z ?? 0,
          rotation_x: selected.rotation_x ?? 0,
          rotation_y: selected.rotation_y ?? 0,
          rotation_z: selected.rotation_z ?? 0,
          scale: selected.scale ?? 1,
          scale_x: selected.scale_x ?? 1,
          scale_y: selected.scale_y ?? 1,
          scale_z: selected.scale_z ?? 1,
        },
      ]
    }
    return []
  }, [selected])
  const selectedItem =
    selectedItems.find((item) => item.id === selectedItemId) || null

  // Auto-select first experience if none selected
  useEffect(() => {
    if (!selectedId && experiences.length > 0) {
      setSelectedId(experiences[0].id)
    }
  }, [experiences, selectedId])

  // Keep a valid item of the active experience selected.
  useEffect(() => {
    if (selectedItems.length === 0) {
      setSelectedItemId(null)
      return
    }
    if (!selectedItems.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(selectedItems[0].id)
    }
  }, [selectedItems, selectedItemId])

  // Scene shown in the viewport: every item with its target + model resolved.
  const previewItems = useMemo(
    () =>
      selectedItems
        .map((item) => ({
          id: item.id,
          target: targets.find((t) => t.id === item.target_image) || null,
          asset: assets.find((a) => a.id === item.model_asset) || null,
          transform: {
            position: [item.position_x, item.position_y, item.position_z],
            rotation: [item.rotation_x, item.rotation_y, item.rotation_z],
            scale: [item.scale_x, item.scale_y, item.scale_z],
          },
        }))
        .filter((item) => item.target && item.asset),
    [selectedItems, targets, assets]
  )

  const updateTransform = useCallback(
    (itemId, values, commit) => {
      if (!itemId) return
      setExperiences((current) =>
        current.map((experience) => {
          if (experience.id !== selectedId) return experience
          const hasItem = (experience.items || []).some((item) => item.id === itemId)
          if (hasItem) {
            return {
              ...experience,
              items: experience.items.map((item) =>
                item.id === itemId ? { ...item, ...values } : item
              ),
            }
          }
          return {
            ...experience,
            ...values,
          }
        })
      )
      if (!commit) return

      const isRealItem = selected?.items?.some((item) => item.id === itemId)
      const endpoint = isRealItem ? `/items/${itemId}/` : `/experiences/${selectedId}/`
      api(endpoint, { method: 'PATCH', body: values })
        .then(() => setNotice('Transform saved.'))
        .catch((err) => setError(err.message))
    },
    [selectedId, selected]
  )

  const resetModelTransform = useCallback(() => {
    const defaultTransform = {
      position_x: 0,
      position_y: 0,
      position_z: 0,
      rotation_x: 0,
      rotation_y: 0,
      rotation_z: 0,
      scale_x: 1,
      scale_y: 1,
      scale_z: 1,
      scale: 1,
    }
    updateTransform(selectedItemId, defaultTransform, true)
  }, [updateTransform, selectedItemId])

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
            selectedId={selectedItem?.target_image}
          />
          <AssetsPanel
            projectId={id}
            assets={assets}
            reload={load}
            onError={setError}
            onNotice={setNotice}
            selectedId={selectedItem?.model_asset}
          />
          {animationController && (
            <div className="panel-section animation-section">
              <button
                className="panel-toggle"
                aria-expanded={animationExpanded}
                onClick={() => setAnimationExpanded((open) => !open)}
              >
                <h2>Animation</h2>
                <span aria-hidden="true">{animationExpanded ? '▾' : '▸'}</span>
              </button>
              {animationExpanded && (
                <AnimationPanel
                  controller={animationController}
                  className="sidebar-animation"
                />
              )}
            </div>
          )}
        </aside>

        <section className="panel viewport-panel">
          <PreviewViewport
            items={previewItems}
            selectedItemId={selectedItemId}
            onAnimationController={setAnimationController}
            onTransformChange={updateTransform}
          />
          <div className="viewport-hint">
            {selected
              ? `${selected.name || 'experience'} — ${previewItems.length} item${previewItems.length === 1 ? '' : 's'} · drag to orbit · scroll to zoom`
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
            items={selectedItems}
            selectedItemId={selectedItemId}
            onSelect={setSelectedId}
            onSelectItem={setSelectedItemId}
            reload={load}
            onError={setError}
            onNotice={setNotice}
            onTransformChange={updateTransform}
            onResetTransform={resetModelTransform}
          />
        </aside>
      </div>
    </div>
  )
}

function TargetsPanel({ projectId, targets, reload, onError, onNotice, selectedId }) {
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(true)

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
        <button
          className="panel-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <h2>Targets</h2>
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        </button>
        <label className={`btn small ${busy ? 'ghost' : ''}`}>
          {busy ? '…' : '+ Upload'}
          <input type="file" accept="image/*" multiple hidden onChange={upload} disabled={busy} />
        </label>
      </div>
      {expanded && (
        <>
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
        </>
      )}
    </div>
  )
}

function AssetsPanel({ projectId, assets, reload, onError, onNotice, selectedId }) {
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(true)

  const upload = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setBusy(true)
    onError('')
    try {
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase()
        if (!['glb', 'gltf', 'mp4', 'webm', 'gif'].includes(ext)) {
          throw new Error(`${file.name}: use .glb, .gltf, .mp4, .webm, or .gif`)
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

  const remove = async (assetId) => {
    if (!confirm('Delete this asset?')) return
    await api(`/assets/${assetId}/`, { method: 'DELETE' })
    await reload()
  }

  return (
    <div className="panel-section">
      <div className="panel-head">
        <button
          className="panel-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <h2>Models &amp; Media</h2>
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        </button>
        <label className={`btn small ${busy ? 'ghost' : ''}`}>
          {busy ? '…' : '+ Upload'}
          <input type="file" accept=".glb,.gltf,.mp4,.webm,.gif" multiple hidden onChange={upload} disabled={busy} />
        </label>
      </div>
      {expanded && (
        <>
          {assets.length === 0 && (
            <p className="muted small-text">Upload 3D models (.glb/.gltf) or animated media (.mp4/.webm/.gif).</p>
          )}
          <div className="asset-list">
            {assets.map((a) => (
              <div key={a.id} className={`asset-item ${selectedId === a.id ? 'active' : ''}`}>
                <div className="cube-icon">{['mp4', 'webm', 'gif'].includes(a.format) ? '▶' : '◆'}</div>
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
        </>
      )}
    </div>
  )
}

function InspectorPanel({
  projectId,
  targets,
  assets,
  experiences,
  selected,
  items,
  selectedItemId,
  onSelect,
  onSelectItem,
  reload,
  onError,
  onNotice,
  onTransformChange,
  onResetTransform,
}) {
  const [targetId, setTargetId] = useState('')
  const [assetId, setAssetId] = useState('')
  const [expName, setExpName] = useState('')
  const [busy, setBusy] = useState(false)
  const [slug, setSlug] = useState('')
  const [itemTargetId, setItemTargetId] = useState('')
  const [itemAssetId, setItemAssetId] = useState('')

  const selectedItem = items.find((item) => item.id === selectedItemId) || null

  useEffect(() => {
    if (selected) {
      setSlug(selected.published_slug || '')
    } else {
      setSlug('')
    }
  }, [selected])

  const addItem = async (e) => {
    e.preventDefault()
    if (!selected) return
    setBusy(true)
    onError('')
    try {
      const d = await api('/items/', {
        method: 'POST',
        body: {
          experience: selected.id,
          target_image: itemTargetId,
          model_asset: itemAssetId,
        },
      })
      onNotice('Item added to the scene.')
      setItemTargetId('')
      setItemAssetId('')
      await reload()
      onSelectItem?.(d.id)
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const removeItem = async (itemId) => {
    if (!confirm('Remove this item from the scene?')) return
    onError('')
    try {
      await api(`/items/${itemId}/`, { method: 'DELETE' })
      onNotice('Item removed.')
      const next = items.find((item) => item.id !== itemId)
      onSelectItem?.(next ? next.id : null)
      await reload()
    } catch (err) {
      onError(err.message)
    }
  }

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
            <option value="">choose model or media…</option>
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
                  {targets.find((t) => t.id === (exp.target_image ?? exp.items?.[0]?.target_image))?.name ?? '?'} →{' '}
                  {assets.find((a) => a.id === (exp.model_asset ?? exp.items?.[0]?.model_asset))?.name ?? '?'}
                  {exp.items?.length > 1 ? ` · ${exp.items.length} items` : ''}
                </div>
              </div>
              <span className={`badge ${exp.status === 'published' ? 'ok' : 'warn'}`}>
                {exp.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      {selected && (
        <div className="panel-section">
          <div className="panel-head"><h2>Scene items</h2></div>
          <div className="asset-list">
            {items.length === 0 && (
              <p className="muted small-text">
                No items yet — bind a target image + model below.
              </p>
            )}
            {items.map((item) => (
              <div
                key={item.id}
                className={`asset-item clickable ${selectedItemId === item.id ? 'active' : ''}`}
                onClick={() => onSelectItem?.(item.id)}
              >
                <div className="grow">
                  <div className="name">
                    {targets.find((t) => t.id === item.target_image)?.name ?? '?'} →{' '}
                    {assets.find((a) => a.id === item.model_asset)?.name ?? '?'}
                  </div>
                  <div className="muted tiny">
                    {selectedItemId === item.id ? 'editing' : 'click to edit'}
                  </div>
                </div>
                <div className="item-actions">
                  <button
                    className="btn ghost small"
                    title="Remove item"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeItem(item.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
          <form className="inspector-form" onSubmit={addItem}>
            <div className="tiny muted">Add item (marker + model)</div>
            <select
              required
              value={itemTargetId}
              onChange={(e) => setItemTargetId(e.target.value)}
            >
              <option value="">choose target…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <select
              required
              value={itemAssetId}
              onChange={(e) => setItemAssetId(e.target.value)}
            >
              <option value="">choose model or media…</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <button
              className="btn small"
              disabled={busy || !itemTargetId || !itemAssetId}
            >
              + Add item
            </button>
          </form>
        </div>
      )}

      {selectedItem && (
        <div className="panel-section transform-section">
          <div className="panel-head">
            <h2>Transform</h2>
            <button
              type="button"
              className="btn-reset-transform"
              onClick={onResetTransform}
              title="Reset position to 0, rotation to 0, scale to 1"
            >
              ↺ Reset
            </button>
          </div>
          <div className="transform-axis-head">
            <span />
            <span>X</span>
            <span>Y</span>
            <span>Z</span>
          </div>
          <TransformRow
            label="Position"
            fields={[
              ['position_x', selectedItem.position_x],
              ['position_y', selectedItem.position_y],
              ['position_z', selectedItem.position_z],
            ]}
            onChange={(values, commit) =>
              onTransformChange(selectedItem.id, values, commit)
            }
          />
          <TransformRow
            label="Rotation"
            fields={[
              ['rotation_x', selectedItem.rotation_x],
              ['rotation_y', selectedItem.rotation_y],
              ['rotation_z', selectedItem.rotation_z],
            ]}
            onChange={(values, commit) =>
              onTransformChange(selectedItem.id, values, commit)
            }
          />
          <TransformRow
            label="Scale"
            fields={[
              ['scale_x', selectedItem.scale_x],
              ['scale_y', selectedItem.scale_y],
              ['scale_z', selectedItem.scale_z],
            ]}
            onChange={(values, commit) =>
              onTransformChange(selectedItem.id, values, commit)
            }
          />
          <button
            type="button"
            className="reset-model-btn"
            onClick={onResetTransform}
            title="Reset all model transform properties (position, rotation, scale)"
          >
            <span>↺</span> Reset Model Transform
          </button>
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
            <div className="row">
              <button className="btn small" onClick={publish} disabled={busy}>
                {selected.status === 'published' ? 'Republish' : 'Publish'}
              </button>
              <button className="btn danger small" onClick={remove} disabled={busy}>
                Delete experience
              </button>
            </div>
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

function TransformRow({ label, fields, onChange }) {
  return (
    <div className="transform-axis-row">
      <span>{label}</span>
      {fields.map(([field, value], index) => (
        <input
          key={`${field}-${index}`}
          type="number"
          step={field.startsWith('rotation_') ? 1 : 0.01}
          min={field === 'scale' ? 0.01 : undefined}
          value={Number((Number(value) || 0).toFixed(3))}
          aria-label={`${label} ${'XYZ'[index]}`}
          onChange={(event) => {
            if (event.target.value === '') return
            const nextValue = Number(event.target.value)
            if (Number.isFinite(nextValue) && (field !== 'scale' || nextValue > 0)) {
              onChange({ [field]: nextValue }, false)
            }
          }}
          onBlur={(event) => {
            const nextValue = Number(event.target.value)
            if (Number.isFinite(nextValue) && (field !== 'scale' || nextValue > 0)) {
              onChange({ [field]: nextValue }, true)
            }
          }}
        />
      ))}
    </div>
  )
}
