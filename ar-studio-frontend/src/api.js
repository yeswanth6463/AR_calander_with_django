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
        const error = new Error(detail)
        error.status = retry.status
        throw error
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
    const error = new Error(detail)
    error.status = res.status
    error.data = data
    throw error
  }
  return data
}

/**
 * Multipart upload with progress (fetch() cannot report upload progress).
 * `onProgress` receives an integer percentage 0–100.
 */
export async function apiUpload(path, formData, { onProgress } = {}) {
  const send = (token) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api${path}`)
      xhr.withCredentials = true
      if (token) xhr.setRequestHeader('X-CSRFToken', token)

      xhr.upload.onprogress = (e) => {
        if (!onProgress || !e.lengthComputable) return
        onProgress(Math.max(0, Math.min(100, Math.round((e.loaded / e.total) * 100))))
      }
      xhr.onerror = () => reject(new Error('Upload failed — check your connection.'))
      xhr.onabort = () => reject(new Error('Upload cancelled.'))
      xhr.onload = () => {
        let data = null
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null
        } catch {
          data = null
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.status === 204 ? null : data)
          return
        }
        const detail =
          (data && (data.error || data.detail)) ||
          (data && typeof data === 'object'
            ? Object.entries(data)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
                .join(' | ')
            : '') ||
          `Upload failed (${xhr.status})`
        const error = new Error(detail)
        error.status = xhr.status
        error.data = data
        reject(error)
      }
      xhr.send(formData)
    })

  const token = (await ensureCsrf()) || ''
  try {
    return await send(token)
  } catch (err) {
    // Same CSRF-refresh retry as api(): a stale token must not look like
    // "you are not signed in" on a large model upload.
    if (err?.status !== 403) throw err
    document.cookie = 'csrftoken=; Max-Age=0; path=/'
    return send((await ensureCsrf()) || '')
  }
}
