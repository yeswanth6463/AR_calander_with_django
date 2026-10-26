import assert from 'node:assert/strict'
import test from 'node:test'

import { ImageTracker, readHomography } from './tracker.js'

const CV_32F = 5
const CV_64F = 6
const CV_32FC2 = 13

class FakeMat {
  constructor({ rows = 0, cols = 0, depth = CV_64F, channels = 1, data } = {}) {
    this.rows = rows
    this.cols = cols
    this._depth = depth
    this._channels = channels
    this.deleted = false
    if (depth === CV_64F) this.data64F = data
    if (depth === CV_32F) this.data32F = data
  }

  empty() {
    return this.rows === 0 || this.cols === 0
  }

  channels() {
    return this._channels
  }

  depth() {
    return this._depth
  }

  type() {
    return this._depth + ((this._channels - 1) << 3)
  }

  delete() {
    this.deleted = true
  }
}

class FakeKeyPointVector {
  constructor() {
    this._kps = Array.from({ length: 20 }, (_, i) => ({ pt: { x: i, y: i } }))
  }

  size() {
    return this._kps.length
  }

  get(i) {
    return this._kps[i]
  }

  delete() {
    this.deleted = true
  }
}

class FakePair {
  constructor(i) {
    this._matches = [
      { distance: 10, queryIdx: i % 20, trainIdx: i },
      { distance: 20, queryIdx: (i + 1) % 20, trainIdx: i + 1 },
    ]
  }

  size() {
    return 2
  }

  get(i) {
    return this._matches[i]
  }

  delete() {
    this.deleted = true
  }
}

class FakeMatches {
  constructor() {
    this._pairs = Array.from({ length: 10 }, (_, i) => new FakePair(i))
  }

  size() {
    return this._pairs.length
  }

  get(i) {
    return this._pairs[i]
  }

  delete() {
    this.deleted = true
  }
}

let homographyResult = null
let findThrows = false
let perspectiveThrows = false
let perspectiveCalls = 0

const fakeCv = {
  CV_32F,
  CV_64F,
  CV_32FC2,
  COLOR_RGBA2GRAY: 11,
  NORM_HAMMING: 6,
  RANSAC: 8,
  Mat: FakeMat,
  imread: () => new FakeMat({ rows: 480, cols: 640, depth: 0 }),
  cvtColor: () => {},
  ORB_create: () => ({
    detectAndCompute: (_gray, _mask, _kps, desc) => {
      desc.rows = 100
      desc.cols = 32
    },
    delete: () => {},
  }),
  KeyPointVector: FakeKeyPointVector,
  BFMatcher: class {
    knnMatch() {}
    delete() {}
  },
  DMatchVectorVector: FakeMatches,
  matFromArray: (rows, cols, _type, data) =>
    new FakeMat({ rows, cols, depth: CV_32F, channels: 2, data }),
  findHomography: () => {
    if (findThrows) throw new Error('native findHomography failure')
    return homographyResult
  },
  perspectiveTransform: (_src, out) => {
    perspectiveCalls += 1
    if (perspectiveThrows) throw new Error('native perspectiveTransform failure')
    out.rows = 4
    out.cols = 1
    out.data32F = [0, 0, 100, 0, 100, 100, 0, 100]
  },
}

globalThis.cv = fakeCv
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
  }),
}

const video = { videoWidth: 640, videoHeight: 480 }

function makeTracker() {
  const tracker = new ImageTracker()
  tracker.targetW = 900
  tracker.targetH = 600
  tracker.targetKeypoints = Array.from({ length: 100 }, (_, i) => ({
    x: i,
    y: i,
  }))
  tracker.trainDesc = { rows: 100, delete() {} }
  return tracker
}

function validHomography() {
  return new FakeMat({
    rows: 3,
    cols: 3,
    depth: CV_64F,
    data: [1, 0, 100, 0, 1, 100, 0, 0, 1],
  })
}

test('readHomography rejects empty, malformed and non-finite matrices', () => {
  assert.equal(readHomography(null), null)
  assert.equal(readHomography(new FakeMat({ rows: 0, cols: 0 })), null)
  assert.equal(readHomography(new FakeMat({ rows: 2, cols: 3, data: [1, 0, 0, 0, 1, 0] })), null)
  assert.equal(
    readHomography(
      new FakeMat({ rows: 3, cols: 3, data: [1, 0, 0, 0, 1, 0, 0, 0, Number.NaN] })
    ),
    null
  )
  assert.equal(
    readHomography(
      new FakeMat({ rows: 3, cols: 3, data: [1, 2, 3, 2, 4, 6, 0, 0, 1] })
    ),
    null
  )
})

test('readHomography accepts CV_64F and CV_32F data', () => {
  const h64 = [1, 0, 100, 0, 1, 100, 0, 0, 1]
  assert.deepEqual(readHomography(new FakeMat({ rows: 3, cols: 3, data: h64 })), h64)

  const h32 = new FakeMat({
    rows: 3,
    cols: 3,
    depth: CV_32F,
    data: h64,
  })
  assert.deepEqual(readHomography(h32), h64)
})

test('track rejects an empty homography without calling perspectiveTransform', () => {
  homographyResult = new FakeMat({ rows: 0, cols: 0, depth: CV_64F, data: [] })
  findThrows = false
  perspectiveThrows = false
  perspectiveCalls = 0

  const result = makeTracker().track(video)

  assert.deepEqual(result, { found: false, reason: 'invalid homography' })
  assert.equal(perspectiveCalls, 0)
  assert.equal(homographyResult.deleted, true)
})

test('track survives perspectiveTransform throwing', () => {
  homographyResult = validHomography()
  findThrows = false
  perspectiveThrows = true
  perspectiveCalls = 0

  const result = makeTracker().track(video)

  assert.deepEqual(result, {
    found: false,
    reason: 'perspective transform failed',
  })
  assert.equal(perspectiveCalls, 1)
  assert.equal(homographyResult.deleted, true)
})

test('track survives findHomography throwing', () => {
  homographyResult = null
  findThrows = true
  perspectiveThrows = false

  const result = makeTracker().track(video)

  assert.deepEqual(result, { found: false, reason: 'homography failed' })
})

test('track reports a valid homography and projected corners', () => {
  homographyResult = validHomography()
  findThrows = false
  perspectiveThrows = false
  perspectiveCalls = 0

  const result = makeTracker().track(video)

  assert.equal(result.found, true)
  assert.equal(result.matchCount, 10)
  assert.deepEqual(result.corners, [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ])
  assert.deepEqual(result.H, [1, 0, 100, 0, 1, 100, 0, 0, 1])
  assert.equal(homographyResult.deleted, true)
})
