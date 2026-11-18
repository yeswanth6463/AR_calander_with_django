import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, Link, useNavigate } from 'react-router-dom'
import { useAuth } from './auth'
import Login from './pages/Login'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Viewer from './pages/Viewer'
import AdminLayout from './admin/AdminLayout'
import AdminOverview from './admin/AdminOverview'
import AdminUsers from './admin/AdminUsers'
import AdminOrganizations from './admin/AdminOrganizations'
import AdminProjects from './admin/AdminProjects'
import AdminAssets from './admin/AdminAssets'

function AdminProtected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="center muted">Loading…</div>
  if (!user) return <Navigate to="/login" replace />
  const isAdm = user.role && user.role !== 'customer'
  if (!isAdm) return <Navigate to="/" replace />
  return children
}

function Protected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="center muted">Loading…</div>
  if (!user) return <Navigate to="/login" replace />
  return children
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])

  return (
    <button
      className="btn ghost small"
      title="Toggle theme"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? '☀ Light' : '☾ Dark'}
    </button>
  )
}

function Shell({ children }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">AR</span>
          <span>AR Studio</span>
        </Link>
        <div id="studio-nav-slot" className="studio-nav-slot" />
        <div className="spacer" />
        <div id="studio-status-slot" className="studio-status-slot" />
        <ThemeToggle />
        {user && (
          <>
            {user.role && user.role !== 'customer' && (
              <Link to="/admin" className="btn small" style={{ background: '#2563eb', color: '#fff', textDecoration: 'none', marginRight: '6px' }}>
                Admin Hub
              </Link>
            )}
            <span className="user-chip" title={user.email}>{user.email}</span>
            <button
              className="btn ghost"
              onClick={async () => {
                await logout()
                navigate('/login')
              }}
            >
              Log out
            </button>
          </>
        )}
      </header>
      <main className="content">{children}</main>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/view/:publicId" element={<Viewer />} />
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <Protected>
            <Shell>
              <Projects />
            </Shell>
          </Protected>
        }
      />
      <Route
        path="/projects/:id"
        element={
          <Protected>
            <Shell>
              <ProjectDetail />
            </Shell>
          </Protected>
        }
      />
      {/* Admin Dashboard Routes */}
      <Route
        path="/admin"
        element={
          <AdminProtected>
            <AdminLayout />
          </AdminProtected>
        }
      >
        <Route index element={<AdminOverview />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="organizations" element={<AdminOrganizations />} />
        <Route path="projects" element={<AdminProjects />} />
        <Route path="assets" element={<AdminAssets />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
