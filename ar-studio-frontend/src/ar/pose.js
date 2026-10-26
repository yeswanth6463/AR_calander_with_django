// Row-major 3x3 multiply. OpenCV returns homographies row-major; keeping the
// same layout here prevents accidentally transposing M.
const mul3 = (A, B) => {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return C;
};

const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize = (v) => {
  const n = norm(v);
  return n < 1e-9 ? [1, 0, 0] : scale(v, 1 / n);
};

/**
 * Decompose a target->frame homography into a Three.js object matrix.
 *
 * H is row-major and maps coordinates in target pixels (0..sourceWidthPx) to
 * frame pixels. Its source axes are rescaled so the target is
 * `targetWidthWorld` units wide; this keeps translation in the same world
 * units as the target width used by the viewer, instead of target pixels.
 */
export function poseFromHomography(
  H,
  frameW,
  frameH,
  fovDeg,
  sourceWidthPx = 1,
  targetWidthWorld = 1
) {
  const f = (frameH / 2) / Math.tan((fovDeg * Math.PI) / 360);
  const cx = frameW / 2;
  const cy = frameH / 2;

  const k =
    sourceWidthPx > 0 && targetWidthWorld > 0
      ? sourceWidthPx / targetWidthWorld
      : 1;
  // Scale the source (target) axes, i.e. columns 0 and 1 of H.
  const Hs = [
    H[0] * k, H[1] * k, H[2],
    H[3] * k, H[4] * k, H[5],
    H[6] * k, H[7] * k, H[8],
  ];

  const Kinv = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const M = mul3(Kinv, Hs);

  let h1 = [M[0], M[3], M[6]];
  let h2 = [M[1], M[4], M[7]];
  const h3 = [M[2], M[5], M[8]];

  let s = 2 / (norm(h1) + norm(h2) || 1e-9);
  // Homographies are defined up to a global sign scalar. The target is always
  // in front of the camera (Z > 0 in OpenCV frame). If h3[2] < 0, flip sign.
  if (h3[2] < 0) {
    s = -s;
  }
  h1 = scale(h1, s);
  h2 = scale(h2, s);
  const t = scale(h3, s);

  const r1 = normalize(h1);
  const r2 = normalize(sub(h2, scale(r1, dot(r1, h2))));
  const r3 = cross(r1, r2);

  // OpenCV cam frame (x right, y down, z forward) -> three.js (y up, z toward viewer)
  const flip = (v) => [v[0], -v[1], -v[2]];
  const c0 = flip(r1);
  const c1 = flip(r2);
  const c2 = flip(r3);
  const ct = flip(t);

  return [
    c0[0], c0[1], c0[2], 0,
    c1[0], c1[1], c1[2], 0,
    c2[0], c2[1], c2[2], 0,
    ct[0], ct[1], ct[2], 1,
  ];
}

export function smoothCorners(prev, next, alpha = 0.35) {
  if (!prev) return next;
  return next.map((p, i) => [
    prev[i][0] + (p[0] - prev[i][0]) * alpha,
    prev[i][1] + (p[1] - prev[i][1]) * alpha,
  ]);
}
