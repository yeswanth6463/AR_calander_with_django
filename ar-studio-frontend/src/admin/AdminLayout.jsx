import React from 'react'
import { NavLink, Link, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'

export default function AdminLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="admin-shell" style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-app, #0f172a)', color: 'var(--text-main, #f8fafc)' }}>
      {/* Sidebar */}
      <aside style={{ width: '260px', background: 'var(--bg-panel, #1e293b)', borderRight: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '24px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ background: '#3b82f6', color: '#fff', padding: '4px 8px', borderRadius: '6px', fontWeight: 'bold', fontSize: '13px' }}>ADMIN</span>
          <span style={{ fontWeight: '600', fontSize: '16px' }}>AR Studio Hub</span>
        </div>

        <nav style={{ padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          <NavLink
            to="/admin"
            end
            style={({ isActive }) => ({
              padding: '10px 14px',
              borderRadius: '8px',
              textDecoration: 'none',
              color: isActive ? '#fff' : '#94a3b8',
              background: isActive ? '#2563eb' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontWeight: '500',
              fontSize: '14px',
            })}
          >
            <span>📊</span> Overview
          </NavLink>

          <NavLink
            to="/admin/users"
            style={({ isActive }) => ({
              padding: '10px 14px',
              borderRadius: '8px',
              textDecoration: 'none',
              color: isActive ? '#fff' : '#94a3b8',
              background: isActive ? '#2563eb' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontWeight: '500',
              fontSize: '14px',
            })}
          >
            <span>👥</span> Users
          </NavLink>

          <NavLink
            to="/admin/organizations"
            style={({ isActive }) => ({
              padding: '10px 14px',
              borderRadius: '8px',
              textDecoration: 'none',
              color: isActive ? '#fff' : '#94a3b8',
              background: isActive ? '#2563eb' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontWeight: '500',
              fontSize: '14px',
            })}
          >
            <span>🏢</span> Organizations
          </NavLink>

          <NavLink
            to="/admin/projects"
            style={({ isActive }) => ({
              padding: '10px 14px',
              borderRadius: '8px',
              textDecoration: 'none',
              color: isActive ? '#fff' : '#94a3b8',
              background: isActive ? '#2563eb' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontWeight: '500',
              fontSize: '14px',
            })}
          >
            <span>🎯</span> AR Projects
          </NavLink>

          <NavLink
            to="/admin/assets"
            style={({ isActive }) => ({
              padding: '10px 14px',
              borderRadius: '8px',
              textDecoration: 'none',
              color: isActive ? '#fff' : '#94a3b8',
              background: isActive ? '#2563eb' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontWeight: '500',
              fontSize: '14px',
            })}
          >
            <span>📦</span> 3D Asset Moderation
          </NavLink>

          <div style={{ margin: '16px 0', borderTop: '1px solid rgba(255,255,255,0.08)' }} />

          <Link
            to="/"
            style={{
              padding: '10px 14px',
              borderRadius: '8px',
              textDecoration: 'none',
              color: '#94a3b8',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontSize: '14px',
            }}
          >
            <span>←</span> Back to Studio
          </Link>
        </nav>

        <div style={{ padding: '16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '4px' }}>Logged in as:</div>
          <div style={{ fontSize: '14px', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.email}</div>
          <button
            onClick={handleLogout}
            style={{
              marginTop: '12px',
              width: '100%',
              padding: '8px',
              background: 'rgba(239, 68, 68, 0.1)',
              color: '#ef4444',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500',
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{ height: '64px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: '600', margin: 0 }}>AR Studio Administration</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '12px', background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e', padding: '4px 10px', borderRadius: '12px', fontWeight: '500' }}>
              System Online
            </span>
          </div>
        </header>
        <div style={{ padding: '32px', flex: 1, overflowY: 'auto' }}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
