import React, { useEffect, useState } from 'react'
import { adminApi } from './adminApi'

export default function AdminProjects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    adminApi.getProjects()
      .then((res) => setProjects(res.projects || []))
      .catch((err) => setError(err.message || 'Failed to load projects.'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 6px 0' }}>AR Project Oversight</h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>Review all AR experiences across the platform.</p>
      </div>

      {error && <div style={{ color: '#ef4444' }}>{error}</div>}

      <div style={{ background: 'var(--bg-panel, #1e293b)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8' }}>
              <th style={{ padding: '14px 16px' }}>Project Name</th>
              <th style={{ padding: '14px 16px' }}>Type</th>
              <th style={{ padding: '14px 16px' }}>Owner</th>
              <th style={{ padding: '14px 16px' }}>Workspace</th>
              <th style={{ padding: '14px 16px' }}>Created</th>
              <th style={{ padding: '14px 16px' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>Loading projects…</td></tr>
            ) : projects.length === 0 ? (
              <tr><td colSpan="6" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>No projects found.</td></tr>
            ) : (
              projects.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '14px 16px', fontWeight: '500' }}>
                    <div>{p.name}</div>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>/{p.slug}</div>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{ fontSize: '12px', background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', padding: '3px 8px', borderRadius: '4px' }}>
                      {p.project_type}
                    </span>
                  </td>
                  <td style={{ padding: '14px 16px' }}>{p.user_email || '—'}</td>
                  <td style={{ padding: '14px 16px' }}>{p.organization_name || 'Individual'}</td>
                  <td style={{ padding: '14px 16px', color: '#94a3b8' }}>
                    {p.created_at ? new Date(p.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{
                      padding: '3px 8px',
                      borderRadius: '12px',
                      fontSize: '12px',
                      fontWeight: '500',
                      background: p.is_active ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                      color: p.is_active ? '#22c55e' : '#ef4444',
                    }}>
                      {p.is_active ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
