import React, { useEffect, useState } from 'react'
import { adminApi } from './adminApi'

export default function AdminUsers() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [updatingId, setUpdatingId] = useState(null)

  const fetchUsers = () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.append('search', search)
    if (roleFilter) params.append('role', roleFilter)

    adminApi.getUsers(params.toString())
      .then((res) => setUsers(res.users || []))
      .catch((err) => setError(err.message || 'Failed to load users.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchUsers()
  }, [roleFilter])

  const handleRoleChange = async (userId, newRole) => {
    setUpdatingId(userId)
    try {
      await adminApi.updateUserRole(userId, { role: newRole })
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)))
    } catch (err) {
      alert(err.message || 'Could not update role.')
    } finally {
      setUpdatingId(null)
    }
  }

  const handleStatusToggle = async (userId, currentStatus) => {
    setUpdatingId(userId)
    try {
      await adminApi.updateUserRole(userId, { is_active: !currentStatus })
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, is_active: !currentStatus } : u)))
    } catch (err) {
      alert(err.message || 'Could not update status.')
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 6px 0' }}>User Management</h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>View registered customers, manage roles, and control access permissions.</p>
      </div>

      {/* Filters bar */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search by email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && fetchUsers()}
          style={{
            padding: '8px 14px',
            background: 'var(--bg-panel, #1e293b)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '6px',
            color: '#fff',
            fontSize: '14px',
            width: '260px',
          }}
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          style={{
            padding: '8px 14px',
            background: 'var(--bg-panel, #1e293b)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '6px',
            color: '#fff',
            fontSize: '14px',
          }}
        >
          <option value="">All Roles</option>
          <option value="super_admin">Super Admin</option>
          <option value="finance_admin">Finance Admin</option>
          <option value="content_admin">Content Admin</option>
          <option value="support_admin">Support Admin</option>
          <option value="customer">Customer</option>
        </select>
        <button
          onClick={fetchUsers}
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
          Search
        </button>
      </div>

      {error && <div style={{ color: '#ef4444' }}>{error}</div>}

      {/* Table */}
      <div style={{ background: 'var(--bg-panel, #1e293b)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8' }}>
              <th style={{ padding: '14px 16px' }}>Email</th>
              <th style={{ padding: '14px 16px' }}>Role</th>
              <th style={{ padding: '14px 16px' }}>Customer Type</th>
              <th style={{ padding: '14px 16px' }}>Status</th>
              <th style={{ padding: '14px 16px' }}>Joined Date</th>
              <th style={{ padding: '14px 16px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>Loading users…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan="6" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>No users found.</td></tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '14px 16px', fontWeight: '500' }}>{u.email}</td>
                  <td style={{ padding: '14px 16px' }}>
                    <select
                      value={u.role}
                      disabled={updatingId === u.id}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      style={{
                        padding: '4px 8px',
                        background: '#0f172a',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '4px',
                        color: '#fff',
                        fontSize: '13px',
                      }}
                    >
                      <option value="customer">Customer</option>
                      <option value="support_admin">Support Admin</option>
                      <option value="content_admin">Content Admin</option>
                      <option value="finance_admin">Finance Admin</option>
                      <option value="super_admin">Super Admin</option>
                    </select>
                  </td>
                  <td style={{ padding: '14px 16px', textTransform: 'capitalize' }}>{u.customer_type}</td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{
                      padding: '3px 8px',
                      borderRadius: '12px',
                      fontSize: '12px',
                      fontWeight: '500',
                      background: u.is_active ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                      color: u.is_active ? '#22c55e' : '#ef4444',
                    }}>
                      {u.is_active ? 'Active' : 'Suspended'}
                    </span>
                  </td>
                  <td style={{ padding: '14px 16px', color: '#94a3b8' }}>
                    {u.date_joined ? new Date(u.date_joined).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <button
                      onClick={() => handleStatusToggle(u.id, u.is_active)}
                      disabled={updatingId === u.id}
                      style={{
                        padding: '4px 10px',
                        background: 'transparent',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: '4px',
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: '12px',
                      }}
                    >
                      {u.is_active ? 'Suspend' : 'Activate'}
                    </button>
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
