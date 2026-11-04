
import cv2
import numpy as np


def extract_target_features(image_path):
    """Extract and cache ORB features for a reference image."""
    image = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)

    if image is None:
        raise ValueError("Unable to read target image.")

    orb = cv2.ORB_create(nfeatures=1500)
    keypoints, descriptors = orb.detectAndCompute(image, None)

    if descriptors is None or len(keypoints) < 8:
        raise ValueError(
            "Target has too few visual features. Use a clearer, "
            "more detailed image."
        )

    return {
        "width": image.shape[1],
        "height": image.shape[0],
        "keypoints": [list(k.pt) for k in keypoints],
        "rich_keypoints": [
            {
                "x": round(float(k.pt[0]), 2),
                "y": round(float(k.pt[1]), 2),
                "size": round(float(k.size), 2),
                "response": round(float(k.response), 4),
            }
            for k in keypoints
        ],
        "descriptors": descriptors.tolist(),
    }


def generate_feature_preview_image(image_path, nfeatures=1500):
    """Generate a high-contrast grayscale image with rich ORB keypoint circles in red."""
    image = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("Unable to read target image.")

    orb = cv2.ORB_create(nfeatures=nfeatures)
    keypoints = orb.detect(image, None)

    # Red circles in BGR: (0, 0, 255) with keypoint size & orientation
    vis = cv2.drawKeypoints(
        image,
        keypoints,
        None,
        color=(0, 0, 255),
        flags=cv2.DRAW_MATCHES_FLAGS_DRAW_RICH_KEYPOINTS,
    )
    success, buffer = cv2.imencode(".png", vis)
    if not success:
        raise ValueError("Failed to encode preview image.")
    return buffer.tobytes(), len(keypoints)


def get_target_features_details(image_path, cached_features=None, nfeatures=1500):
    """Return keypoint details and AR tracking rating for a target."""
    image = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("Unable to read target image.")

    h, w = image.shape[:2]
    orb = cv2.ORB_create(nfeatures=nfeatures)
    keypoints = orb.detect(image, None)

    count = len(keypoints)
    rating = 5 if count >= 500 else (4 if count >= 300 else (3 if count >= 150 else (2 if count >= 50 else 1)))
    rating_text = (
        "Optimal for Tracking" if rating == 5
        else "Good Tracking Stability" if rating == 4
        else "Moderate Tracking" if rating == 3
        else "Low Feature Count"
    )

    return {
        "width": w,
        "height": h,
        "feature_count": count,
        "rating": rating,
        "rating_text": rating_text,
        "rich_keypoints": [
            {
                "x": round(float(k.pt[0]), 2),
                "y": round(float(k.pt[1]), 2),
                "size": round(float(k.size), 2),
                "response": round(float(k.response), 4),
            }
            for k in keypoints
        ],
    }


def track_target_image(target_path, frame_bytes, cached_features=None):
    """Match a saved target image against one camera frame."""
    target = cv2.imread(target_path, cv2.IMREAD_GRAYSCALE)
    frame = cv2.imdecode(
        np.frombuffer(frame_bytes, dtype=np.uint8),
        cv2.IMREAD_GRAYSCALE,
    )

    if target is None or frame is None:
        raise ValueError("Unable to read target or camera frame.")

    if cached_features is None:
        cached_features = extract_target_features(target_path)

    target_points = np.asarray(
        cached_features["keypoints"], dtype=np.float32
    )
    target_descriptors = np.asarray(
        cached_features["descriptors"], dtype=np.uint8
    )

    orb = cv2.ORB_create(nfeatures=1500)
    frame_points, frame_descriptors = orb.detectAndCompute(frame, None)

    if frame_descriptors is None or len(frame_points) < 8:
        return {"found": False, "reason": "Insufficient frame features."}

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    pairs = matcher.knnMatch(
        target_descriptors, frame_descriptors, k=2
    )

    matches = [
        first
        for pair in pairs
        if len(pair) == 2
        for first, second in [pair]
        if first.distance < 0.75 * second.distance
    ]

    if len(matches) < 8:
        return {
            "found": False,
            "reason": "Not enough reliable feature matches.",
            "match_count": len(matches),
        }

    source = np.float32([
        target_points[m.queryIdx] for m in matches
    ]).reshape(-1, 1, 2)

    destination = np.float32([
        frame_points[m.trainIdx].pt for m in matches
    ]).reshape(-1, 1, 2)

    homography, mask = cv2.findHomography(
        source, destination, cv2.RANSAC, 5.0
    )

    if homography is None or mask is None:
        return {"found": False, "reason": "Homography estimation failed."}

    inliers = int(mask.sum())

    if inliers < 8:
        return {
            "found": False,
            "reason": "Insufficient geometrically consistent matches.",
            "inlier_count": inliers,
        }

    height, width = cached_features["height"], cached_features["width"]

    corners = np.float32([
        [0, 0],
        [width - 1, 0],
        [width - 1, height - 1],
        [0, height - 1],
    ]).reshape(-1, 1, 2)

    projected = cv2.perspectiveTransform(corners, homography).reshape(-1, 2)

    frame_height, frame_width = frame.shape
    area = abs(cv2.contourArea(projected.astype(np.float32)))

    if (
        not np.isfinite(projected).all()
        or area < 100
        or area > 4 * frame_width * frame_height
    ):
        return {"found": False, "reason": "Invalid target geometry."}

    return {
        "found": True,
        "match_count": len(matches),
        "inlier_count": inliers,
        "target_corners": projected.round(2).tolist(),
        "frame_width": frame_width,
        "frame_height": frame_height,
    }
