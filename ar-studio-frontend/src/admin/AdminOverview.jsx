import React, { useEffect, useState } from 'react'
import { adminApi } from './adminApi'

function MetricCard({ title, value, subtitle, icon, color = '#3b82f6' }) {
  return (
    <div style={{
      background: 'var(--bg-panel, #1e293b)',
      borderRadius: '12px',
      padding: '20px',
      border: '1px solid rgba(255,255,255,0.06)',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '14px', color: '#94a3b8', fontWeight: '500' }}>{title}</span>
        <span style={{ fontSize: '20px', background: `${color}20`, color, padding: '6px', borderRadius: '8px' }}>{icon}</span>
      </div>
      <div style={{ fontSize: '28px', fontWeight: 'bold', color: '#f8fafc' }}>{value}</div>
      {subtitle && <div style={{ fontSize: '13px', color: '#64748b' }}>{subtitle}</div>}
    </div>
  )
}

export default function AdminOverview() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    adminApi.getOverview()
      .then((res) => setData(res))
      .catch((err) => setError(err.message || 'Failed to load metrics.'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ color: '#94a3b8' }}>Loading metrics…</div>
  if (error) return <div style={{ color: '#ef4444' }}>{error}</div>
  if (!data) return null

  const m = data.metrics || {}
  const formatBytes = (bytes) => {
    if (!bytes) return '0 MB'
    const mb = bytes / (1024 * 1024)
    return mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      <div>
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 6px 0' }}>Dashboard Overview</h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>High-level business & resource analytics for the AR platform.</p>
      </div>

      {/* Grid of Metric Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
        <MetricCard title="Registered Users" value={m.total_users} subtitle={`${m.active_users} active`} icon="👥" color="#3b82f6" />
        <MetricCard title="Organizations" value={m.total_organizations} subtitle={`${m.active_organizations} active enterprise`} icon="🏢" color="#8b5cf6" />
        <MetricCard title="AR Projects" value={m.total_projects} subtitle={`${m.active_projects} published / active`} icon="🎯" color="#10b981" />
        <MetricCard title="3D Assets" value={m.total_assets} subtitle={`${m.shared_assets} shared approved`} icon="📦" color="#f59e0b" />
        <MetricCard title="Storage Consumed" value={formatBytes(m.total_storage_bytes)} subtitle="Across all models & assets" icon="💾" color="#ec4899" />
      </div>

      {/* Recent Activity Sections */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        {/* Recent Users */}
        <div style={{ background: 'var(--bg-panel, #1e293b)', borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <h3 style={{ fontSize: '16px', margin: '0 0 16px 0', fontWeight: '600' }}>Recent Registrations</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {(data.recent_users || []).map((u) => (
              <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '10px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: '500' }}>{u.email}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>Role: {u.role} · Tier: {u.customer_type}</div>
                </div>
                <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                  {u.created_at ? new Date(u.created_at).toLocaleDateString() : ''}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Projects */}
        <div style={{ background: 'var(--bg-panel, #1e293b)', borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <h3 style={{ fontSize: '16px', margin: '0 0 16px 0', fontWeight: '600' }}>Recently Created Projects</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {(data.recent_projects || []).map((p) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '10px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: '500' }}>{p.name}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>Type: {p.project_type} {p.organization_name ? `(${p.organization_name})` : ''}</div>
                </div>
                <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                  {p.created_at ? new Date(p.created_at).toLocaleDateString() : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
