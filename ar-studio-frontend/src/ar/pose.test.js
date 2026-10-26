import assert from 'node:assert/strict'
import test from 'node:test'

import { poseFromHomography } from './pose.js'

const FRAME_W = 1280
const FRAME_H = 720
const FOV = 60
const TARGET_PX = 900
const ON_SCREEN_PX = 500
const TARGET_WORLD = 0.2

const focal = (FRAME_H / 2) / Math.tan((FOV * Math.PI) / 360)
const pxScale = ON_SCREEN_PX / TARGET_PX
const frontalH = [
  pxScale, 0, FRAME_W / 2,
  0, pxScale, FRAME_H / 2,
  0, 0, 1,
]

test('poses a frontal target at the expected physical distance', () => {
  const m = poseFromHomography(frontalH, FRAME_W, FRAME_H, FOV, TARGET_PX, TARGET_WORLD)
  const expected = (focal * TARGET_WORLD) / ON_SCREEN_PX
  const distance = Math.hypot(m[12], m[13], m[14])

  assert.ok(Math.abs(distance - expected) < 1e-6)
  assert.ok(distance < 100, 'target must stay inside the viewer far plane')
})

test('returns a column-major matrix with unit target axes', () => {
  const m = poseFromHomography(frontalH, FRAME_W, FRAME_H, FOV, TARGET_PX, TARGET_WORLD)

  const rounded = (values) => values.map((v) => Math.round(v) || 0)

  assert.deepEqual(rounded(m.slice(0, 4)), [1, 0, 0, 0])
  assert.deepEqual(rounded(m.slice(4, 8)), [0, -1, 0, 0])
  assert.deepEqual(rounded(m.slice(8, 12)), [0, 0, -1, 0])
})

test('scales translation with physical target width', () => {
  const normalized = poseFromHomography(
    frontalH,
    FRAME_W,
    FRAME_H,
    FOV,
    TARGET_PX,
    1
  )
  const physical = poseFromHomography(
    frontalH,
    FRAME_W,
    FRAME_H,
    FOV,
    TARGET_PX,
    TARGET_WORLD
  )

  const normalizedDistance = Math.hypot(
    normalized[12],
    normalized[13],
    normalized[14]
  )
  const physicalDistance = Math.hypot(physical[12], physical[13], physical[14])

  assert.ok(Math.abs(physicalDistance - normalizedDistance * TARGET_WORLD) < 1e-9)
})

test('resolves homography with negative scalar without flipping behind camera', () => {
  const invertedH = frontalH.map((v) => -v)
  const m = poseFromHomography(invertedH, FRAME_W, FRAME_H, FOV, TARGET_PX, TARGET_WORLD)
  const expected = (focal * TARGET_WORLD) / ON_SCREEN_PX
  const distance = Math.hypot(m[12], m[13], m[14])

  // In Three.js camera space, the object must stay in front of camera (Z < 0)
  assert.ok(m[14] < 0, 'target must remain in front of the camera')
  assert.ok(Math.abs(distance - expected) < 1e-6)

  const rounded = (values) => values.map((v) => Math.round(v) || 0)
  assert.deepEqual(rounded(m.slice(0, 4)), [1, 0, 0, 0])
  assert.deepEqual(rounded(m.slice(4, 8)), [0, -1, 0, 0])
  assert.deepEqual(rounded(m.slice(8, 12)), [0, 0, -1, 0])
})

