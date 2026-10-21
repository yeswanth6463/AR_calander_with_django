export const createOrb = (nfeatures) =>
  cv.ORB_create ? cv.ORB_create(nfeatures) : new cv.ORB(nfeatures)

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

    const mat = cv.imread(this._work);
    const gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    mat.delete();

    const orb = createOrb(this.targetFeatures);
    const kps = new cv.KeyPointVector();
    const desc = new cv.Mat();
    orb.detectAndCompute(gray, new cv.Mat(), kps, desc);
    gray.delete();
    orb.delete();

    if (desc.rows < this.minMatches) {
      kps.delete();
      desc.delete();
      throw new Error("Too few features — use a more detailed image.");
    }

    if (this.trainDesc) this.trainDesc.delete();
    this.trainDesc = desc;
    this.targetKeypoints = [];
    for (let i = 0; i < kps.size(); i++) {
      const kp = kps.get(i);
      this.targetKeypoints.push({ x: kp.pt.x, y: kp.pt.y });
    }
    kps.delete();
    return { features: this.targetKeypoints.length, width: this.targetW, height: this.targetH };
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

    const frame = cv.imread(this._work);
    const gray = new cv.Mat();
    cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
    frame.delete();

    const orb = createOrb(this.frameFeatures);
    const kps = new cv.KeyPointVector();
    const desc = new cv.Mat();
    orb.detectAndCompute(gray, new cv.Mat(), kps, desc);
    gray.delete();
    orb.delete();

    let result = { found: false, reason: "no features in frame" };

    if (desc.rows >= this.minMatches && this.trainDesc.rows > 0) {
      const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
      const matches = new cv.DMatchVectorVector();
      matcher.knnMatch(desc, this.trainDesc, matches, 2);

      const srcPts = [];
      const dstPts = [];
      for (let i = 0; i < matches.size(); i++) {
        const pair = matches.get(i);
        if (pair.size() === 2) {
          const m = pair.get(0);
          const n = pair.get(1);
          if (m.distance < this.ratio * n.distance && m.queryIdx < kps.size() && m.trainIdx < this.targetKeypoints.length) {
            const fp = kps.get(m.queryIdx).pt;
            srcPts.push([this.targetKeypoints[m.trainIdx].x, this.targetKeypoints[m.trainIdx].y]);
            dstPts.push([fp.x, fp.y]);
          }
        }
        pair.delete();
      }
      matches.delete();
      matcher.delete();

      if (srcPts.length >= 4) {
        const src = cv.matFromArray(srcPts.length, 1, cv.CV_32FC2, srcPts.flat());
        const dst = cv.matFromArray(dstPts.length, 1, cv.CV_32FC2, dstPts.flat());
        const H = cv.findHomography(src, dst, cv.RANSAC, 5.0);
        src.delete();
        dst.delete();

        if (H) {
          const cornersPx = [
            [0, 0],
            [this.targetW - 1, 0],
            [this.targetW - 1, this.targetH - 1],
            [0, this.targetH - 1],
          ];
          const cornersMat = cv.matFromArray(4, 1, cv.CV_32FC2, cornersPx.flat());
          const out = new cv.Mat();
          cv.perspectiveTransform(cornersMat, out, H);
          const f = out.data32F;
          const corners = [
            [f[0] / scale, f[1] / scale],
            [f[2] / scale, f[3] / scale],
            [f[4] / scale, f[5] / scale],
            [f[6] / scale, f[7] / scale],
          ];
          cornersMat.delete();
          out.delete();

          const area = Math.abs(
            0.5 * Math.abs(
              (corners[2][0] - corners[0][0]) * (corners[3][1] - corners[1][1]) -
              (corners[3][0] - corners[1][0]) * (corners[2][1] - corners[0][1])
            )
          );

          const finite = corners.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));

          if (finite && area > 0.0005 * vw * vh && area < 4 * vw * vh) {
            const H64 = H.data64F;
            result = {
              found: true,
              corners,
              // p_full = p_work / scale  => left-multiply rows 0,1 by 1/scale
              H: [
                H64[0] / scale, H64[1] / scale, H64[2] / scale,
                H64[3] / scale, H64[4] / scale, H64[5] / scale,
                H64[6], H64[7], H64[8],
              ],
              matchCount: srcPts.length,
            };
          } else {
            result = { found: false, reason: "invalid geometry" };
          }
          H.delete();
        } else {
          result = { found: false, reason: "homography failed" };
        }
      } else {
        result = { found: false, reason: `only ${srcPts.length} matches` };
      }
    }

    desc.delete();
    kps.delete();
    return result;
  }
}
