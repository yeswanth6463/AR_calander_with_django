/**
 * AR Game engine: runs the rule builder rules and the optional user script
 * (Project.game_logic) against the AR viewer.
 *
 * Keep the whitelists in sync with AR_cal/api/game_logic.py.
 */
import { createScriptSandbox } from './scriptSandbox'

// ---- Editor metadata -------------------------------------------------------
// Param kinds: item, item?, seconds, value, var, op, bool, sound, asset, text, text?, x/y/z (number)

export const RULE_EVENTS = [
  { id: 'game_start', label: 'Game starts', params: [] },
  { id: 'tap', label: 'Player taps', params: ['item?'] },
  { id: 'target_found', label: 'Target image is found', params: [] },
  { id: 'target_lost', label: 'Target image is lost', params: [] },
  { id: 'every', label: 'Every … seconds', params: ['seconds'] },
  { id: 'after', label: 'After … seconds', params: ['seconds'] },
  { id: 'score_at_least', label: 'Score reaches', params: ['value'] },
  { id: 'var_at_least', label: 'Variable reaches', params: ['var', 'value'] },
]

export const RULE_CONDITIONS = [
  { id: 'score', label: 'Score is', params: ['op', 'value'] },
  { id: 'var', label: 'Variable', params: ['var', 'op', 'value'] },
  { id: 'visible', label: 'Model is visible', params: ['item', 'bool'] },
]

export const OPS = ['<', '<=', '==', '!=', '>=', '>']

export const RULE_ACTIONS = [
  { id: 'show_item', label: 'Show model', params: ['item'] },
  { id: 'hide_item', label: 'Hide model', params: ['item'] },
  { id: 'toggle_item', label: 'Show / hide model', params: ['item'] },
  { id: 'play_animation', label: 'Play animation', params: ['item'] },
  { id: 'toggle_animation', label: 'Play / pause animation', params: ['item'] },
  { id: 'spin_item', label: 'Spin model (°/s, 0 = stop)', params: ['item', 'value'] },
  { id: 'move_item', label: 'Move model by (x, y, z)', params: ['item', 'x', 'y', 'z'] },
  { id: 'add_score', label: 'Add to score', params: ['value'] },
  { id: 'set_score', label: 'Set score', params: ['value'] },
  { id: 'set_var', label: 'Set variable', params: ['var', 'value'] },
  { id: 'change_var', label: 'Change variable by', params: ['var', 'value'] },
  { id: 'play_sound', label: 'Play built-in sound', params: ['sound'] },
  { id: 'play_asset_sound', label: 'Play uploaded sound', params: ['asset'] },
  { id: 'show_message', label: 'Show message', params: ['text'] },
  { id: 'win', label: 'Win the game', params: ['text?'] },
  { id: 'lose', label: 'Lose the game', params: ['text?'] },
]

export const EMPTY_LOGIC = { variables: [], rules: [], script_enabled: false, script: '' }

export const SCRIPT_TEMPLATE = `// Runs on the player's phone in a sandbox (no network, no page access).
// Models are referenced by name (as shown in the studio).
//
// Events:   on('start' | 'tap' | 'found' | 'lost', fn)   tap → fn(modelName)
// Timers:   every(seconds, fn)  after(seconds, fn)  cancel(id)
// Score:    score()  addScore(n)  setScore(n)
// Vars:     getVar(name)  setVar(name, number)
// Models:   show(name) hide(name) toggle(name) animate(name)
//           spin(name, degPerSec) move(name, x, y, z)
// Feedback: message(text)  sound('pop'|'chime'|'success'|'fail' or uploaded name)
// End:      win(text?)  lose(text?)
// Utils:    random(min, max)  log(...)

on('start', () => {
  message('Tap the models!')
})

on('tap', (name) => {
  addScore(10)
  if (score() >= 50) win('Great job!')
})
`

// ---- Runtime ---------------------------------------------------------------

const MAX_DEPTH = 8

const compare = (a, op, b) => {
  switch (op) {
    case '<': return a < b
    case '<=': return a <= b
    case '==': return a === b
    case '!=': return a !== b
    case '>=': return a >= b
    case '>': return a > b
    default: return false
  }
}

/**
 * adapter (provided by the viewer):
 *   findItem(ref) → { item, fit } | null   (ref = item id or name)
 *   itemNames() → string[]
 *   setVisible(entry, bool), toggleAnimation(entry), playAnimation(entry)
 *   getScore(), addScore(n), setScore(n)
 *   playSound(name), playAssetSound(ref) → bool, showMessage(text)
 *   win(text), lose(text), isPlaying()
 */
export function createGameEngine({ logic, adapter, onError }) {
  const rules = Array.isArray(logic?.rules) ? logic.rules : []
  const variables = Array.isArray(logic?.variables) ? logic.variables : []
  const vars = new Map()
  const timers = [] // { rule, seconds, acc, fired }
  const thresholds = new Map() // rule index -> previous value
  const spins = new Map() // fit -> deg/s
  const tweens = new Map() // fit -> { from, to, t }
  const baseTransforms = new Map() // fit -> { position, rotation }
  let script = null
  let running = false
  let depth = 0

  const remember = (fit) => {
    if (!baseTransforms.has(fit)) {
      baseTransforms.set(fit, { position: fit.position.clone(), rotation: fit.rotation.clone() })
    }
  }

  const getVar = (name) => vars.get(name) ?? 0
  const setVar = (name, value) => {
    const n = Number(value)
    vars.set(String(name), Number.isFinite(n) ? n : 0)
    afterChange()
  }

  const conditionsPass = (conds = []) =>
    conds.every((c) => {
      if (c.type === 'score') return compare(adapter.getScore(), c.op, Number(c.value))
      if (c.type === 'var') return compare(getVar(c.var), c.op, Number(c.value))
      if (c.type === 'visible') {
        const entry = adapter.findItem(c.item)
        return !!entry && entry.fit.visible === !!c.bool
      }
      return false
    })

  const runActions = (actions = []) => {
    if (depth >= MAX_DEPTH) return
    depth++
    try {
      for (const a of actions) {
        if (!running) break
        runAction(a)
      }
    } finally {
      depth--
    }
  }

  const runAction = (a) => {
    const entry = a.item ? adapter.findItem(a.item) : null
    switch (a.action) {
      case 'show_item': if (entry) adapter.setVisible(entry, true); break
      case 'hide_item': if (entry) adapter.setVisible(entry, false); break
      case 'toggle_item': if (entry) adapter.setVisible(entry, !entry.fit.visible); break
      case 'play_animation': if (entry) adapter.playAnimation(entry); break
      case 'toggle_animation': if (entry) adapter.toggleAnimation(entry); break
      case 'spin_item':
        if (entry) {
          remember(entry.fit)
          const speed = Number(a.value) || 0
          if (speed) spins.set(entry.fit, speed)
          else spins.delete(entry.fit)
        }
        break
      case 'move_item':
        if (entry) {
          remember(entry.fit)
          const from = entry.fit.position.clone()
          const to = from.clone().add({ x: Number(a.x) || 0, y: Number(a.y) || 0, z: Number(a.z) || 0 })
          tweens.set(entry.fit, { from, to, t: 0 })
        }
        break
      case 'add_score': adapter.addScore(Number(a.value) || 0); afterChange(); break
      case 'set_score': adapter.setScore(Number(a.value) || 0); afterChange(); break
      case 'set_var': setVar(a.var, a.value); break
      case 'change_var': setVar(a.var, getVar(a.var) + (Number(a.value) || 0)); break
      case 'play_sound': adapter.playSound(a.sound); break
      case 'play_asset_sound': adapter.playAssetSound(a.asset); break
      case 'show_message': if (a.text) adapter.showMessage(a.text); break
      case 'win': adapter.win(a.text || ''); break
      case 'lose': adapter.lose(a.text || ''); break
      default: break
    }
  }

  const fire = (type, match) => {
    rules.forEach((rule) => {
      if (rule.event?.type !== type) return
      if (match && !match(rule.event)) return
      if (!conditionsPass(rule.conditions)) return
      runActions(rule.actions)
    })
  }

  // "Reaches" events fire when the value arrives at / crosses the target from
  // either side (score going up, lives counting down to 0, …).
  const currentFor = (ev) => (ev.type === 'score_at_least' ? adapter.getScore() : getVar(ev.var))
  const isThreshold = (ev) => ev?.type === 'score_at_least' || ev?.type === 'var_at_least'
  const afterChange = () => {
    if (!running) return
    rules.forEach((rule, index) => {
      const ev = rule.event
      if (!isThreshold(ev)) return
      const current = currentFor(ev)
      const target = Number(ev.value)
      const prev = thresholds.has(index) ? thresholds.get(index) : current
      thresholds.set(index, current)
      const reached = (prev < target && current >= target) || (prev > target && current <= target)
      if (reached && conditionsPass(rule.conditions)) runActions(rule.actions)
    })
    script?.sync({ score: adapter.getScore(), vars: Object.fromEntries(vars) })
  }

  // Script commands → the same adapter, whitelisted.
  const scriptCommands = {
    addScore: (n) => { adapter.addScore(Number(n) || 0); afterChange() },
    setScore: (n) => { adapter.setScore(Number(n) || 0); afterChange() },
    setVar: (k, v) => setVar(k, v),
    show: (n) => { const e = adapter.findItem(n); if (e) adapter.setVisible(e, true) },
    hide: (n) => { const e = adapter.findItem(n); if (e) adapter.setVisible(e, false) },
    toggle: (n) => { const e = adapter.findItem(n); if (e) adapter.setVisible(e, !e.fit.visible) },
    animate: (n) => { const e = adapter.findItem(n); if (e) adapter.playAnimation(e) },
    spin: (n, s) => runAction({ action: 'spin_item', item: n, value: s }),
    move: (n, x, y, z) => runAction({ action: 'move_item', item: n, x, y, z }),
    message: (t) => adapter.showMessage(String(t).slice(0, 200)),
    sound: (n) => {
      if (!adapter.playAssetSound(String(n))) adapter.playSound(String(n))
    },
    win: (t) => adapter.win(String(t || '').slice(0, 200)),
    lose: (t) => adapter.lose(String(t || '').slice(0, 200)),
  }

  return {
    get hasLogic() {
      return rules.length > 0 || !!logic?.script_enabled
    },
    start() {
      this.stop()
      running = true
      // Restore anything rules/scripts moved during the previous round.
      for (const [fit, base] of baseTransforms) {
        fit.position.copy(base.position)
        fit.rotation.copy(base.rotation)
      }
      spins.clear()
      tweens.clear()
      vars.clear()
      for (const v of variables) vars.set(v.name, Number(v.initial) || 0)
      thresholds.clear()
      rules.forEach((rule, index) => {
        if (isThreshold(rule.event)) thresholds.set(index, currentFor(rule.event))
      })
      timers.length = 0
      for (const rule of rules) {
        const t = rule.event?.type
        if (t === 'every' || t === 'after') timers.push({ rule, seconds: Number(rule.event.seconds) || 1, acc: 0, fired: false })
      }
      if (logic?.script_enabled && logic.script) {
        script = createScriptSandbox({
          code: logic.script,
          commands: scriptCommands,
          state: { score: adapter.getScore(), vars: Object.fromEntries(vars), items: adapter.itemNames() },
          onError: (msg) => onError?.(msg),
        })
      }
      fire('game_start')
      script?.emit('start')
      afterChange()
    },
    stop() {
      running = false
      script?.dispose()
      script = null
    },
    emit(type, payload = {}) {
      if (!running) return
      if (type === 'tap') {
        fire('tap', (ev) => !ev.item || ev.item === payload.itemId)
        script?.emit('tap', payload.itemName, payload.itemId)
      } else {
        fire(type)
        script?.emit(type === 'target_found' ? 'found' : type === 'target_lost' ? 'lost' : type)
      }
      afterChange()
    },
    tick(dt) {
      for (const [fit, speed] of spins) fit.rotation.y += (speed * Math.PI * dt) / 180
      for (const [fit, tw] of tweens) {
        tw.t = Math.min(tw.t + dt / 0.4, 1)
        const k = 1 - (1 - tw.t) ** 3
        fit.position.lerpVectors(tw.from, tw.to, k)
        if (tw.t >= 1) tweens.delete(fit)
      }
      if (!running) return
      for (const timer of timers) {
        if (timer.rule.event.type === 'after') {
          if (timer.fired) continue
          timer.acc += dt
          if (timer.acc >= timer.seconds) {
            timer.fired = true
            if (conditionsPass(timer.rule.conditions)) runActions(timer.rule.actions)
            afterChange()
          }
        } else {
          timer.acc += dt
          while (timer.acc >= timer.seconds && running) {
            timer.acc -= timer.seconds
            if (conditionsPass(timer.rule.conditions)) runActions(timer.rule.actions)
            afterChange()
          }
        }
      }
    },
    dispose() {
      this.stop()
    },
  }
}
