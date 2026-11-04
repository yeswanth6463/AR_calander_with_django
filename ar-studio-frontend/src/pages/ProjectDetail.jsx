import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import AnimationPanel from '../components/AnimationPanel'
import PreviewViewport from '../components/PreviewViewport'
import TargetFeatureModal from '../components/TargetFeatureModal'

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
  const [previewTarget, setPreviewTarget] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedItemId, setSelectedItemId] = useState(null)
  const [publishIds, setPublishIds] = useState(() => new Set())

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

  useEffect(() => {
    const live = new Set(experiences.map((exp) => exp.id))
    setPublishIds((current) => {
      const next = new Set([...current].filter((id) => live.has(id)))
      return next.size === current.size ? current : next
    })
  }, [experiences])

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
          animation: item.animation || null,
        }))
        .filter((item) => item.target && item.asset),
    [selectedItems, targets, assets]
  )

  const experiencesRef = useRef(experiences)
  const draftRef = useRef(new Map())
  useEffect(() => {
    experiencesRef.current = experiences
  }, [experiences])

  const updateTransform = useCallback(
    (itemId, values, commit) => {
      if (!itemId) return
      const prev = draftRef.current.get(itemId) || {}
      draftRef.current.set(itemId, { ...prev, ...values })
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

      const exp = experiencesRef.current.find((e) => e.id === selectedId)
      const isRealItem = (exp?.items || []).some((item) => item.id === itemId)
      const endpoint = isRealItem ? `/items/${itemId}/` : `/experiences/${selectedId}/`
      api(endpoint, { method: 'PATCH', body: values })
        .then(() => setNotice(values.animation ? 'Animation saved.' : 'Transform saved.'))
        .catch((err) => setError(err.message))
    },
    [selectedId]
  )

  const flushTransforms = useCallback(async () => {
    const exp = experiencesRef.current.find((e) => e.id === selectedId)
    const rows = exp?.items || []
    await Promise.all(
      rows.map((item) => {
        const draft = draftRef.current.get(item.id) || {}
        const merged = { ...item, ...draft }
        return api(`/items/${item.id}/`, {
          method: 'PATCH',
          body: {
            position_x: merged.position_x,
            position_y: merged.position_y,
            position_z: merged.position_z,
            rotation_x: merged.rotation_x,
            rotation_y: merged.rotation_y,
            rotation_z: merged.rotation_z,
            scale: merged.scale,
            scale_x: merged.scale_x,
            scale_y: merged.scale_y,
            scale_z: merged.scale_z,
            animation: merged.animation || null,
            is_active: merged.is_active !== false,
          },
        })
      })
    )
  }, [selectedId])

  useEffect(() => {
    if (!animationController?.subscribeConfig || !selectedItemId) return
    let last = JSON.stringify(animationController.getConfig?.() || {})
    return animationController.subscribeConfig((cfg) => {
      const serialized = JSON.stringify(cfg)
      if (serialized === last) return
      last = serialized
      updateTransform(selectedItemId, { animation: cfg }, true)
    })
  }, [animationController, selectedItemId, updateTransform])

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

  const [toolbarSlots, setToolbarSlots] = useState({ nav: null, status: null })
  useLayoutEffect(() => {
    setToolbarSlots({
      nav: document.getElementById('studio-nav-slot'),
      status: document.getElementById('studio-status-slot'),
    })
  }, [])

  if (error && !project) return <div className="error-box">{error}</div>
  if (!project) return <p className="muted center">Loading…</p>

  const breadcrumb = (
    <>
      <Link to="/" className="studio-back">Projects</Link>
      <span className="studio-crumb" aria-hidden="true">/</span>
      <h1>{project.name}</h1>
      <span className="badge">{project.slug}</span>
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
      {toolbarSlots.nav
        ? createPortal(breadcrumb, toolbarSlots.nav)
        : <div className="studio-top">{breadcrumb}</div>}
      {toolbarSlots.status && createPortal(status, toolbarSlots.status)}

      <div className="studio-grid">
        <aside className="panel sidebar editor-side">
          <div className="side-project">
            <div className="side-project-name">{project.name}</div>
            <div className="tiny muted">{project.slug}</div>
          </div>
          <div className="side-scroll">
            <TargetsPanel
              projectId={id}
              targets={targets}
              reload={load}
              onError={setError}
              onNotice={setNotice}
              selectedId={selectedItem?.target_image}
              onPreviewTarget={setPreviewTarget}
            />
            <AssetsPanel
              projectId={id}
              assets={assets}
              reload={load}
              onError={setError}
              onNotice={setNotice}
              selectedId={selectedItem?.model_asset}
            />
          </div>
          <div className="side-dock">
            <button
              className="panel-toggle"
              aria-expanded={animationExpanded}
              onClick={() => setAnimationExpanded((open) => !open)}
            >
              <h2>Animation</h2>
              <span aria-hidden="true">{animationExpanded ? '▾' : '▸'}</span>
            </button>
            {animationExpanded && animationController && (
              <AnimationPanel
                controller={animationController}
                className="sidebar-animation"
              />
            )}
            {animationExpanded && !animationController && (
              <p className="muted tiny">Select a model with clips to play it here.</p>
            )}
          </div>
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
              : 'Select a scene in the right panel'}
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
            onFlushTransforms={flushTransforms}
            sceneItemCount={selectedItems.length}
            publishIds={publishIds}
            onTogglePublish={(sceneId) => {
              setPublishIds((current) => {
                const next = new Set(current)
                if (next.has(sceneId)) next.delete(sceneId)
                else next.add(sceneId)
                return next
              })
            }}
            onToggleAll={() => {
              setPublishIds((current) => (
                current.size === experiences.length
                  ? new Set()
                  : new Set(experiences.map((exp) => exp.id))
              ))
            }}
            publicationSlug={project?.publication_slug || ''}
          />
        </aside>
      </div>

      {previewTarget && (
        <TargetFeatureModal
          target={previewTarget}
          onClose={() => setPreviewTarget(null)}
        />
      )}
    </div>
  )
}

function TargetsPanel({ projectId, targets, reload, onError, onNotice, selectedId, onPreviewTarget }) {
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

  const remove = async (targetId, e) => {
    e?.stopPropagation?.()
    e?.preventDefault?.()
    if (!confirm('Delete this target image? Scene items that use it will be removed.')) return
    onError('')
    try {
      await api(`/targets/${targetId}/`, { method: 'DELETE' })
      onNotice('Target deleted.')
      await reload()
    } catch (err) {
      onError(err.message)
    }
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
          <div className="tree-list">
            {targets.map((t) => (
              <div key={t.id} className={`tree-row target-tree-row ${selectedId === t.id ? 'active' : ''}`}>
                {t.image && (
                  <img
                    className="tree-thumb clickable-target-thumb"
                    src={rel(t.image)}
                    alt={t.name}
                    title="Click to preview OpenCV feature tracking points"
                    onClick={() => onPreviewTarget?.(t)}
                  />
                )}
                <span
                  className="tree-label clickable-target-label"
                  title="Click to preview OpenCV feature tracking points"
                  onClick={() => onPreviewTarget?.(t)}
                >
                  <span className="name">{t.name}</span>
                  <span className="tiny muted">
                    {t.target_width} m · {t.tracking_data ? 'tracked' : 'unregistered'}
                  </span>
                </span>
                <div className="item-actions">
                  <button
                    type="button"
                    className="btn ghost small target-feature-pill-btn"
                    title="Preview Target Features (Grayscale & Red Circles)"
                    onClick={(e) => {
                      e.stopPropagation()
                      onPreviewTarget?.(t)
                    }}
                  >
                    🎯 Features
                  </button>
                  {!t.tracking_data && (
                    <button className="btn small" onClick={() => register(t.id)}>Register</button>
                  )}
                  <button
                    type="button"
                    className="btn ghost small"
                    title="Delete target"
                    onClick={(e) => remove(t.id, e)}
                  >
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

  const remove = async (assetId, e) => {
    e?.stopPropagation?.()
    e?.preventDefault?.()
    if (!confirm('Delete this model? Scene items that use it will be removed.')) return
    onError('')
    try {
      await api(`/assets/${assetId}/`, { method: 'DELETE' })
      onNotice('Model deleted.')
      await reload()
    } catch (err) {
      onError(err.message)
    }
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
          <div className="tree-list">
            {assets.map((a) => (
              <div key={a.id} className={`tree-row ${selectedId === a.id ? 'active' : ''}`}>
                <span className="tree-ico">{['mp4', 'webm', 'gif'].includes(a.format) ? '▶' : '◆'}</span>
                <span className="tree-label">
                  <span className="name">{a.name}</span>
                  <span className="tiny muted">{a.format.toUpperCase()}</span>
                </span>
                <div className="item-actions">
                  <button
                    type="button"
                    className="btn ghost small"
                    title="Delete model"
                    onClick={(e) => remove(a.id, e)}
                  >
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
  onFlushTransforms,
  sceneItemCount = 0,
  publishIds,
  onTogglePublish,
  onToggleAll,
  publicationSlug = '',
}) {
  const [targetId, setTargetId] = useState('')
  const [assetId, setAssetId] = useState('')
  const [expName, setExpName] = useState('')
  const [busy, setBusy] = useState(false)
  const [slug, setSlug] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [published, setPublished] = useState(null)
  const [itemTargetId, setItemTargetId] = useState('')
  const [itemAssetId, setItemAssetId] = useState('')
  const [showNewScene, setShowNewScene] = useState(experiences.length === 0)

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
      setShowNewScene(false)
      await reload()
      onSelect(d.id)
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const selectedScenes = experiences.filter((exp) => publishIds?.has(exp.id))

  const askPublish = () => {
    onError('')
    if (!selectedScenes.length) {
      onError('Select at least one scene to publish.')
      return
    }
    setConfirmOpen(true)
  }

  const publish = async () => {
    if (!selectedScenes.length) {
      onError('Select at least one scene to publish.')
      setConfirmOpen(false)
      return
    }
    setBusy(true)
    onError('')
    try {
      if (onFlushTransforms) await onFlushTransforms()
      const body = {
        scene_ids: selectedScenes.map((exp) => exp.id),
      }
      if (slug.trim()) body.slug = slug.trim().toLowerCase()
      const d = await api(`/projects/${projectId}/publish/`, {
        method: 'POST',
        body,
      })
      setSlug(d.slug || slug)
      setConfirmOpen(false)
      setPublished(d)
      onNotice(`Published ${d.scene_count} scene${d.scene_count === 1 ? '' : 's'} on one link.`)
      await reload()
    } catch (err) {
      setConfirmOpen(false)
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (experienceId) => {
    const id = experienceId || selected?.id
    if (!id || !confirm('Delete this experience?')) return
    onError('')
    try {
      await api(`/experiences/${id}/`, { method: 'DELETE' })
      if (selected?.id === id) onSelect(null)
      onNotice('Experience deleted.')
      await reload()
    } catch (err) {
      onError(err.message)
    }
  }

  const sharePath = published?.url
    || (publicationSlug ? `/view/${publicationSlug}` : '')
  const link = sharePath
    ? (sharePath.startsWith('http') ? sharePath : `${window.location.origin}${sharePath}`)
    : published?.share_url || null

  return (
    <>
      <div className="inspector-bar">
        <div className="inspector-bar-title">
          <strong>{selected?.name || 'Inspector'}</strong>
          <span className="tiny muted">{sceneItemCount} item{sceneItemCount === 1 ? '' : 's'}</span>
        </div>
        {selected && (
          <div className="inspector-bar-actions">
            {link && (
              <a className="btn ghost small" href={link} target="_blank" rel="noreferrer">Open</a>
            )}
            <button className="btn primary small" onClick={askPublish} disabled={busy}>
              {publishIds?.size ? `Publish ${publishIds.size}` : 'Publish'}
            </button>
          </div>
        )}
      </div>

      {/* Flat Models Flow (Separate models with checkboxes) */}
      <div className="panel-section">
        <div className="panel-head">
          <div className="model-list-title">
            <h2>Models</h2>
            <span className="tiny muted">({experiences.length})</span>
          </div>
          <div className="model-list-actions">
            {experiences.length > 0 && (
              <button type="button" className="text-btn" onClick={onToggleAll}>
                {publishIds?.size === experiences.length ? 'Deselect all' : 'Select all'}
              </button>
            )}
            <button
              type="button"
              className="btn ghost small"
              onClick={() => setShowNewScene((prev) => !prev)}
            >
              {showNewScene ? '✕ Cancel' : '+ Add model'}
            </button>
          </div>
        </div>

        {showNewScene && (
          <form className="model-add-form" onSubmit={create}>
            <div className="tiny muted" style={{ fontWeight: 600 }}>New 3D Model placement</div>
            <select required value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">Select target marker…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select required value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">Select 3D model or media…</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <input
              placeholder="Name (optional)"
              value={expName}
              onChange={(e) => setExpName(e.target.value)}
            />
            <button className="btn small add-wide" disabled={busy || !targetId || !assetId}>
              Add model
            </button>
          </form>
        )}

        {experiences.length === 0 && !showNewScene && (
          <p className="muted tiny">No models added yet. Click &quot;+ Add model&quot; to create one.</p>
        )}

        <div className="models-flat-list">
          {experiences.map((exp) => {
            const isSelected = selected?.id === exp.id
            const target = targets.find(
              (t) => t.id === (exp.target_image ?? exp.items?.[0]?.target_image)
            )
            const asset = assets.find(
              (a) => a.id === (exp.model_asset ?? exp.items?.[0]?.model_asset)
            )
            const targetName = target?.name || 'Target'
            const assetName = asset?.name || 'Model'

            return (
              <div
                key={exp.id}
                className={`model-item-row ${isSelected ? 'active' : ''}`}
                onClick={() => onSelect(exp.id)}
              >
                <input
                  type="checkbox"
                  className="scene-check"
                  checked={publishIds?.has(exp.id) ?? false}
                  aria-label={`Include ${targetName} ${assetName} in publish`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => onTogglePublish?.(exp.id)}
                />
                <div className="model-item-content">
                  <div className="model-item-title">
                    <span className="target-name">{targetName}</span>
                    <span className="model-sep"> · </span>
                    <span className="model-name">{assetName}</span>
                  </div>
                  {exp.name && exp.name !== `${targetName} · ${assetName}` ? (
                    <div className="tiny muted">{exp.name}</div>
                  ) : null}
                </div>
                <span className={`badge ${exp.status === 'published' ? 'ok' : ''}`}>
                  {exp.status}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  title="Delete model"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(exp.id)
                  }}
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>

        {experiences.length > 0 && (
          <p className="tiny muted scene-count">
            {publishIds?.size || 0} of {experiences.length} model
            {experiences.length === 1 ? '' : 's'} selected
          </p>
        )}
      </div>

      {selectedItem && (
        <div className="panel-section transform-section">
          <div className="panel-head">
            <div className="transform-title-wrap">
              <h2>Transform</h2>
              <span className="tiny muted">
                {targets.find((t) => t.id === selectedItem.target_image)?.name ?? 'Marker'} →{' '}
                {assets.find((a) => a.id === selectedItem.model_asset)?.name ?? 'Model'}
              </span>
            </div>
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
            itemId={selectedItemId}
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
            itemId={selectedItemId}
            step={1}
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
            itemId={selectedItemId}
            step={0.05}
          />
        </div>
      )}

      {selected && (
        <div className="panel-section">
          <div className="panel-head"><h2>Publish</h2></div>
          <div className="inspector-form">
            <div className="tiny muted">
              One link for the checked scenes
              {publishIds?.size ? ` (${publishIds.size} selected)` : ''}.
              {sceneItemCount ? '' : ''}
            </div>
            <div className="tiny muted">Custom link name</div>
            <input
              placeholder="e.g. my-drone-demo"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            <button className="btn danger small add-wide" onClick={() => remove(selected.id)} disabled={busy}>
              Delete experience
            </button>
            {link && (
              <div className="publish-link">
                <input readOnly value={link} onFocus={(e) => e.target.select()} />
                <button className="btn ghost small" onClick={() => navigator.clipboard?.writeText(link)}>
                  Copy
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {confirmOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => !busy && setConfirmOpen(false)}>
          <div className="modal-card" role="dialog" aria-labelledby="publish-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="publish-title">Publish experience</h3>
            <p>
              You are about to publish {selectedScenes.length} scene{selectedScenes.length === 1 ? '' : 's'} under one shareable link.
            </p>
            <ul className="modal-list">
              {selectedScenes.map((exp) => (
                <li key={exp.id}>{exp.name || 'Untitled'}</li>
              ))}
            </ul>
            <div className="row">
              <button type="button" className="btn ghost small" onClick={() => setConfirmOpen(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn primary small" onClick={publish} disabled={busy}>
                {busy ? 'Publishing…' : `Publish ${selectedScenes.length} scene${selectedScenes.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}
      {published && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPublished(null)}>
          <div className="modal-card" role="dialog" aria-labelledby="published-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="published-title">Experience published</h3>
            <p>
              Your {published.scene_count} scene{published.scene_count === 1 ? '' : 's'} are available through one link.
            </p>
            <input readOnly value={published.share_url || link || ''} onFocus={(e) => e.target.select()} />
            <div className="row">
              <button
                type="button"
                className="btn ghost small"
                onClick={() => navigator.clipboard?.writeText(published.share_url || link || '')}
              >
                Copy link
              </button>
              <a className="btn small" href={published.url || sharePath} target="_blank" rel="noreferrer">Open experience</a>
              <button type="button" className="btn ghost small" onClick={() => setPublished(null)}>Close</button>
            </div>
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
