const mul3 = (A, B) => {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) C[c * 3 + r] += A[k * 3 + r] * B[c * 3 + k];
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

export function poseFromHomography(H, frameW, frameH, fovDeg) {
  const f = (frameH / 2) / Math.tan((fovDeg * Math.PI) / 360);
  const cx = frameW / 2;
  const cy = frameH / 2;

  const Kinv = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const M = mul3(Kinv, H);

  let h1 = [M[0], M[3], M[6]];
  let h2 = [M[1], M[4], M[7]];
  const h3 = [M[2], M[5], M[8]];

  // target is `targetW` px wide -> world width = 1
  const s = 2 / (norm(h1) + norm(h2) || 1e-9);
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


