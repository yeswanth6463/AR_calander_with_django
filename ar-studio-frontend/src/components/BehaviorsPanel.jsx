import { useState } from 'react'
import { BEHAVIOR_ACTIONS, BEHAVIOR_SOUNDS, actionMeta, defaultValueFor } from '../ar/behaviors'

const normalise = (behaviors) => ({
  start_hidden: !!behaviors?.start_hidden,
  on_tap: Array.isArray(behaviors?.on_tap) ? behaviors.on_tap.map((r) => ({ ...r })) : [],
})

// Rules that would be rejected by the API (missing value) are held back
// locally until they are complete.
const isComplete = (rule) => {
  const kind = actionMeta(rule.action)?.value
  if (!kind) return true
  if (kind === 'number') return rule.value !== '' && Number.isFinite(Number(rule.value))
  return String(rule.value ?? '').trim() !== ''
}

/**
 * Editor for one experience item's tap behaviours.
 * Remount with `key={item.id}` when the selected item changes.
 *
 * props:
 *   behaviors    current value from the item
 *   otherItems   [{ id, label }] — items this one can show/hide
 *   onSave(next) persist (called with the full behaviors object)
 */
export default function BehaviorsPanel({ behaviors, otherItems, onSave }) {
  const [draft, setDraft] = useState(() => normalise(behaviors))

  const save = (next) => {
    setDraft(next)
    const complete = next.on_tap.filter(isComplete).map((rule) => {
      const kind = actionMeta(rule.action)?.value
      if (!kind) return { action: rule.action }
      return { action: rule.action, value: kind === 'number' ? Number(rule.value) : rule.value }
    })
    if (complete.length !== next.on_tap.length) return
    onSave(complete.length || next.start_hidden ? { start_hidden: next.start_hidden, on_tap: complete } : null)
  }

  const updateRule = (index, patch, commit = true) => {
    const on_tap = draft.on_tap.map((rule, i) => (i === index ? { ...rule, ...patch } : rule))
    const next = { ...draft, on_tap }
    if (commit) save(next)
    else setDraft(next)
  }

  const addRule = () => {
    save({ ...draft, on_tap: [...draft.on_tap, { action: 'add_score', value: 10 }] })
  }

  const removeRule = (index) => {
    save({ ...draft, on_tap: draft.on_tap.filter((_, i) => i !== index) })
  }

  const changeAction = (index, action) => {
    const kind = actionMeta(action)?.value
    const patch = { action, value: kind ? defaultValueFor(kind) : undefined }
    if (kind === 'item') patch.value = otherItems[0]?.id ?? ''
    updateRule(index, patch)
  }

  return (
    <div className="behaviors-panel">
      <label className="behaviors-check">
        <input
          type="checkbox"
          checked={draft.start_hidden}
          onChange={(e) => save({ ...draft, start_hidden: e.target.checked })}
        />
        <span>Hidden at start</span>
        <span className="tiny muted">(another model can reveal it)</span>
      </label>

      <div className="tiny muted behaviors-sub">When tapped:</div>
      {draft.on_tap.length === 0 && (
        <p className="tiny muted behaviors-empty">Nothing set — tapping plays / pauses the animation.</p>
      )}

      {draft.on_tap.map((rule, index) => {
        const kind = actionMeta(rule.action)?.value
        const incomplete = !isComplete(rule)
        return (
          <div key={index} className={`behavior-rule ${incomplete ? 'incomplete' : ''}`}>
            <select value={rule.action} onChange={(e) => changeAction(index, e.target.value)} aria-label="Action">
              {BEHAVIOR_ACTIONS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>

            {kind === 'item' && (
              <select
                value={rule.value ?? ''}
                onChange={(e) => updateRule(index, { value: e.target.value })}
                aria-label="Target model"
              >
                <option value="">Select model…</option>
                {otherItems.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {kind === 'number' && (
              <input
                type="number"
                step="1"
                value={rule.value ?? ''}
                onChange={(e) => updateRule(index, { value: e.target.value }, false)}
                onBlur={() => save(draft)}
                aria-label="Points"
              />
            )}
            {kind === 'sound' && (
              <select
                value={rule.value ?? 'pop'}
                onChange={(e) => updateRule(index, { value: e.target.value })}
                aria-label="Sound"
              >
                {BEHAVIOR_SOUNDS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
            {kind === 'text' && (
              <input
                type="text"
                maxLength={200}
                placeholder="Message text"
                value={rule.value ?? ''}
                onChange={(e) => updateRule(index, { value: e.target.value }, false)}
                onBlur={() => save(draft)}
                aria-label="Message"
              />
            )}

            <button
              type="button"
              className="behavior-remove"
              onClick={() => removeRule(index)}
              title="Remove action"
              aria-label="Remove action"
            >
              ✕
            </button>
          </div>
        )
      })}

      <button
        type="button"
        className="btn ghost small add-wide"
        onClick={addRule}
        disabled={draft.on_tap.length >= 10}
      >
        + Add tap action
      </button>
    </div>
  )
}
