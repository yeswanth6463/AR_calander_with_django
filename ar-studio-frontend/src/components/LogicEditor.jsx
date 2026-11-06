import { useState } from 'react'
import { EMPTY_LOGIC, OPS, RULE_ACTIONS, RULE_CONDITIONS, RULE_EVENTS, SCRIPT_TEMPLATE } from '../ar/gameEngine'
import { BEHAVIOR_SOUNDS } from '../ar/behaviors'

const metaOf = (list, id) => list.find((x) => x.id === id) || list[0]

const defaultFor = (param, ctx) => {
  const name = param.replace('?', '')
  if (param.endsWith('?')) return undefined
  switch (name) {
    case 'item': return ctx.items[0]?.id ?? ''
    case 'asset': return ctx.sounds[0]?.id ?? ''
    case 'var': return ctx.variables[0]?.name ?? ''
    case 'op': return '>='
    case 'seconds': return 5
    case 'value': return 10
    case 'x': case 'y': case 'z': return 0
    case 'bool': return true
    case 'sound': return 'pop'
    case 'text': return ''
    default: return ''
  }
}

const withDefaults = (base, params, ctx) => {
  const out = { ...base }
  for (const p of params) {
    const name = p.replace('?', '')
    if (out[name] === undefined) {
      const v = defaultFor(p, ctx)
      if (v !== undefined) out[name] = v
    }
  }
  return out
}

const newRule = (ctx) => ({
  event: withDefaults({ type: 'tap' }, metaOf(RULE_EVENTS, 'tap').params, ctx),
  conditions: [],
  actions: [withDefaults({ action: 'add_score' }, metaOf(RULE_ACTIONS, 'add_score').params, ctx)],
})

/**
 * Full-screen editor for Project.game_logic.
 * props: logic, items [{ id, label }], sounds [{ id, name }], onSave(logic) → Promise, onClose()
 */
export default function LogicEditor({ logic, items, sounds, onSave, onClose }) {
  const [draft, setDraft] = useState(() => ({ ...EMPTY_LOGIC, ...(logic || {}) }))
  const [tab, setTab] = useState(logic?.script_enabled && !(logic?.rules || []).length ? 'script' : 'rules')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)

  const ctx = { items, sounds, variables: draft.variables }
  const update = (patch) => {
    setDraft((d) => ({ ...d, ...patch }))
    setDirty(true)
  }
  const setRule = (index, rule) => update({ rules: draft.rules.map((r, i) => (i === index ? rule : r)) })

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await onSave(draft)
      setDirty(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (dirty && !confirm('Discard unsaved logic changes?')) return
    onClose()
  }

  return (
    <div className="wizard-backdrop" role="dialog" aria-modal="true" aria-labelledby="logic-title">
      <div className="wizard logic-editor">
        <div className="wizard-head">
          <div>
            <div className="tiny muted">AR Game</div>
            <h2 id="logic-title">Game logic</h2>
          </div>
          <div className="logic-head-actions">
            <button className="btn primary small" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
            <button type="button" className="btn ghost small" onClick={close} aria-label="Close">
              ✕
            </button>
          </div>
        </div>

        <div className="logic-tabs" role="tablist">
          {[
            ['rules', `Rules (${draft.rules.length})`],
            ['variables', `Variables (${draft.variables.length})`],
            ['script', `Script${draft.script_enabled ? ' · on' : ''}`],
          ].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`logic-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {error && <div className="auth-error">{error}</div>}

        {tab === 'rules' && (
          <div className="logic-rules">
            {draft.rules.length === 0 && (
              <p className="muted tiny">
                Rules run while the game is playing: <b>When</b> something happens, <b>if</b> the conditions hold,{' '}
                <b>do</b> the actions. Example: when the player taps “Coin”, add 10 points and hide “Coin”.
              </p>
            )}
            {draft.rules.map((rule, index) => (
              <RuleCard
                key={index}
                index={index}
                rule={rule}
                ctx={ctx}
                onChange={(next) => setRule(index, next)}
                onRemove={() => update({ rules: draft.rules.filter((_, i) => i !== index) })}
                onDuplicate={() =>
                  update({ rules: [...draft.rules.slice(0, index + 1), structuredClone(rule), ...draft.rules.slice(index + 1)] })
                }
              />
            ))}
            <button className="btn ghost small add-wide" onClick={() => update({ rules: [...draft.rules, newRule(ctx)] })} disabled={draft.rules.length >= 50}>
              + Add rule
            </button>
          </div>
        )}

        {tab === 'variables' && (
          <div className="logic-rules">
            <p className="muted tiny">
              Numbers your rules and script can read and change — e.g. <code>lives</code>, <code>level</code>,{' '}
              <code>coins</code>. They reset to their starting value each time the game starts.
            </p>
            {draft.variables.map((v, index) => (
              <div key={index} className="logic-row">
                <input
                  value={v.name}
                  maxLength={32}
                  placeholder="name"
                  aria-label="Variable name"
                  onChange={(e) =>
                    update({
                      variables: draft.variables.map((x, i) => (i === index ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, '') } : x)),
                    })
                  }
                />
                <span className="tiny muted">starts at</span>
                <input
                  type="number"
                  value={v.initial}
                  aria-label="Starting value"
                  onChange={(e) =>
                    update({ variables: draft.variables.map((x, i) => (i === index ? { ...x, initial: e.target.value } : x)) })
                  }
                />
                <button className="behavior-remove" aria-label="Remove variable" onClick={() => update({ variables: draft.variables.filter((_, i) => i !== index) })}>
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn ghost small add-wide"
              disabled={draft.variables.length >= 20}
              onClick={() => update({ variables: [...draft.variables, { name: `var${draft.variables.length + 1}`, initial: 0 }] })}
            >
              + Add variable
            </button>
          </div>
        )}

        {tab === 'script' && (
          <div className="logic-script">
            <label className="wizard-check">
              <input type="checkbox" checked={draft.script_enabled} onChange={(e) => update({ script_enabled: e.target.checked })} />
              Run this script during the game (alongside the rules)
            </label>
            <textarea
              className="logic-code"
              spellCheck={false}
              value={draft.script}
              maxLength={20000}
              placeholder="// Write your game script here"
              onChange={(e) => update({ script: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== 'Tab') return
                e.preventDefault()
                const el = e.currentTarget
                const { selectionStart: a, selectionEnd: b } = el
                const next = `${draft.script.slice(0, a)}  ${draft.script.slice(b)}`
                update({ script: next })
                requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
              }}
            />
            <div className="logic-script-foot">
              <span className="tiny muted">{draft.script.length.toLocaleString()} / 20,000 characters</span>
              <button
                className="btn ghost small"
                onClick={() => {
                  if (draft.script.trim() && !confirm('Replace your script with the example?')) return
                  update({ script: SCRIPT_TEMPLATE })
                }}
              >
                Insert example
              </button>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              Models are referenced by their name: {items.map((i) => `“${i.name}”`).join(', ') || 'add models first'}.
              {sounds.length > 0 && <> Sounds: {sounds.map((s) => `“${s.name}”`).join(', ')}.</>} Scripts run in a
              sandbox on the player’s phone with no network or page access.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function RuleCard({ index, rule, ctx, onChange, onRemove, onDuplicate }) {
  const event = metaOf(RULE_EVENTS, rule.event?.type)
  const setEvent = (patch) => onChange({ ...rule, event: { ...rule.event, ...patch } })
  const setCond = (i, c) => onChange({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? c : x)) })
  const setAction = (i, a) => onChange({ ...rule, actions: rule.actions.map((x, j) => (j === i ? a : x)) })

  return (
    <div className="logic-rule">
      <div className="logic-rule-head">
        <span className="tiny muted">Rule {index + 1}</span>
        <div className="logic-rule-tools">
          <button className="text-btn" onClick={onDuplicate}>Duplicate</button>
          <button className="text-btn danger-text" onClick={onRemove}>Delete</button>
        </div>
      </div>

      <div className="logic-row">
        <span className="logic-kw">When</span>
        <select
          value={rule.event.type}
          aria-label="Trigger"
          onChange={(e) => {
            const m = metaOf(RULE_EVENTS, e.target.value)
            onChange({ ...rule, event: withDefaults({ type: m.id }, m.params, ctx) })
          }}
        >
          {RULE_EVENTS.map((ev) => (
            <option key={ev.id} value={ev.id}>{ev.label}</option>
          ))}
        </select>
        <Params params={event.params} value={rule.event} ctx={ctx} onChange={setEvent} anyItemLabel="any model" />
      </div>

      {rule.conditions.map((cond, i) => {
        const m = metaOf(RULE_CONDITIONS, cond.type)
        return (
          <div key={i} className="logic-row">
            <span className="logic-kw">{i === 0 ? 'If' : 'and'}</span>
            <select
              value={cond.type}
              aria-label="Condition"
              onChange={(e) => {
                const next = metaOf(RULE_CONDITIONS, e.target.value)
                setCond(i, withDefaults({ type: next.id }, next.params, ctx))
              }}
            >
              {RULE_CONDITIONS.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <Params params={m.params} value={cond} ctx={ctx} onChange={(patch) => setCond(i, { ...cond, ...patch })} />
            <button className="behavior-remove" aria-label="Remove condition" onClick={() => onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </div>
        )
      })}

      {rule.actions.map((action, i) => {
        const m = metaOf(RULE_ACTIONS, action.action)
        return (
          <div key={i} className="logic-row">
            <span className="logic-kw">{i === 0 ? 'Do' : 'then'}</span>
            <select
              value={action.action}
              aria-label="Action"
              onChange={(e) => {
                const next = metaOf(RULE_ACTIONS, e.target.value)
                setAction(i, withDefaults({ action: next.id }, next.params, ctx))
              }}
            >
              {RULE_ACTIONS.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
            <Params params={m.params} value={action} ctx={ctx} onChange={(patch) => setAction(i, { ...action, ...patch })} />
            {rule.actions.length > 1 && (
              <button className="behavior-remove" aria-label="Remove action" onClick={() => onChange({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })}>
                ✕
              </button>
            )}
          </div>
        )
      })}

      <div className="logic-rule-add">
        <button
          className="text-btn"
          disabled={rule.conditions.length >= 10}
          onClick={() => onChange({ ...rule, conditions: [...rule.conditions, withDefaults({ type: 'score' }, metaOf(RULE_CONDITIONS, 'score').params, ctx)] })}
        >
          + condition
        </button>
        <button
          className="text-btn"
          disabled={rule.actions.length >= 20}
          onClick={() => onChange({ ...rule, actions: [...rule.actions, withDefaults({ action: 'show_message' }, metaOf(RULE_ACTIONS, 'show_message').params, ctx)] })}
        >
          + action
        </button>
      </div>
    </div>
  )
}

function Params({ params, value, ctx, onChange, anyItemLabel }) {
  return params.map((param) => {
    const optional = param.endsWith('?')
    const name = param.replace('?', '')
    const v = value[name]
    const set = (next) => onChange({ [name]: next })
    switch (name) {
      case 'item':
        return (
          <select key={name} value={v ?? ''} aria-label="Model" onChange={(e) => set(e.target.value || undefined)}>
            {optional ? <option value="">{anyItemLabel || 'any model'}</option> : <option value="" disabled>Pick a model…</option>}
            {ctx.items.map((i) => (
              <option key={i.id} value={i.id}>{i.label}</option>
            ))}
          </select>
        )
      case 'asset':
        return (
          <select key={name} value={v ?? ''} aria-label="Sound" onChange={(e) => set(e.target.value)}>
            <option value="" disabled>{ctx.sounds.length ? 'Pick a sound…' : 'Upload a sound first'}</option>
            {ctx.sounds.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )
      case 'var':
        return (
          <select key={name} value={v ?? ''} aria-label="Variable" onChange={(e) => set(e.target.value)}>
            <option value="" disabled>{ctx.variables.length ? 'Pick a variable…' : 'Add a variable first'}</option>
            {ctx.variables.map((x) => (
              <option key={x.name} value={x.name}>{x.name}</option>
            ))}
          </select>
        )
      case 'op':
        return (
          <select key={name} value={v ?? '>='} aria-label="Comparison" className="logic-narrow" onChange={(e) => set(e.target.value)}>
            {OPS.map((op) => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
        )
      case 'bool':
        return (
          <select key={name} value={v ? 'yes' : 'no'} aria-label="Visible" className="logic-narrow" onChange={(e) => set(e.target.value === 'yes')}>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        )
      case 'sound':
        return (
          <select key={name} value={v ?? 'pop'} aria-label="Sound" onChange={(e) => set(e.target.value)}>
            {BEHAVIOR_SOUNDS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        )
      case 'text':
        return (
          <input
            key={name}
            value={v ?? ''}
            maxLength={200}
            placeholder={optional ? 'Message (optional)' : 'Message'}
            aria-label="Text"
            onChange={(e) => set(e.target.value)}
          />
        )
      default:
        // seconds / value / x / y / z
        return (
          <input
            key={name}
            type="number"
            className="logic-narrow"
            step={name === 'seconds' ? 0.5 : name.length === 1 ? 0.05 : 1}
            min={name === 'seconds' ? 0.1 : undefined}
            value={v ?? ''}
            aria-label={name}
            placeholder={name}
            onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))}
          />
        )
    }
  })
}
