import React, { useEffect, useState } from 'react'
import { adminApi } from './adminApi'

export default function AdminAssets() {
  const [assets, setAssets] = useState([])
  const [statusFilter, setStatusFilter] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actingId, setActingId] = useState(null)

  const fetchAssets = () => {
    setLoading(true)
    adminApi.getAssetsModeration(statusFilter)
      .then((res) => setAssets(res.assets || []))
      .catch((err) => setError(err.message || 'Failed to load assets.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchAssets()
  }, [statusFilter])

  const handleModeration = async (assetId, action) => {
    setActingId(assetId)
    try {
      await adminApi.moderateAsset(assetId, action)
      setAssets((prev) => prev.filter((a) => a.id !== assetId))
    } catch (err) {
      alert(err.message || 'Could not moderate asset.')
    } finally {
      setActingId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 6px 0' }}>3D Asset Moderation & Shared Library</h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>Review user submissions for the public shared 3D asset marketplace.</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '8px' }}>
        {['pending', 'approved', 'rejected'].map((tab) => (
          <button
            key={tab}
            onClick={() => setStatusFilter(tab)}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: statusFilter === tab ? '#2563eb' : 'var(--bg-panel, #1e293b)',
              color: statusFilter === tab ? '#fff' : '#94a3b8',
              cursor: 'pointer',
              textTransform: 'capitalize',
              fontWeight: '500',
              fontSize: '14px',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {error && <div style={{ color: '#ef4444' }}>{error}</div>}

      <div style={{ background: 'var(--bg-panel, #1e293b)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8' }}>
              <th style={{ padding: '14px 16px' }}>Asset Name</th>
              <th style={{ padding: '14px 16px' }}>Format</th>
              <th style={{ padding: '14px 16px' }}>Project</th>
              <th style={{ padding: '14px 16px' }}>Submitted Date</th>
              <th style={{ padding: '14px 16px' }}>Status</th>
              <th style={{ padding: '14px 16px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>Loading assets…</td></tr>
            ) : assets.length === 0 ? (
              <tr><td colSpan="6" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>No {statusFilter} assets found.</td></tr>
            ) : (
              assets.map((a) => (
                <tr key={a.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '14px 16px', fontWeight: '500' }}>{a.name}</td>
                  <td style={{ padding: '14px 16px', textTransform: 'uppercase', color: '#94a3b8' }}>{a.format}</td>
                  <td style={{ padding: '14px 16px' }}>{a.project_name || '—'}</td>
                  <td style={{ padding: '14px 16px', color: '#94a3b8' }}>
                    {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{
                      padding: '3px 8px',
                      borderRadius: '12px',
                      fontSize: '12px',
                      fontWeight: '500',
                      background:
                        a.approval_status === 'approved' ? 'rgba(34, 197, 94, 0.15)' :
                        a.approval_status === 'rejected' ? 'rgba(239, 68, 68, 0.15)' :
                        'rgba(245, 158, 11, 0.15)',
                      color:
                        a.approval_status === 'approved' ? '#22c55e' :
                        a.approval_status === 'rejected' ? '#ef4444' :
                        '#f59e0b',
                    }}>
                      {a.approval_status}
                    </span>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    {statusFilter === 'pending' && (
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={() => handleModeration(a.id, 'approve')}
                          disabled={actingId === a.id}
                          style={{
                            padding: '4px 10px',
                            background: '#10b981',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '12px',
                          }}
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleModeration(a.id, 'reject')}
                          disabled={actingId === a.id}
                          style={{
                            padding: '4px 10px',
                            background: '#ef4444',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '12px',
                          }}
                        >
                          Reject
                        </button>
                      </div>
                    )}
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
