/**
 * Project types and anchors. Keep in sync with AR_cal/api/anchors.py.
 */

export const PROJECT_TYPES = [
  {
    id: 'image_ar',
    icon: '🖼️',
    title: 'AR Experience',
    blurb: 'Point the camera at a printed image (poster, card, packaging) and 3D models or videos appear on it.',
  },
  {
    id: 'game',
    icon: '🎮',
    title: 'AR Game',
    blurb: 'An image-target AR game: upload game assets and build the logic with rules or JavaScript.',
  },
  {
    id: 'face',
    icon: '🙂',
    title: 'Face Tracking',
    blurb: 'Glasses, hats, masks and effects that follow a person’s face in real time (front camera).',
  },
  {
    id: 'object',
    icon: '📦',
    title: 'Object Detection',
    blurb: 'Recognise everyday objects (cup, bottle, person, laptop…) in real time and show content on them.',
  },
]

export const projectTypeMeta = (id) => PROJECT_TYPES.find((t) => t.id === id) || PROJECT_TYPES[0]

/**
 * Face anchor points in MediaPipe's canonical face space (centimetres,
 * +Y up, +Z out of the face towards the camera). Offsets are starting
 * points; creators fine-tune with position/rotation/scale using the live
 * camera preview. `fit` = width (cm) a model is scaled to at scale 1.
 */
export const FACE_POINTS = [
  { id: 'eyes', label: 'Eyes (glasses)', offset: [0, 2.6, 4.6], fit: 14 },
  { id: 'head_top', label: 'Top of head (hats)', offset: [0, 9.5, 0], fit: 18 },
  { id: 'forehead', label: 'Forehead', offset: [0, 6, 4.2], fit: 10 },
  { id: 'nose', label: 'Nose tip', offset: [0, -0.5, 7.2], fit: 4 },
  { id: 'mouth', label: 'Mouth', offset: [0, -4.2, 5.4], fit: 6 },
  { id: 'chin', label: 'Chin', offset: [0, -8, 3.6], fit: 8 },
  { id: 'head', label: 'Whole head (helmets, 3D masks)', offset: [0, 1, 0], fit: 20 },
  // Image wrapped onto the live face mesh (offset/fit unused).
  { id: 'mesh', label: 'Face mask (image wraps the face)', offset: [0, 0, 0], fit: 1 },
]
export const facePointMeta = (id) => FACE_POINTS.find((p) => p.id === id) || FACE_POINTS[0]

// MediaPipe Object Detector (EfficientDet-Lite0, COCO) categories.
export const OBJECT_LABELS = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog',
  'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
  'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant',
  'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors',
  'teddy bear', 'hair drier', 'toothbrush',
]

export const MODEL_FORMATS = ['glb', 'gltf']
export const VIDEO_FORMATS = ['mp4', 'webm', 'gif']
export const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'webp']
export const AUDIO_FORMATS = ['mp3', 'wav', 'ogg']
export const PLACEABLE_FORMATS = [...MODEL_FORMATS, ...VIDEO_FORMATS, ...IMAGE_FORMATS]
export const isPlaceable = (asset) => PLACEABLE_FORMATS.includes(asset?.format)
export const isAudio = (asset) => AUDIO_FORMATS.includes(asset?.format)
export const isFlatMedia = (format) => VIDEO_FORMATS.includes(format) || IMAGE_FORMATS.includes(format)
