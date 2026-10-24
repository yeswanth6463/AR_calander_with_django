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

  // Default: check all clips so multi-part models (e.g. drones, cranes)
  // animate all parts together immediately
  const activeIndices = new Set(clips.map((_, i) => i))

  const getMaxDuration = () => {
    let max = 0
    clips.forEach((c, i) => {
      if (activeIndices.has(i) && c.duration > max) {
        max = c.duration
      }
    })
    if (max === 0 && clips.length > 0) {
      max = Math.max(...clips.map((c) => c.duration))
    }
    return max
  }

  const state = {
    clips: clips.map((c, i) => ({ name: c.name || `Take ${i + 1}`, duration: c.duration })),
    index: 0,
    playing: false,
    loop: 'once', // Default to playing once when opened!
    speed: 1,
    time: 0,
    duration: getMaxDuration(),
    finished: false,
  }

  let lastEmit = 0

  const getState = () => {
    return {
      ...state,
      clips: state.clips,
      activeIndices: Array.from(activeIndices),
      duration: getMaxDuration(),
    }
  }

  const notify = (force) => {
    const now = performance.now()
    if (!force && now - lastEmit < TICK_MS) return
    lastEmit = now
    const snap = getState()
    listeners.forEach((l) => l(snap))
  }

  const configure = () => {
    const isLoop = state.loop === 'repeat'
    actions.forEach((action, i) => {
      if (activeIndices.has(i)) {
        action.setLoop(isLoop ? THREE.LoopRepeat : THREE.LoopOnce, isLoop ? Infinity : 0)
        action.clampWhenFinished = !isLoop
        action.paused = !state.playing
      } else {
        action.stop()
      }
    })
  }

  mixer.addEventListener('finished', (e) => {
    if (state.loop === 'repeat') return
    // If all active actions have completed
    const allDone = actions.every(
      (a, i) => !activeIndices.has(i) || !a.isRunning() || a.paused
    )
    if (allDone) {
      state.playing = false
      state.finished = true
      state.time = getMaxDuration()
      notify(true)
    }
  })

  const play = () => {
    if (activeIndices.size === 0) return
    const maxDur = getMaxDuration()
    if (state.finished || (state.loop === 'once' && state.time >= maxDur - 1e-4)) {
      actions.forEach((a, i) => {
        if (activeIndices.has(i)) {
          a.reset()
          a.time = 0
        }
      })
      state.finished = false
      state.time = 0
    }
    state.playing = true
    const isLoop = state.loop === 'repeat'
    actions.forEach((action, i) => {
      if (activeIndices.has(i)) {
        action.setLoop(isLoop ? THREE.LoopRepeat : THREE.LoopOnce, isLoop ? Infinity : 0)
        action.clampWhenFinished = !isLoop
        if (!action.isRunning()) action.play()
        action.paused = false
      } else {
        action.stop()
      }
    })
    mixer.update(0)
    notify(true)
  }

  const pause = () => {
    state.playing = false
    actions.forEach((action, i) => {
      if (activeIndices.has(i)) {
        action.paused = true
      }
    })
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
      state.playing = false
      state.finished = false
      state.time = 0
      actions.forEach((action) => {
        action.stop()
        action.reset()
      })
      mixer.update(0)
      notify(true)
    },
    toggleClip(i) {
      const isLoop = state.loop === 'repeat'
      if (activeIndices.has(i)) {
        activeIndices.delete(i)
        actions[i]?.stop()
      } else {
        activeIndices.add(i)
        if (actions[i]) {
          actions[i].setLoop(isLoop ? THREE.LoopRepeat : THREE.LoopOnce, isLoop ? Infinity : 0)
          actions[i].clampWhenFinished = !isLoop
          actions[i].time = clamp(state.time, 0, clips[i].duration)
          if (state.playing) {
            actions[i].play()
            actions[i].paused = false
          }
        }
      }
      state.duration = getMaxDuration()
      mixer.update(0)
      notify(true)
    },
    setClipActive(i, active) {
      const isLoop = state.loop === 'repeat'
      if (active) {
        activeIndices.add(i)
        if (actions[i]) {
          actions[i].setLoop(isLoop ? THREE.LoopRepeat : THREE.LoopOnce, isLoop ? Infinity : 0)
          actions[i].clampWhenFinished = !isLoop
          actions[i].time = clamp(state.time, 0, clips[i].duration)
          if (state.playing) {
            actions[i].play()
            actions[i].paused = false
          }
        }
      } else {
        activeIndices.delete(i)
        actions[i]?.stop()
      }
      state.duration = getMaxDuration()
      mixer.update(0)
      notify(true)
    },
    selectAll() {
      clips.forEach((_, i) => activeIndices.add(i))
      configure()
      if (state.playing) {
        actions.forEach((a) => {
          a.play()
          a.paused = false
        })
      }
      state.duration = getMaxDuration()
      mixer.update(0)
      notify(true)
    },
    deselectAll() {
      activeIndices.clear()
      actions.forEach((a) => a.stop())
      state.duration = getMaxDuration()
      mixer.update(0)
      notify(true)
    },
    selectClip(i) {
      activeIndices.clear()
      activeIndices.add(i)
      state.index = i
      state.duration = clips[i] ? clips[i].duration : 0
      state.finished = false
      const isLoop = state.loop === 'repeat'
      actions.forEach((a, idx) => {
        if (idx === i) {
          a.reset()
          a.setLoop(isLoop ? THREE.LoopRepeat : THREE.LoopOnce, isLoop ? Infinity : 0)
          a.clampWhenFinished = !isLoop
          a.play()
          a.paused = !state.playing
        } else {
          a.stop()
        }
      })
      mixer.update(0)
      notify(true)
    },
    setLoop(mode) {
      state.loop = mode === 'repeat' ? 'repeat' : 'once'
      state.finished = false
      configure()
      notify(true)
    },
    toggleLoop() {
      state.loop = state.loop === 'repeat' ? 'once' : 'repeat'
      state.finished = false
      configure()
      notify(true)
    },
    setSpeed(x) {
      state.speed = clamp(x, 0.1, 4)
      notify(true)
    },
    seek(t) {
      const dur = getMaxDuration()
      state.time = clamp(t, 0, dur || 1)
      state.finished = false
      actions.forEach((action, i) => {
        if (activeIndices.has(i)) {
          const cDur = clips[i].duration
          action.time = clamp(state.time, 0, cDur)
          if (!action.isRunning() && state.playing) action.play()
        }
      })
      mixer.update(0)
      notify(true)
    },
    applySettings(s = {}) {
      if (typeof s.speed === 'number') state.speed = clamp(s.speed, 0.1, 4)
      if (s.loop) state.loop = s.loop === 'repeat' ? 'repeat' : 'once'
      if (typeof s.clip === 'string' && s.clip) {
        const i = clips.findIndex((c) => c.name === s.clip)
        if (i >= 0) {
          api.selectClip(i)
        }
      }
      state.finished = false
      configure()
      if (s.autoplay === false) {
        state.playing = false
        actions.forEach((a) => { a.paused = true })
        mixer.update(0)
        notify(true)
      } else {
        play()
      }
    },
    update(dt) {
      if (!state.playing) return
      const step = Math.min(Math.max(0, dt), 0.25)
      mixer.update(step * state.speed)

      // Sync state.time to the running action time
      let maxTime = 0
      const maxDur = getMaxDuration()
      actions.forEach((action, i) => {
        if (activeIndices.has(i) && action.time > maxTime) {
          maxTime = action.time
        }
      })
      state.time = maxTime

      // If loop is 'once' and we've reached the duration, finish playback
      if (state.loop === 'once' && maxDur > 0 && maxTime >= maxDur - 1e-4) {
        state.playing = false
        state.finished = true
        state.time = maxDur
        actions.forEach((a) => {
          if (a.isRunning()) a.paused = true
        })
        notify(true)
        return
      }

      notify(false)
    },
    dispose() {
      listeners.clear()
      mixer.stopAllAction()
      mixer.uncacheRoot(gltf.scene)
    },
  }

  // Pre-initialize active actions in paused state with LoopOnce default
  if (actions.length) {
    actions.forEach((a, i) => {
      if (activeIndices.has(i)) {
        a.setLoop(THREE.LoopOnce, 0)
        a.clampWhenFinished = true
        a.play()
        a.paused = true
      }
    })
  }

  return api
}
