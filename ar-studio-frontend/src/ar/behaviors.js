/**
 * Tap behaviours for AR experience items.
 *
 * An item's `behaviors` (set in the studio, stored on ExperienceItem) looks like:
 *   { start_hidden: false, on_tap: [{ action: 'add_score', value: 10 }, ...] }
 *
 * Keep BEHAVIOR_ACTIONS in sync with BEHAVIOR_ACTIONS in AR_cal/api/serializer.py.
 */

/** value kinds: null = no value, 'item' = another item's id, 'number', 'sound', 'text' */
export const BEHAVIOR_ACTIONS = [
  { id: 'toggle_animation', label: 'Play / pause animation', value: null },
  { id: 'play_animation', label: 'Play animation', value: null },
  { id: 'hide_self', label: 'Hide this model', value: null },
  { id: 'show_item', label: 'Show model…', value: 'item' },
  { id: 'hide_item', label: 'Hide model…', value: 'item' },
  { id: 'toggle_item', label: 'Show / hide model…', value: 'item' },
  { id: 'add_score', label: 'Add points', value: 'number' },
  { id: 'play_sound', label: 'Play sound', value: 'sound' },
  { id: 'show_message', label: 'Show message', value: 'text' },
]

export const BEHAVIOR_SOUNDS = [
  { id: 'pop', label: 'Pop' },
  { id: 'chime', label: 'Chime' },
  { id: 'success', label: 'Success' },
  { id: 'fail', label: 'Fail' },
]

export const actionMeta = (id) => BEHAVIOR_ACTIONS.find((a) => a.id === id) || null

export const defaultValueFor = (kind) => {
  if (kind === 'number') return 10
  if (kind === 'sound') return 'pop'
  if (kind === 'text') return ''
  return ''
}

/** Normalised tap actions; items with no rules keep the default play/pause tap. */
export const tapActionsOf = (item) => {
  const list = item?.behaviors?.on_tap
  return Array.isArray(list) && list.length ? list : [{ action: 'toggle_animation' }]
}

export const usesScore = (items) =>
  items.some((item) => (item?.behaviors?.on_tap || []).some((rule) => rule?.action === 'add_score'))

/**
 * Run one item's tap actions.
 * ctx: { self, findItem(id), toggleAnimation(item), playAnimation(item),
 *        setVisible(entry, bool), addScore(n), playSound(name), showMessage(text) }
 * where `self` / findItem() return { item, fit }.
 */
export function runTapActions(actions, ctx) {
  for (const rule of actions) {
    const target = rule.value != null ? ctx.findItem(String(rule.value)) : null
    switch (rule.action) {
      case 'toggle_animation':
        ctx.toggleAnimation(ctx.self.item)
        break
      case 'play_animation':
        ctx.playAnimation(ctx.self.item)
        break
      case 'hide_self':
        ctx.setVisible(ctx.self, false)
        break
      case 'show_item':
        if (target) ctx.setVisible(target, true)
        break
      case 'hide_item':
        if (target) ctx.setVisible(target, false)
        break
      case 'toggle_item':
        if (target) ctx.setVisible(target, !target.fit.visible)
        break
      case 'add_score': {
        const n = Number(rule.value)
        if (Number.isFinite(n)) ctx.addScore(n)
        break
      }
      case 'play_sound':
        ctx.playSound(rule.value)
        break
      case 'show_message':
        if (rule.value) ctx.showMessage(String(rule.value))
        break
      default:
        break
    }
  }
}

// ---- Synthesised sounds (no audio assets needed) ---------------------------

let audioCtx = null
const getAudio = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    if (!audioCtx) audioCtx = new Ctx()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    return audioCtx
  } catch {
    return null
  }
}

const SOUND_NOTES = {
  // [frequency Hz, start s, duration s]
  pop: { type: 'sine', notes: [[660, 0, 0.09]], sweep: 0.5 },
  chime: { type: 'triangle', notes: [[880, 0, 0.25], [1320, 0.08, 0.3]] },
  success: { type: 'triangle', notes: [[523, 0, 0.14], [659, 0.1, 0.14], [784, 0.2, 0.3]] },
  fail: { type: 'sawtooth', notes: [[220, 0, 0.18], [165, 0.15, 0.3]], gain: 0.08 },
}

export function playSound(name) {
  const spec = SOUND_NOTES[name]
  const ctx = spec && getAudio()
  if (!ctx) return
  const t0 = ctx.currentTime
  for (const [freq, start, dur] of spec.notes) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = spec.type
    osc.frequency.setValueAtTime(freq, t0 + start)
    if (spec.sweep) osc.frequency.exponentialRampToValueAtTime(freq * spec.sweep, t0 + start + dur)
    const peak = spec.gain ?? 0.16
    gain.gain.setValueAtTime(0.0001, t0 + start)
    gain.gain.exponentialRampToValueAtTime(peak, t0 + start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t0 + start)
    osc.stop(t0 + start + dur + 0.02)
  }
}
