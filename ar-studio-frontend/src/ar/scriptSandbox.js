/**
 * Runs a creator's game script in a dedicated Web Worker.
 *
 * Isolation: the worker has no DOM, no access to the page or its storage,
 * and network APIs (fetch, XHR, WebSocket, importScripts, …) are removed
 * before the script runs. It can only talk to the game through a small set
 * of whitelisted commands, and is terminated if it stops responding
 * (e.g. an infinite loop).
 */

const WORKER_SOURCE = `
'use strict';
(() => {
  const BLOCKED = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'importScripts',
    'indexedDB', 'caches', 'Worker', 'SharedWorker', 'BroadcastChannel', 'WebTransport', 'RTCPeerConnection',
    'Request', 'FileReaderSync', 'navigator', 'location'];
  let o = self;
  while (o && o !== Object.prototype) {
    for (const name of BLOCKED) {
      try {
        if (Object.prototype.hasOwnProperty.call(o, name)) {
          delete o[name];
          if (Object.prototype.hasOwnProperty.call(o, name)) {
            Object.defineProperty(o, name, { value: undefined, writable: false, configurable: false });
          }
        }
      } catch (e) { /* ignore */ }
    }
    o = Object.getPrototypeOf(o);
  }
})();

const post = self.postMessage.bind(self);
const send = (cmd, ...args) => post({ type: 'cmd', cmd, args });
let state = { score: 0, vars: {}, items: [] };
const handlers = Object.create(null);
const report = (err) => post({ type: 'error', message: String((err && err.message) || err) });
const safe = (fn) => (...args) => { try { fn(...args); } catch (err) { report(err); } };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const api = {
  on(name, fn) { if (typeof fn === 'function') (handlers[name] = handlers[name] || []).push(safe(fn)); },
  every(sec, fn) { return setInterval(safe(fn), Math.max(50, num(sec) * 1000)); },
  after(sec, fn) { return setTimeout(safe(fn), Math.max(0, num(sec) * 1000)); },
  cancel(id) { clearInterval(id); clearTimeout(id); },
  score() { return state.score; },
  addScore(n) { state.score += num(n); send('addScore', num(n)); },
  setScore(n) { state.score = num(n); send('setScore', state.score); },
  getVar(name) { return state.vars[String(name)] ?? 0; },
  setVar(name, value) { state.vars[String(name)] = num(value); send('setVar', String(name), num(value)); },
  items() { return state.items.slice(); },
  show(n) { send('show', String(n)); },
  hide(n) { send('hide', String(n)); },
  toggle(n) { send('toggle', String(n)); },
  animate(n) { send('animate', String(n)); },
  spin(n, speed) { send('spin', String(n), num(speed)); },
  move(n, x, y, z) { send('move', String(n), num(x), num(y), num(z)); },
  message(text) { send('message', String(text)); },
  sound(name) { send('sound', String(name)); },
  win(text) { send('win', text == null ? '' : String(text)); },
  lose(text) { send('lose', text == null ? '' : String(text)); },
  random(min = 0, max = 1) { return num(min) + Math.random() * (num(max) - num(min)); },
  log(...args) { post({ type: 'log', args: args.map((a) => String(a)) }); },
};

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'ping') return post({ type: 'pong' });
  if (msg.state) state = { ...state, ...msg.state };
  if (msg.type === 'init') {
    try {
      const names = Object.keys(api);
      const run = new Function(...names, '"use strict";\\n' + msg.code);
      run(...names.map((k) => api[k]));
    } catch (err) { report(err); }
  } else if (msg.type === 'event') {
    for (const fn of handlers[msg.name] || []) fn(...(msg.args || []));
  }
};
`

const HEARTBEAT_MS = 1000
const HANG_AFTER_MS = 4000
const MAX_COMMANDS_PER_SEC = 400

export function createScriptSandbox({ code, commands, state, onError }) {
  const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  let worker
  try {
    worker = new Worker(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  let alive = true
  let lastPong = performance.now()
  let windowStart = performance.now()
  let commandCount = 0

  const fail = (message) => {
    onError?.(message)
  }

  worker.onmessage = (e) => {
    const msg = e.data || {}
    if (msg.type === 'pong') {
      lastPong = performance.now()
    } else if (msg.type === 'error') {
      fail(`Script error: ${msg.message}`)
    } else if (msg.type === 'log') {
      console.info('[game script]', ...(msg.args || []))
    } else if (msg.type === 'cmd') {
      const now = performance.now()
      if (now - windowStart > 1000) {
        windowStart = now
        commandCount = 0
      }
      if (++commandCount > MAX_COMMANDS_PER_SEC) {
        fail('Script stopped: too many commands per second.')
        dispose()
        return
      }
      const fn = Object.prototype.hasOwnProperty.call(commands, msg.cmd) ? commands[msg.cmd] : null
      if (fn) {
        try {
          fn(...(Array.isArray(msg.args) ? msg.args : []))
        } catch (err) {
          console.warn('[game script] command failed', msg.cmd, err)
        }
      }
    }
  }
  worker.onerror = (e) => {
    e.preventDefault?.()
    fail(`Script error: ${e.message || 'failed to run'}`)
  }

  const heartbeat = setInterval(() => {
    if (!alive) return
    if (performance.now() - lastPong > HANG_AFTER_MS) {
      fail('Script stopped: it stopped responding (infinite loop?).')
      dispose()
      return
    }
    worker.postMessage({ type: 'ping' })
  }, HEARTBEAT_MS)

  worker.postMessage({ type: 'init', code, state })

  function dispose() {
    if (!alive) return
    alive = false
    clearInterval(heartbeat)
    worker.terminate()
  }

  return {
    emit(name, ...args) {
      if (alive) worker.postMessage({ type: 'event', name, args })
    },
    sync(nextState) {
      if (alive) worker.postMessage({ type: 'state', state: nextState })
    },
    dispose,
  }
}
