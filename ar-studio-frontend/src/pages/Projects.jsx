import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'

export default function Projects() {
  const [projects, setProjects] = useState(null)
  const [links, setLinks] = useState([])
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const [p, e] = await Promise.all([api('/projects/'), api('/experiences/')])
      setProjects(p.results ?? p)
      const exps = e.results ?? e
      setLinks(exps.filter((x) => x.published_slug))
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const create = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/projects/', { method: 'POST', body: { name, description } })
      setName('')
      setDescription('')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id) => {
    if (!confirm('Delete this project and all of its assets?')) return
    await api(`/projects/${id}/`, { method: 'DELETE' })
    await load()
  }

  const projectList = Array.isArray(projects) ? projects : projects?.results ?? []
  const projectName = (id) => projectList.find((p) => p.id === id)?.name ?? '—'

  return (
    <div>
      <div className="page-head">
        <h1>AR Studio</h1>
        <span className="muted">your projects &amp; published experiences</span>
      </div>
      {error && <div className="auth-error">{error}</div>}

      {links.length > 0 && (
        <section className="card">
          <h2>Published links</h2>
          {links.map((l) => (
            <div className="list-item" key={l.id}>
              <div className="grow">
                <div className="name">{l.name || 'Untitled experience'}</div>
                <div className="muted" style={{ fontSize: 12 }}>{projectName(l.project)}</div>
              </div>
              <input
                readOnly
                value={`${window.location.origin}/view/${l.published_slug}`}
                onFocus={(e) => e.target.select()}
                style={{ maxWidth: 320 }}
              />
              <button className="btn ghost small" onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/view/${l.published_slug}`)}>
                Copy
              </button>
              <a className="btn small" href={`/view/${l.published_slug}`} target="_blank" rel="noreferrer">
                Open
              </a>
            </div>
          ))}
        </section>
      )}

      <form className="card" onSubmit={create}>
        <h2>New project</h2>
        <div className="row">
          <input required placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
          <input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <button className="btn" disabled={busy}>{busy ? '…' : 'Create'}</button>
        </div>
      </form>

      {projects === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="grid">
            {projectList.map((p) => (
              <ProjectCard key={p.id} project={p} onDelete={() => remove(p.id)} />
            ))}
          </div>
          {projectList.length === 0 && <p className="muted">No projects yet — create one above.</p>}
        </>
      )}
    </div>
  )
}

function ProjectCard({ project, onDelete }) {
  return (
    <div className="card">
      <h2>
        <Link to={`/projects/${project.id}`}>{project.name}</Link>
      </h2>
      <p className="muted" style={{ minHeight: 40 }}>
        {project.description || 'No description'}
      </p>
      <div className="row" style={{ marginTop: 10 }}>
        <span className="badge">{project.slug}</span>
        <div className="spacer" />
        <Link className="btn small" to={`/projects/${project.id}`}>Open Studio</Link>
        <button className="btn ghost small" onClick={onDelete}>Delete</button>
      </div>
    </div>
  )
}
