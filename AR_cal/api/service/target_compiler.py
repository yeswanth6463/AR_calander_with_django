"""Server-side AR image-target compiler (MindAR-style ``.mind`` equivalent).

All of a project's target images are compiled into ONE JSON bundle that the
browser viewer downloads and loads straight into its OpenCV.js tracker, so the
phone never has to run feature extraction itself.

The preprocessing and ORB parameters MUST stay in sync with ``TRACK_CONFIG``
and ``ImageTracker.compile`` in ``ar-studio-frontend/src/ar/tracker.js``:
the target is drawn at most ``max_edge`` px on its long side, converted to
gray, CLAHE-enhanced, and described with ORB. Keypoints are stored in that
resized pixel space, which is also the space the viewer's pose solver uses.
Bump ``COMPILER_VERSION`` whenever any of this changes (projects then show
as needing a recompile). ``BUNDLE_VERSION`` is the file layout; the viewer
ignores bundles whose layout it does not know and compiles locally instead.

Feature selection (compiler v2): ORB proposes ~5000 candidates; points with a
far-away look-alike are dropped, and ~1500 are kept spread evenly over an 8x8
grid and over all pyramid levels. Fewer, better points = faster matching on
the phone and fewer wrong matches than the raw 2500 strongest
(benchmark: same detection rate, ~2x faster matching).
"""

import base64
import hashlib
import math

import cv2
import numpy as np
from PIL import Image, ImageOps

# Bump COMPILER_VERSION when feature selection changes (forces a recompile);
# bump BUNDLE_VERSION only when the bundle file layout changes (the viewer
# checks it).
COMPILER_VERSION = 2
BUNDLE_VERSION = 1
BUNDLE_FORMAT = "ar-studio-targets"

CONFIG = {
    "max_edge": 1080,
    # ORB is asked for many candidates; selection below keeps `budget`.
    "nfeatures": 5000,
    "budget": 1500,
    "scale_factor": 1.2,
    "nlevels": 8,
    "edge_threshold": 15,
    "first_level": 0,
    "wta_k": 2,
    "patch_size": 31,
    "fast_threshold": 7,
    "clahe_clip": 3.0,
    "clahe_tiles": 8,
    # ImageTracker rejects targets with fewer features than its minInliers.
    "min_features": 10,
    # A point is "ambiguous" when another point at least `twin_min_px` away
    # has a descriptor within `twin_max_hamming` bits (of 256): a camera
    # frame could match either, which causes wrong matches and jitter.
    "twin_max_hamming": 24,
    "twin_min_px": 24,
    "grid": 8,
    # Share of the budget spread evenly over pyramid levels (the rest follows
    # each level's image area), so near AND far detection keep points.
    "level_balance": 0.5,
}

PREVIEW_KEYPOINTS = CONFIG["budget"]
SPREAD_GRID = CONFIG["grid"]

RATING_TEXT = {
    0: "Not trackable",
    1: "Poor tracking image",
    2: "Weak tracking",
    3: "Moderate tracking",
    4: "Good tracking",
    5: "Excellent tracking",
}


class TargetCompileError(ValueError):
    pass


def _js_round(value):
    """Math.round() semantics (half away from zero for positives)."""
    return int(math.floor(value + 0.5))


def _load_rgb(image_path):
    """Load like a browser <img> drawn on a canvas: EXIF-rotated, alpha over black."""
    try:
        with Image.open(image_path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode in ("RGBA", "LA", "P"):
                rgba = img.convert("RGBA")
                arr = np.asarray(rgba, dtype=np.float32)
                rgb = arr[..., :3] * (arr[..., 3:4] / 255.0)
                return rgb.round().astype(np.uint8)
            return np.asarray(img.convert("RGB"), dtype=np.uint8)
    except Exception as exc:  # Pillow raises many types for corrupt/bomb images
        raise TargetCompileError("Unable to read target image.") from exc


def _processed_gray(image_path):
    rgb = _load_rgb(image_path)
    src_h, src_w = rgb.shape[:2]
    if not src_w or not src_h:
        raise TargetCompileError("Target image has no size.")
    scale = min(1.0, CONFIG["max_edge"] / max(src_w, src_h))
    width = max(1, _js_round(src_w * scale))
    height = max(1, _js_round(src_h * scale))
    if (width, height) != (src_w, src_h):
        rgb = cv2.resize(rgb, (width, height), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    tiles = CONFIG["clahe_tiles"]
    clahe = cv2.createCLAHE(clipLimit=CONFIG["clahe_clip"], tileGridSize=(tiles, tiles))
    return clahe.apply(gray), (src_w, src_h), (width, height)


def _orb():
    return cv2.ORB_create(
        nfeatures=CONFIG["nfeatures"],
        scaleFactor=CONFIG["scale_factor"],
        nlevels=CONFIG["nlevels"],
        edgeThreshold=CONFIG["edge_threshold"],
        firstLevel=CONFIG["first_level"],
        WTA_K=CONFIG["wta_k"],
        scoreType=cv2.ORB_HARRIS_SCORE,
        patchSize=CONFIG["patch_size"],
        fastThreshold=CONFIG["fast_threshold"],
    )


def _spread(points, width, height):
    """Fraction of the grid that holds at least 3 keypoints."""
    if not len(points):
        return 0.0
    counts = np.zeros((SPREAD_GRID, SPREAD_GRID), dtype=np.int32)
    xs = np.clip((points[:, 0] / max(width, 1) * SPREAD_GRID).astype(int), 0, SPREAD_GRID - 1)
    ys = np.clip((points[:, 1] / max(height, 1) * SPREAD_GRID).astype(int), 0, SPREAD_GRID - 1)
    np.add.at(counts, (ys, xs), 1)
    return float((counts >= 3).sum()) / (SPREAD_GRID * SPREAD_GRID)


def _ambiguous_mask(points, descriptors):
    """True where a point has a far-away look-alike (repeated texture)."""
    n = len(points)
    if n < 2:
        return np.zeros(n, dtype=bool)
    k = min(n, 6)
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(descriptors, descriptors, k=k)
    max_d = CONFIG["twin_max_hamming"]
    min_px2 = CONFIG["twin_min_px"] ** 2
    out = np.zeros(n, dtype=bool)
    for i, matches in enumerate(pairs):
        for m in matches:
            if m.trainIdx == i:
                continue
            if m.distance > max_d:
                break  # sorted by distance: no closer twins follow
            dx, dy = points[m.trainIdx] - points[i]
            if dx * dx + dy * dy >= min_px2:
                out[i] = True
                break
    return out


def _select(keypoints, points, width, height, keep):
    """Pick up to `budget` candidate indices spread over grid cells and scales.

    Within each (pyramid level, grid cell) points are ranked by response;
    selection takes every cell's best point first, then every cell's second
    best, and so on, so busy regions cannot crowd out quiet ones.
    """
    idx = np.flatnonzero(keep)
    budget = CONFIG["budget"]
    if len(idx) <= budget:
        return idx
    g = SPREAD_GRID
    level = np.array([keypoints[i].octave for i in idx])
    response = np.array([keypoints[i].response for i in idx])
    cx = np.clip((points[idx, 0] / max(width, 1) * g).astype(int), 0, g - 1)
    cy = np.clip((points[idx, 1] / max(height, 1) * g).astype(int), 0, g - 1)
    cell = level * g * g + cy * g + cx

    order = np.lexsort((-response, cell))  # grouped by cell, strongest first
    rank = np.empty(len(idx), dtype=np.int64)
    sorted_cells = cell[order]
    starts = np.r_[0, np.flatnonzero(np.diff(sorted_cells)) + 1]
    ends = np.r_[starts[1:], len(order)]
    for start, end in zip(starts, ends):
        rank[order[start:end]] = np.arange(end - start)
    priority = np.lexsort((-response, rank))  # round-robin over cells

    levels = sorted(set(level.tolist()))
    sf2 = CONFIG["scale_factor"] ** 2
    area = np.array([sf2 ** -lv for lv in levels])
    balance = CONFIG["level_balance"]
    share = (1 - balance) * area / area.sum() + balance / len(levels)
    quota = dict(zip(levels, np.floor(share * budget).astype(int)))

    chosen = np.zeros(len(idx), dtype=bool)
    used = dict.fromkeys(levels, 0)
    for j in priority:
        lv = int(level[j])
        if used[lv] < quota[lv]:
            chosen[j] = True
            used[lv] += 1
    # Levels without enough candidates leave budget over: fill with next best.
    left = budget - int(chosen.sum())
    for j in priority:
        if left <= 0:
            break
        if not chosen[j]:
            chosen[j] = True
            left -= 1
    sel = idx[chosen]
    # Strongest first, so a preview capped at N shows the best points.
    return sel[np.argsort([-keypoints[i].response for i in sel], kind="stable")]


def rate(feature_count, coverage, uniqueness, scale_coverage):
    """0 = untrackable, 1..5 stars.

    Coverage (are points everywhere?) and uniqueness (are they distinct?)
    count for more than the raw number of points.
    """
    if feature_count < CONFIG["min_features"]:
        return 0
    count = min(feature_count / 600.0, 1.0)
    score = 0.2 * count + 0.4 * coverage + 0.3 * uniqueness + 0.1 * scale_coverage
    if score >= 0.8:
        stars = 5
    elif score >= 0.65:
        stars = 4
    elif score >= 0.5:
        stars = 3
    elif score >= 0.35:
        stars = 2
    else:
        stars = 1
    if coverage < 0.3:  # points stuck in a small part of the image
        stars = min(stars, 2)
    if uniqueness < 0.3:  # mostly repeated texture: matches are ambiguous
        stars = min(stars, 2 if uniqueness >= 0.15 else 1)
    return stars


def _detect(image_path):
    """Processed gray image plus the selected keypoints/descriptors."""
    gray, src_size, size = _processed_gray(image_path)
    width, height = size
    keypoints, descriptors = _orb().detectAndCompute(gray, None)
    if descriptors is None or not keypoints:
        empty = (np.zeros((0, 2), np.float32), np.zeros((0, 32), np.uint8))
        return gray, src_size, size, [], empty[0], empty[1], {"candidates": 0, "ambiguous": 0}
    points = np.array([kp.pt for kp in keypoints], dtype=np.float32).reshape(-1, 2)
    ambiguous = _ambiguous_mask(points, descriptors)
    sel = _select(keypoints, points, width, height, ~ambiguous)
    stats = {"candidates": len(keypoints), "ambiguous": int(ambiguous.sum())}
    return gray, src_size, size, [keypoints[i] for i in sel], points[sel], descriptors[sel], stats


def compile_target(image_path):
    """Compile one image. Returns arrays for the bundle plus quality metadata.

    Raises TargetCompileError when the image cannot be read.
    """
    _gray, (src_w, src_h), (width, height), kps, points, descriptors, stats = _detect(image_path)
    count = len(kps)
    candidates = stats["candidates"]
    coverage = _spread(points, width, height)
    uniqueness = 1.0 - stats["ambiguous"] / candidates if candidates else 0.0
    per_level = {}
    for k in kps:
        per_level[k.octave] = per_level.get(k.octave, 0) + 1
    scale_levels = sum(1 for n in per_level.values() if n >= 20)
    scale_coverage = scale_levels / CONFIG["nlevels"]
    rating = rate(count, coverage, uniqueness, scale_coverage)

    # Preview keypoints in ORIGINAL image pixels (drawFeaturePreview draws on
    # the natural-size image).
    back = src_w / width if width else 1.0
    preview = [
        {
            "x": round(float(k.pt[0]) * back, 1),
            "y": round(float(k.pt[1]) * back, 1),
            "size": round(float(k.size) * back, 1),
        }
        for k in kps[:PREVIEW_KEYPOINTS]
    ]

    quality = {
        "compiler_version": COMPILER_VERSION,
        "status": "ready" if rating > 0 else "failed",
        "feature_count": count,
        "candidates": candidates,
        "ambiguous": stats["ambiguous"],
        "spread": round(coverage, 3),
        "uniqueness": round(uniqueness, 3),
        "scale_levels": scale_levels,
        "rating": rating,
        "rating_text": RATING_TEXT[rating],
        "width": width,
        "height": height,
        "source_width": src_w,
        "source_height": src_h,
        "rich_keypoints": preview,
    }
    if rating == 0:
        quality["error"] = "Too few distinct features. Use a more detailed, high-contrast image."
    return {"quality": quality, "points": points, "descriptors": descriptors}


def _b64(array):
    return base64.b64encode(np.ascontiguousarray(array).tobytes()).decode("ascii")


def bundle_entry(target, index, compiled):
    q = compiled["quality"]
    desc = compiled["descriptors"]
    return {
        "index": index,
        "id": str(target.id),
        "name": target.name,
        "width": q["width"],
        "height": q["height"],
        "count": int(desc.shape[0]),
        # Little-endian float32 [x0, y0, x1, y1, ...]
        "keypoints": _b64(compiled["points"].astype("<f4")),
        # uint8, count x 32 bytes, row-major (cv.CV_8UC1 matrix)
        "descriptors": _b64(desc.astype(np.uint8)),
    }


def targets_signature(targets):
    """Changes whenever the compiled bundle would change."""
    h = hashlib.sha1(f"v{COMPILER_VERSION}".encode())
    for t in targets:
        h.update(f"|{t.id}:{t.image.name}".encode())
    return h.hexdigest()


def generate_feature_preview_image(image_path):
    """Grayscale (as tracked) image with the compiled ORB keypoints in red."""
    gray, _src, _size, keypoints, _pts, _desc, _stats = _detect(image_path)
    vis = cv2.drawKeypoints(
        gray,
        keypoints,
        None,
        color=(0, 0, 255),
        flags=cv2.DRAW_MATCHES_FLAGS_DRAW_RICH_KEYPOINTS,
    )
    success, buffer = cv2.imencode(".png", vis)
    if not success:
        raise TargetCompileError("Failed to encode preview image.")
    return buffer.tobytes(), len(keypoints)
