/**
 * MediaPipe Tasks (vision) loaders for face tracking and object detection.
 * The WASM runtime and model files are fetched on first use and cached.
 *
 * NOTE: runtime + models are served from public CDNs (jsDelivr, Google
 * Storage). Self-host them under /public if the app must work offline.
 */
import { FaceLandmarker, FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision'

const TASKS_VERSION = '1.1.1' // keep equal to package.json
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const OBJECT_MODEL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite'

let filesetPromise = null
const fileset = () => {
  if (!filesetPromise) {
    filesetPromise = FilesetResolver.forVisionTasks(WASM_BASE).catch((err) => {
      filesetPromise = null
      throw err
    })
  }
  return filesetPromise
}

// GPU delegate is much faster but unavailable on some devices; fall back to CPU.
async function withDelegateFallback(create) {
  try {
    return await create('GPU')
  } catch (err) {
    console.warn('[mediapipe] GPU delegate failed, using CPU', err)
    return create('CPU')
  }
}

export async function createFaceTracker({ maxFaces = 1 } = {}) {
  const vision = await fileset()
  const landmarker = await withDelegateFallback((delegate) =>
    FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate },
      runningMode: 'VIDEO',
      numFaces: maxFaces,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
    })
  )
  let lastTs = -1
  return {
    /** Returns [{ matrix: number[16] (column-major, cm), landmarks }] */
    detect(video, nowMs) {
      const ts = Math.max(nowMs, lastTs + 1)
      lastTs = ts
      const res = landmarker.detectForVideo(video, ts)
      const matrices = res.facialTransformationMatrixes || []
      return matrices.map((m, i) => ({ matrix: m.data, landmarks: res.faceLandmarks?.[i] || [] }))
    },
    dispose() {
      landmarker.close()
    },
  }
}

export async function createObjectDetector({ minConfidence = 0.5, maxResults = 8 } = {}) {
  const vision = await fileset()
  const detector = await withDelegateFallback((delegate) =>
    ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: OBJECT_MODEL, delegate },
      runningMode: 'VIDEO',
      scoreThreshold: minConfidence,
      maxResults,
    })
  )
  let lastTs = -1
  return {
    /** Returns [{ label, score, box: { x, y, w, h } }] in video pixels */
    detect(video, nowMs) {
      const ts = Math.max(nowMs, lastTs + 1)
      lastTs = ts
      const res = detector.detectForVideo(video, ts)
      return (res.detections || [])
        .map((d) => {
          const c = d.categories?.[0]
          const b = d.boundingBox
          if (!c || !b) return null
          return { label: c.categoryName, score: c.score, box: { x: b.originX, y: b.originY, w: b.width, h: b.height } }
        })
        .filter(Boolean)
    },
    dispose() {
      detector.close()
    },
  }
}
