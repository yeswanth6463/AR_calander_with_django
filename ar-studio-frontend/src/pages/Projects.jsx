import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { projectTypeMeta } from '../ar/anchors'
import NewProjectWizard from '../components/NewProjectWizard'

export default function Projects() {
  const [projects, setProjects] = useState(null)
  const [links, setLinks] = useState([])
  const [error, setError] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const navigate = useNavigate()

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

  // Wizard errors are shown inside the wizard (it re-throws).
  const create = async (body) => {
    const project = await api('/projects/', { method: 'POST', body })
    setWizardOpen(false)
    navigate(`/projects/${project.id}`)
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

      <section className="card new-project-card">
        <div className="grow">
          <h2>New project</h2>
          <p className="muted" style={{ margin: 0 }}>
            AR experience, AR game, face tracking or object detection — answer a few questions to set it up.
          </p>
        </div>
        <button className="btn primary" onClick={() => setWizardOpen(true)}>
          + New project
        </button>
      </section>
      {wizardOpen && <NewProjectWizard onCreate={create} onCancel={() => setWizardOpen(false)} />}

      {projects === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="grid">
            {projectList.map((p) => (
              <ProjectCard key={p.id} project={p} onDelete={() => remove(p.id)} />
            ))}
          </div>
          {projectList.length === 0 && <p className="muted">No projects yet — click “New project” to start.</p>}
        </>
      )}
    </div>
  )
}

function ProjectCard({ project, onDelete }) {
  const type = projectTypeMeta(project.project_type)
  return (
    <div className="card">
      <div className="project-type-badge">
        <span aria-hidden="true">{type.icon}</span> {type.title}
      </div>
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
