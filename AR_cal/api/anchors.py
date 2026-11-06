"""What an experience item can be attached to, per project type.

Keep in sync with ar-studio-frontend/src/ar/anchors.js.
"""

PROJECT_TYPES = [
    ("image_ar", "AR Experience (image target)"),
    ("game", "AR Game"),
    ("face", "Face tracking"),
    ("object", "Object detection"),
]
PROJECT_TYPE_IDS = {key for key, _ in PROJECT_TYPES}

ANCHOR_TYPES = [
    ("image", "Image target"),
    ("face", "Face point"),
    ("object", "Detected object"),
]

# Which anchor each project type uses for its items.
ANCHOR_FOR_PROJECT = {
    "image_ar": "image",
    "game": "image",
    "face": "face",
    "object": "object",
}

# "mesh" = image mask wrapped onto the live face mesh (image assets only).
FACE_POINTS = {"head", "head_top", "forehead", "eyes", "nose", "mouth", "chin", "mesh"}
IMAGE_FORMATS = {"png", "jpg", "jpeg", "webp"}

# MediaPipe Object Detector (EfficientDet-Lite0, COCO) category names.
OBJECT_LABELS = {
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
}

# Asset formats: what can be placed in a scene vs. only used as a sound.
PLACEABLE_FORMATS = {"glb", "gltf", "mp4", "webm", "gif", "png", "jpg", "jpeg", "webp"}
AUDIO_FORMATS = {"mp3", "wav", "ogg"}


def clean_type_settings(project_type, value):
    """Per-type viewer options chosen in the new-project wizard."""
    if not isinstance(value, dict):
        value = {}
    if project_type == "face":
        point = value.get("default_point")
        return {
            "default_point": point if point in FACE_POINTS else "eyes",
            "occlusion": bool(value.get("occlusion")),
            # Face markers shown to viewers: landmark points, mesh edges, feature contours.
            "show_points": bool(value.get("show_points")),
            "show_mesh": bool(value.get("show_mesh")),
            "show_contours": bool(value.get("show_contours")),
        }
    if project_type == "object":
        try:
            confidence = float(value.get("min_confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        label = value.get("default_label")
        return {
            "min_confidence": min(max(confidence, 0.2), 0.95),
            "show_labels": bool(value.get("show_labels", True)),
            "default_label": label if label in OBJECT_LABELS else "cup",
        }
    return {}
