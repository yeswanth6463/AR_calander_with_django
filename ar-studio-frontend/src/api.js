function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'))
  return match ? match[2] : null
}

async function ensureCsrf() {
  if (getCookie('csrftoken')) return getCookie('csrftoken')
  await fetch('/api/auth/csrf/', { credentials: 'include' })
  return getCookie('csrftoken')
}

export async function api(path, { method = 'GET', body, formData } = {}) {
  const headers = {}
  let payload = undefined

  if (formData) {
    payload = formData
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  if (method !== 'GET') {
    headers['X-CSRFToken'] = (await ensureCsrf()) || ''
  }

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: payload,
    credentials: 'include',
  })

  if (res.status === 403 && method !== 'GET') {
    document.cookie = 'csrftoken=; Max-Age=0; path=/'
    headers['X-CSRFToken'] = (await ensureCsrf()) || ''
    const retry = await fetch(`/api${path}`, {
      method,
      headers,
      body: payload,
      credentials: 'include',
    })
    if (retry.ok || retry.status !== 403) {
      const retryData = retry.status === 204 ? null : await retry.json().catch(() => null)
      if (!retry.ok) {
        const detail =
          (retryData && (retryData.error || retryData.detail)) ||
          `Request failed (${retry.status})`
        throw new Error(detail)
      }
      return retryData
    }
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const detail =
      (data && (data.error || data.detail)) ||
      (data && typeof data === 'object'
        ? Object.entries(data)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join(' | ')
        : '') ||
      `Request failed (${res.status})`
    throw new Error(detail)
  }
  return data
}
