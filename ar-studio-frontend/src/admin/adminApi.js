import { api } from '../api'

export const adminApi = {
  getOverview: () => api('/v1/admin/overview/'),
  getUsers: (params = '') => api(`/v1/admin/users/${params ? `?${params}` : ''}`),
  updateUserRole: (userId, data) => api(`/v1/admin/users/${userId}/role/`, { method: 'PATCH', body: data }),
  getOrganizations: () => api('/v1/admin/organizations/'),
  createOrganization: (data) => api('/v1/admin/organizations/', { method: 'POST', body: data }),
  getProjects: () => api('/v1/admin/projects/'),
  getAssetsModeration: (status = 'pending') => api(`/v1/admin/assets/moderation/?status=${status}`),
  moderateAsset: (assetId, action) => api('/v1/admin/assets/moderation/', { method: 'POST', body: { asset_id: assetId, action } }),
}
