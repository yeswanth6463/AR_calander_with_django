const WARN_INTERVAL_MS = 5000;
const warnState = new Map();

function warnThrottled(key, message, err) {
  const now = Date.now();
  const state = warnState.get(key) || { last: 0, suppressed: 0 };
  if (now - state.last < WARN_INTERVAL_MS) {
    state.suppressed += 1;
    warnState.set(key, state);
    return;
  }
  const detail = err && err.message ? `: ${err.message}` : "";
  const suffix = state.suppressed
    ? ` (${state.suppressed} similar warnings suppressed)`
    : "";
  state.last = now;
  state.suppressed = 0;
  warnState.set(key, state);
  console.warn(`[ImageTracker] ${message}${detail}${suffix}`);
}

export const createOrb = (nfeatures) =>
  cv.ORB_create ? cv.ORB_create(nfeatures) : new cv.ORB(nfeatures);

// findHomography() returns an empty Mat when it cannot find a solution. In
// OpenCV.js that object is still truthy, so it must be inspected explicitly
// before it is handed to perspectiveTransform().
export function readHomography(H) {
  if (!H || H.rows !== 3 || H.cols !== 3) return null;
  if (typeof H.empty === "function" && H.empty()) return null;
  if (typeof H.channels === "function" && H.channels() !== 1) return null;

  const depth = typeof H.depth === "function" ? H.depth() : H.type();
  let source;
  if (depth === cv.CV_64F) source = H.data64F;
  else if (depth === cv.CV_32F) source = H.data32F;
  else return null;

  if (!source || source.length < 9) return null;

  const values = new Array(9);
  let maxAbs = 0;
  for (let i = 0; i < 9; i++) {
    const v = source[i];
    if (!Number.isFinite(v)) return null;
    values[i] = v;
    const abs = Math.abs(v);
    if (abs > maxAbs) maxAbs = abs;
  }
  if (maxAbs === 0) return null;

  const det =
    values[0] * (values[4] * values[8] - values[5] * values[7]) -
    values[1] * (values[3] * values[8] - values[5] * values[6]) +
    values[2] * (values[3] * values[7] - values[4] * values[6]);
  const detRel = Math.abs(det) / (maxAbs * maxAbs * maxAbs);
  if (!Number.isFinite(detRel) || detRel < 1e-8) return null;

  return values;
}

export class ImageTracker {
  constructor({ targetFeatures = 1500, frameFeatures = 900, ratio = 0.75, minMatches = 10 } = {}) {
    this.targetFeatures = targetFeatures;
    this.frameFeatures = frameFeatures;
    this.ratio = ratio;
    this.minMatches = minMatches;
    this.targetKeypoints = [];
    this.trainDesc = null;
    this.targetW = 0;
    this.targetH = 0;
    this._work = document.createElement("canvas");
    this._work.width = 640;
  }

  get ready() {
    return this.trainDesc !== null;
  }

  compile(source) {
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) throw new Error("Target has no size.");

    const scale = Math.min(1, 960 / Math.max(sw, sh));
    this.targetW = Math.round(sw * scale);
    this.targetH = Math.round(sh * scale);
    this._work.width = this.targetW;
    this._work.height = this.targetH;

    const ctx = this._work.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, this.targetW, this.targetH);

    let mat = null;
    let gray = null;
    let mask = null;
    let orb = null;
    let kps = null;
    let desc = null;
    let keepDesc = false;

    try {
      mat = cv.imread(this._work);
      gray = new cv.Mat();
      mask = new cv.Mat();
      orb = createOrb(this.targetFeatures);
      kps = new cv.KeyPointVector();
      desc = new cv.Mat();

      cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
      orb.detectAndCompute(gray, mask, kps, desc);

      if (desc.empty() || desc.rows < this.minMatches) {
        throw new Error("Too few features — use a more detailed image.");
      }

      const keypoints = [];
      for (let i = 0; i < kps.size(); i++) {
        const kp = kps.get(i);
        keypoints.push({ x: kp.pt.x, y: kp.pt.y });
      }

      if (this.trainDesc) this.trainDesc.delete();
      this.trainDesc = desc;
      keepDesc = true;
      this.targetKeypoints = keypoints;
      return {
        features: keypoints.length,
        width: this.targetW,
        height: this.targetH,
      };
    } finally {
      mat?.delete?.();
      gray?.delete?.();
      mask?.delete?.();
      orb?.delete?.();
      kps?.delete?.();
      if (desc && !keepDesc) desc.delete();
    }
  }

  track(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !this.ready) return { found: false, reason: "not ready" };

    const scale = Math.min(1, 640 / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (this._work.width !== w || this._work.height !== h) {
      this._work.width = w;
      this._work.height = h;
    }

    const ctx = this._work.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);

    let frame = null;
    let gray = null;
    let mask = null;
    let orb = null;
    let kps = null;
    let desc = null;
    let result = { found: false, reason: "no features in frame" };

    try {
      frame = cv.imread(this._work);
      gray = new cv.Mat();
      mask = new cv.Mat();
      orb = createOrb(this.frameFeatures);
      kps = new cv.KeyPointVector();
      desc = new cv.Mat();

      cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
      orb.detectAndCompute(gray, mask, kps, desc);

      if (desc.rows < this.minMatches || !this.trainDesc || this.trainDesc.rows === 0) {
        return result;
      }

      let matcher = null;
      let matches = null;
      const srcPts = [];
      const dstPts = [];

      try {
        matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
        matches = new cv.DMatchVectorVector();
        matcher.knnMatch(desc, this.trainDesc, matches, 2);

        for (let i = 0; i < matches.size(); i++) {
          const pair = matches.get(i);
          try {
            if (pair.size() === 2) {
              const m = pair.get(0);
              const n = pair.get(1);
              if (
                m.distance < this.ratio * n.distance &&
                m.queryIdx < kps.size() &&
                m.trainIdx < this.targetKeypoints.length
              ) {
                const fp = kps.get(m.queryIdx).pt;
                srcPts.push([
                  this.targetKeypoints[m.trainIdx].x,
                  this.targetKeypoints[m.trainIdx].y,
                ]);
                dstPts.push([fp.x, fp.y]);
              }
            }
          } finally {
            pair.delete();
          }
        }
      } finally {
        matches?.delete?.();
        matcher?.delete?.();
      }

      if (srcPts.length < 4) {
        result = { found: false, reason: `only ${srcPts.length} matches` };
      } else {
        let src = null;
        let dst = null;
        let H = null;

        try {
          src = cv.matFromArray(srcPts.length, 1, cv.CV_32FC2, srcPts.flat());
          dst = cv.matFromArray(dstPts.length, 1, cv.CV_32FC2, dstPts.flat());
          H = cv.findHomography(src, dst, cv.RANSAC, 5.0);
          const h = readHomography(H);

          if (!h) {
            warnThrottled(
              "invalid-homography",
              "findHomography returned an unusable matrix"
            );
            result = { found: false, reason: "invalid homography" };
          } else {
            const cornersPx = [
              [0, 0],
              [this.targetW - 1, 0],
              [this.targetW - 1, this.targetH - 1],
              [0, this.targetH - 1],
            ];
            let cornersMat = null;
            let out = null;

            try {
              cornersMat = cv.matFromArray(4, 1, cv.CV_32FC2, cornersPx.flat());
              out = new cv.Mat();
              cv.perspectiveTransform(cornersMat, out, H);

              if (!out.data32F || out.data32F.length < 8) {
                result = { found: false, reason: "perspective transform failed" };
              } else {
                const f = out.data32F;
                const corners = [
                  [f[0] / scale, f[1] / scale],
                  [f[2] / scale, f[3] / scale],
                  [f[4] / scale, f[5] / scale],
                  [f[6] / scale, f[7] / scale],
                ];

                const cross2d = (p1, p2, p3) =>
                  (p2[0] - p1[0]) * (p3[1] - p2[1]) - (p2[1] - p1[1]) * (p3[0] - p2[0]);

                const isConvexClockwise =
                  cross2d(corners[3], corners[0], corners[1]) > 0 &&
                  cross2d(corners[0], corners[1], corners[2]) > 0 &&
                  cross2d(corners[1], corners[2], corners[3]) > 0 &&
                  cross2d(corners[2], corners[3], corners[0]) > 0;

                const area = Math.abs(
                  0.5 * (
                    (corners[2][0] - corners[0][0]) * (corners[3][1] - corners[1][1]) -
                    (corners[3][0] - corners[1][0]) * (corners[2][1] - corners[0][1])
                  )
                );

                const finite = corners.every(
                  (c) => Number.isFinite(c[0]) && Number.isFinite(c[1])
                );

                if (finite && isConvexClockwise && area > 0.0005 * vw * vh && area < 4 * vw * vh) {
                  result = {
                    found: true,
                    corners,
                    // p_full = p_work / scale  => left-multiply rows 0,1 by 1/scale
                    H: [
                      h[0] / scale, h[1] / scale, h[2] / scale,
                      h[3] / scale, h[4] / scale, h[5] / scale,
                      h[6], h[7], h[8],
                    ],
                    matchCount: srcPts.length,
                  };
                } else {
                  result = { found: false, reason: "invalid geometry" };
                }
              }
            } catch (err) {
              warnThrottled(
                "perspective-transform",
                "perspectiveTransform failed",
                err
              );
              result = { found: false, reason: "perspective transform failed" };
            } finally {
              cornersMat?.delete?.();
              out?.delete?.();
            }
          }
        } catch (err) {
          warnThrottled("find-homography", "findHomography failed", err);
          result = { found: false, reason: "homography failed" };
        } finally {
          src?.delete?.();
          dst?.delete?.();
          if (H) H.delete();
        }
      }
    } finally {
      desc?.delete?.();
      kps?.delete?.();
      orb?.delete?.();
      mask?.delete?.();
      gray?.delete?.();
      frame?.delete?.();
    }

    return result;
  }
}
