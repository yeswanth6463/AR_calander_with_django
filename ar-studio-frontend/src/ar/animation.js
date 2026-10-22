import * as THREE from 'three'

export const FRAME_RATE = 24

const LOOP_MODES = {
  repeat: THREE.LoopRepeat,
  once: THREE.LoopOnce,
  pingpong: THREE.LoopPingPong,
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

const TICK_MS = 120

export function createAnimationController(gltf) {
  const clips = (gltf.animations || []).filter((c) => c.duration > 0)
  const mixer = new THREE.AnimationMixer(gltf.scene)
  const actions = clips.map((c) => mixer.clipAction(c))
  const listeners = new Set()

  const state = {
    clips: clips.map((c, i) => ({ name: c.name || `Take ${i + 1}`, duration: c.duration })),
    index: 0,
    playing: false,
    loop: 'repeat',
    speed: 1,
    time: 0,
    duration: clips[0] ? clips[0].duration : 0,
    finished: false,
  }

  let current = actions[0] || null
  let lastEmit = 0

  const getState = () => {
    state.time = current ? current.time : 0
    return { ...state, clips: state.clips }
  }

  const notify = (force) => {
    const now = performance.now()
    if (!force && now - lastEmit < TICK_MS) return
    lastEmit = now
    const snap = getState()
    listeners.forEach((l) => l(snap))
  }

  const configure = () => {
    if (!current) return
    current.setLoop(LOOP_MODES[state.loop], Infinity)
    current.clampWhenFinished = state.loop === 'once'
    current.paused = !state.playing
  }

  mixer.addEventListener('finished', (e) => {
    if (e.action !== current) return
    state.playing = false
    state.finished = true
    notify(true)
  })

  const play = () => {
    if (!current) return
    if (state.finished) {
      current.reset()
      state.finished = false
      state.time = 0
    }
    state.playing = true
    configure()
    if (!current.isRunning()) current.play()
    current.paused = false
    mixer.update(0)
    notify(true)
  }

  const pause = () => {
    if (!current) return
    state.playing = false
    current.paused = true
    notify(true)
  }

  const api = {
    getState,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    get clipCount() {
      return clips.length
    },
    play,
    pause,
    toggle() {
      if (state.playing) pause()
      else play()
    },
    stop() {
      if (!current) return
      state.playing = false
      state.finished = false
      current.paused = true
      current.time = 0
      mixer.update(0)
      notify(true)
    },
    selectClip(i) {
      const next = actions[i]
      if (!next) return
      const prev = current
      state.index = i
      state.duration = clips[i].duration
      state.finished = false
      if (prev && prev !== next) prev.stop()
      current = next
      current.reset()
      configure()
      current.play()
      current.paused = !state.playing
      mixer.update(0)
      notify(true)
    },
    setLoop(mode) {
      if (!LOOP_MODES[mode]) return
      state.loop = mode
      state.finished = false
      configure()
      notify(true)
    },
    setSpeed(x) {
      state.speed = clamp(x, 0.1, 4)
      notify(true)
    },
    seek(t) {
      if (!current || !state.duration) return
      current.time = clamp(t, 0, state.duration)
      state.finished = false
      mixer.update(0)
      notify(true)
    },
    applySettings(s = {}) {
      if (!current) return
      if (typeof s.speed === 'number') state.speed = clamp(s.speed, 0.1, 4)
      if (s.loop && LOOP_MODES[s.loop]) state.loop = s.loop
      if (typeof s.clip === 'string' && s.clip) {
        const i = clips.findIndex((c) => c.name === s.clip)
        if (i >= 0 && i !== state.index) {
          state.index = i
          state.duration = clips[i].duration
          if (current) current.stop()
          current = actions[i]
          current.reset()
        }
      }
      state.finished = false
      configure()
      current.play()
      mixer.update(0)
      if (s.autoplay === false) {
        state.playing = false
        current.paused = true
        mixer.update(0)
        notify(true)
      } else {
        play()
      }
    },
    update(dt) {
      if (!current) return
      const step = Math.min(Math.max(0, dt), 0.25)
      mixer.update(state.playing ? step * state.speed : 0)
      notify(false)
    },
    dispose() {
      listeners.clear()
      mixer.stopAllAction()
      mixer.uncacheRoot(gltf.scene)
      current = null
    },
  }

  if (current) {
    current.play()
    current.paused = true
  }

  return api
}
