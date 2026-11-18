import React, { useEffect, useState } from 'react'
import { adminApi } from './adminApi'

export default function AdminOrganizations() {
  const [orgs, setOrgs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newOrgName, setNewOrgName] = useState('')
  const [creating, setCreating] = useState(false)

  const fetchOrgs = () => {
    setLoading(true)
    adminApi.getOrganizations()
      .then((res) => setOrgs(res.organizations || []))
      .catch((err) => setError(err.message || 'Failed to load organizations.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchOrgs()
  }, [])

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!newOrgName.trim()) return
    setCreating(true)
    try {
      await adminApi.createOrganization({ name: newOrgName.trim() })
      setNewOrgName('')
      setShowCreate(false)
      fetchOrgs()
    } catch (err) {
      alert(err.message || 'Could not create organization.')
    } finally {
      setCreating(false)
    }
  }

  const formatBytes = (bytes) => {
    if (!bytes) return '0 MB'
    const mb = bytes / (1024 * 1024)
    return mb > 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 6px 0' }}>Organization Management</h1>
          <p style={{ color: '#94a3b8', margin: 0 }}>Enterprise workspaces, member seats, and organization storage limits.</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            padding: '8px 16px',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
          }}
        >
          {showCreate ? 'Cancel' : '+ New Organization'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} style={{ background: 'var(--bg-panel, #1e293b)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', gap: '12px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Organization name (e.g. Acme Studio Inc)…"
            value={newOrgName}
            onChange={(e) => setNewOrgName(e.target.value)}
            style={{
              padding: '8px 14px',
              background: '#0f172a',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '6px',
              color: '#fff',
              fontSize: '14px',
              flex: 1,
            }}
          />
          <button
            type="submit"
            disabled={creating}
            style={{
              padding: '8px 16px',
              background: '#10b981',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '500',
            }}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      {error && <div style={{ color: '#ef4444' }}>{error}</div>}

      <div style={{ background: 'var(--bg-panel, #1e293b)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8' }}>
              <th style={{ padding: '14px 16px' }}>Organization</th>
              <th style={{ padding: '14px 16px' }}>Owner</th>
              <th style={{ padding: '14px 16px' }}>Members</th>
              <th style={{ padding: '14px 16px' }}>Projects</th>
              <th style={{ padding: '14px 16px' }}>Storage Limit</th>
              <th style={{ padding: '14px 16px' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>Loading organizations…</td></tr>
            ) : orgs.length === 0 ? (
              <tr><td colSpan="6" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>No organizations yet. Create one above!</td></tr>
            ) : (
              orgs.map((o) => (
                <tr key={o.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '14px 16px', fontWeight: '500' }}>
                    <div>{o.name}</div>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>/{o.slug}</div>
                  </td>
                  <td style={{ padding: '14px 16px' }}>{o.owner_email}</td>
                  <td style={{ padding: '14px 16px' }}>{o.member_count}</td>
                  <td style={{ padding: '14px 16px' }}>{o.project_count}</td>
                  <td style={{ padding: '14px 16px' }}>
                    {formatBytes(o.storage_used_bytes)} / {formatBytes(o.storage_limit_bytes)}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{
                      padding: '3px 8px',
                      borderRadius: '12px',
                      fontSize: '12px',
                      fontWeight: '500',
                      background: o.is_active ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                      color: o.is_active ? '#22c55e' : '#ef4444',
                    }}>
                      {o.is_active ? 'Active' : 'Suspended'}
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
