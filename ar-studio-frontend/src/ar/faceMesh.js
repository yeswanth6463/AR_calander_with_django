/**
 * Face mesh layer: draws MediaPipe's 478 face landmarks as markers
 * (points), the 468-vertex tessellation as edges, feature contours (eyes,
 * brows, lips, oval, irises), and image "face masks" that wrap and deform
 * with the face.
 *
 * Everything lives in an orthographic scene in video-pixel space so it lines
 * up exactly with the camera image:  x = lm.x·W,  y = −lm.y·H,  z = −lm.z·W.
 */
import * as THREE from 'three'
import { FaceLandmarker } from '@mediapipe/tasks-vision'

const MESH_VERTS = 468 // tessellation vertices (478 incl. irises)
const ALL_VERTS = 478

// FACE_LANDMARKS_TESSELATION is a list of triangle edges: every 3
// consecutive connections close one triangle (852 triangles).
const TESSELATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION
const TRIANGLES = (() => {
  const idx = []
  for (let k = 0; k + 2 < TESSELATION.length; k += 3) {
    idx.push(TESSELATION[k].start, TESSELATION[k + 1].start, TESSELATION[k + 2].start)
  }
  return idx
})()
const uniqueEdges = (connections) => {
  const seen = new Set()
  const out = []
  for (const { start, end } of connections) {
    const key = start < end ? `${start}-${end}` : `${end}-${start}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(start, end)
  }
  return out
}
const MESH_EDGES = uniqueEdges(TESSELATION)
const CONTOUR_EDGES = uniqueEdges([
  ...FaceLandmarker.FACE_LANDMARKS_CONTOURS,
  ...FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
  ...FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
])

export const DEFAULT_MARKERS = { points: false, mesh: false, contours: false }
export const markersFromSettings = (s) => ({
  points: !!s?.show_points,
  mesh: !!s?.show_mesh,
  contours: !!s?.show_contours,
})

export function createFaceMeshLayer() {
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -100000, 100000)
  const positions = new Float32Array(ALL_VERTS * 3)
  const positionAttr = new THREE.BufferAttribute(positions, 3)
  positionAttr.setUsage(THREE.DynamicDrawUsage)

  // Shared, per-frame updated geometries.
  const makeGeometry = (index) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', positionAttr)
    if (index) g.setIndex(index)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9) // never frustum-cull
    return g
  }
  const pointsGeom = makeGeometry(null)
  const pointsMat = new THREE.PointsMaterial({ color: 0x22d3ee, size: 3, sizeAttenuation: false, depthTest: false })
  const points = new THREE.Points(pointsGeom, pointsMat)

  const meshGeom = makeGeometry(MESH_EDGES)
  const meshMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthTest: false })
  const meshLines = new THREE.LineSegments(meshGeom, meshMat)

  const contourGeom = makeGeometry(CONTOUR_EDGES)
  const contourMat = new THREE.LineBasicMaterial({ color: 0xf472b6, depthTest: false })
  const contourLines = new THREE.LineSegments(contourGeom, contourMat)

  meshLines.renderOrder = 10
  contourLines.renderOrder = 11
  points.renderOrder = 12
  scene.add(meshLines, contourLines, points)

  // Masks: one textured, deforming copy of the face mesh per mask image.
  const uvs = new Float32Array(ALL_VERTS * 2)
  const uvAttr = new THREE.BufferAttribute(uvs, 2)
  let uvQuality = -1 // how frontal the face was when UVs were captured (cos angle)
  const masks = new Map() // id -> { mesh, texture, url }
  const maskGroup = new THREE.Group()
  scene.add(maskGroup)

  let markers = { ...DEFAULT_MARKERS }
  let visible = false
  let width = 1
  let height = 1

  const applyVisibility = () => {
    points.visible = visible && markers.points
    meshLines.visible = visible && markers.mesh
    contourLines.visible = visible && markers.contours
    maskGroup.visible = visible && uvQuality > 0
  }
  applyVisibility()

  const tmp = new THREE.Vector3()
  const rot = new THREE.Matrix4()
  const full = new THREE.Matrix4()

  /**
   * Mask UVs = the face seen straight-on: landmarks rotated back into the
   * face's own frame (inverse head rotation), normalised to their bounds.
   * Re-captured whenever the user faces the camera more directly.
   */
  const captureUVs = (matrix) => {
    rot.extractRotation(full.fromArray(matrix))
    const e = rot.elements
    const facing = e[10] // face +Z axis · camera +Z  (1 = straight on)
    if (facing <= uvQuality + 0.005) return
    const inv = rot.clone().transpose()
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    const flat = new Float32Array(MESH_VERTS * 2)
    for (let i = 0; i < MESH_VERTS; i++) {
      tmp.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(inv)
      flat[i * 2] = tmp.x
      flat[i * 2 + 1] = tmp.y
      minX = Math.min(minX, tmp.x)
      maxX = Math.max(maxX, tmp.x)
      minY = Math.min(minY, tmp.y)
      maxY = Math.max(maxY, tmp.y)
    }
    // Square UV box so the template keeps the face's proportions.
    const size = Math.max(maxX - minX, maxY - minY) || 1
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    for (let i = 0; i < MESH_VERTS; i++) {
      // Mirror U so a template reads correctly in the selfie (mirrored) view.
      uvs[i * 2] = 1 - (0.5 + (flat[i * 2] - cx) / size)
      uvs[i * 2 + 1] = 0.5 + (flat[i * 2 + 1] - cy) / size
    }
    uvAttr.needsUpdate = true
    uvQuality = facing
  }

  return {
    scene,
    camera,

    /** Move the markers (points / edges / contours) into another scene, e.g. one drawn on top. */
    overlayTo(target) {
      target.add(meshLines, contourLines, points)
    },

    setMarkers(next) {
      markers = { ...DEFAULT_MARKERS, ...(next || {}) }
      applyVisibility()
    },

    /** landmarks: NormalizedLandmark[] (or null when no face); matrix: number[16] */
    update(landmarks, matrix, W, H) {
      if (W !== width || H !== height) {
        width = W
        height = H
        camera.left = 0
        camera.right = W
        camera.top = 0
        camera.bottom = -H
        camera.updateProjectionMatrix()
        pointsMat.size = Math.max(2, Math.round(W / 320))
      }
      visible = !!landmarks?.length
      if (visible) {
        const n = Math.min(landmarks.length, ALL_VERTS)
        for (let i = 0; i < n; i++) {
          const lm = landmarks[i]
          positions[i * 3] = lm.x * W
          positions[i * 3 + 1] = -lm.y * H
          positions[i * 3 + 2] = -lm.z * W
        }
        positionAttr.needsUpdate = true
        if (matrix && masks.size) captureUVs(matrix)
      }
      applyVisibility()
    },

    /** list: [{ id, url, opacity? }] — image URLs to wrap on the face */
    setMasks(list) {
      const keep = new Set()
      for (const m of list) {
        keep.add(m.id)
        const existing = masks.get(m.id)
        if (existing?.url === m.url) continue
        if (existing) removeMask(m.id)
        const geom = new THREE.BufferGeometry()
        geom.setAttribute('position', positionAttr)
        geom.setAttribute('uv', uvAttr)
        geom.setIndex(TRIANGLES)
        geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9)
        const texture = new THREE.TextureLoader().load(m.url)
        texture.colorSpace = THREE.SRGBColorSpace
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: m.opacity ?? 1,
          side: THREE.DoubleSide,
          // Own pass, so writing depth only makes the near side of the face
          // win over the far side when the head turns.
          depthWrite: true,
          alphaTest: 0.01,
          toneMapped: false,
        })
        const mesh = new THREE.Mesh(geom, material)
        mesh.renderOrder = 1
        maskGroup.add(mesh)
        masks.set(m.id, { mesh, texture, url: m.url })
      }
      for (const id of [...masks.keys()]) if (!keep.has(id)) removeMask(id)
      applyVisibility()
    },

    /** True once a face has been seen and mask UVs are available. */
    get hasTemplate() {
      return uvQuality > 0
    },

    /** Mask design template (PNG-ready canvas) drawn in mask UV space. */
    maskTemplate(size = 1024) {
      if (uvQuality <= 0) return null
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      const px = (i) => [uvs[i * 2] * size, (1 - uvs[i * 2 + 1]) * size]
      const stroke = (edges, color, widthPx) => {
        ctx.strokeStyle = color
        ctx.lineWidth = widthPx
        ctx.beginPath()
        for (let k = 0; k < edges.length; k += 2) {
          if (edges[k] >= MESH_VERTS || edges[k + 1] >= MESH_VERTS) continue
          const [x1, y1] = px(edges[k])
          const [x2, y2] = px(edges[k + 1])
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
        }
        ctx.stroke()
      }
      stroke(MESH_EDGES, 'rgba(120, 120, 120, 0.55)', 1)
      stroke(CONTOUR_EDGES, 'rgba(219, 39, 119, 0.9)', 2)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
      ctx.font = `${Math.round(size / 48)}px sans-serif`
      ctx.fillText('Paint your mask over this face layout · transparent = skin shows through', 16, size - 16)
      return canvas
    },

    dispose() {
      for (const id of [...masks.keys()]) removeMask(id)
      pointsGeom.dispose()
      meshGeom.dispose()
      contourGeom.dispose()
      pointsMat.dispose()
      meshMat.dispose()
      contourMat.dispose()
    },
  }

  function removeMask(id) {
    const m = masks.get(id)
    if (!m) return
    masks.delete(id)
    maskGroup.remove(m.mesh)
    m.mesh.geometry.dispose()
    m.mesh.material.dispose()
    m.texture.dispose()
  }
}
