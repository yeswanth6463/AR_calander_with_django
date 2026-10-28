import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, Link, useNavigate } from 'react-router-dom'
import { useAuth } from './auth'
import Login from './pages/Login'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Viewer from './pages/Viewer'

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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
