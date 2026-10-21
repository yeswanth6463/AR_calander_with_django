import { createContext, useContext, useEffect, useState } from 'react'
import { api } from './api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api('/auth/me/')
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const login = async (email, password) => {
    const d = await api('/auth/login/', { method: 'POST', body: { email, password } })
    setUser(d.user)
    return d.user
  }

  const register = async (email, password, username) => {
    const d = await api('/auth/register/', {
      method: 'POST',
      body: { email, password, username },
    })
    setUser(d.user)
    return d.user
  }

  const logout = async () => {
    await api('/auth/logout/', { method: 'POST' }).catch(() => {})
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
