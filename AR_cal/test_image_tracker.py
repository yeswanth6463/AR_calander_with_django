
import cv2
import numpy as np

from api.service.image_tracker import (
    extract_target_features,
    track_target_image,
)

# Replace this with the path to a real, detailed target image.
TARGET_PATH = (
    r"E:\fLUTTER-LEARNIING\AR_calander_with_django\AR_cal\dummy.jpg"
)

# Read the same image as a test camera frame.
frame = cv2.imread(TARGET_PATH)

if frame is None:
    raise SystemExit("Could not read TARGET_PATH. Check the file path.")

success, encoded = cv2.imencode(".jpg", frame)

if not success:
    raise SystemExit("Could not encode the test frame.")

features = extract_target_features(TARGET_PATH)

result = track_target_image(
    TARGET_PATH,
    encoded.tobytes(),
    cached_features=features,
)

print("Target feature count:", len(features["keypoints"]))
print("Tracking result:", result)
