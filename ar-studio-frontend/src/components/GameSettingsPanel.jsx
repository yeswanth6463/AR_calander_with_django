import { useState } from 'react'
import { DEFAULT_GAME, GAME_GOALS, isCollectible } from '../ar/game'

/**
 * Project-level game rules (Project.game_settings).
 * props:
 *   settings     current value (may be null)
 *   items        every experience item in the project (for hints)
 *   onSave(next) persist; may reject with an Error
 */
export default function GameSettingsPanel({ settings, items, onSave, forceEnabled = false }) {
  const [draft, setDraft] = useState(() => ({
    ...DEFAULT_GAME,
    ...(settings || {}),
    ...(forceEnabled ? { enabled: true } : {}),
  }))

  const collectibles = items.filter(isCollectible).length
  const scorers = items.filter((item) =>
    (item.behaviors?.on_tap || []).some((rule) => rule.action === 'add_score')
  ).length

  const save = (next) => {
    setDraft(next)
    if (next.goal === 'score' && !(Number(next.target_score) > 0)) return
    const limit = Number(next.time_limit)
    if (!Number.isFinite(limit) || limit < 0 || limit > 3600) return
    onSave({
      ...next,
      target_score: Number(next.target_score) || 0,
      time_limit: Math.round(limit),
    })
  }
  const set = (patch, commit = true) => (commit ? save({ ...draft, ...patch }) : setDraft({ ...draft, ...patch }))
  const blur = () => save(draft)

  return (
    <div className="game-settings">
      {!forceEnabled && (
        <label className="game-enable">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>Make the published link a game</span>
        </label>
      )}

      {draft.enabled && (
        <>
          <label>
            Goal
            <select value={draft.goal} onChange={(e) => set({ goal: e.target.value })}>
              {GAME_GOALS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>

          {draft.goal === 'score' && (
            <label>
              Target score
              <input
                type="number"
                min="1"
                value={draft.target_score}
                onChange={(e) => set({ target_score: e.target.value }, false)}
                onBlur={blur}
              />
            </label>
          )}
          {draft.goal === 'score' && scorers === 0 && (
            <p className="tiny game-warn">No model gives points yet — add an “Add points” tap action.</p>
          )}
          {draft.goal === 'collect_all' && (
            <p className={`tiny ${collectibles ? 'muted' : 'game-warn'}`} style={{ margin: 0 }}>
              {collectibles
                ? `${collectibles} collectible model${collectibles === 1 ? '' : 's'} (models with “Hide this model” on tap).`
                : 'No collectibles yet — give models a “Hide this model” tap action.'}
            </p>
          )}

          <label>
            Time limit (seconds, 0 = no limit)
            <input
              type="number"
              min="0"
              max="3600"
              value={draft.time_limit}
              onChange={(e) => set({ time_limit: e.target.value }, false)}
              onBlur={blur}
            />
          </label>
          <label>
            Intro text (optional)
            <input
              maxLength={200}
              placeholder="e.g. Find all the coins hidden on the poster!"
              value={draft.intro}
              onChange={(e) => set({ intro: e.target.value }, false)}
              onBlur={blur}
            />
          </label>
          <label>
            Win message
            <input
              maxLength={200}
              placeholder="You win!"
              value={draft.win_message}
              onChange={(e) => set({ win_message: e.target.value }, false)}
              onBlur={blur}
            />
          </label>
          {(draft.time_limit > 0 || draft.time_limit === '') && draft.goal !== 'none' && (
            <label>
              Lose message
              <input
                maxLength={200}
                placeholder="Time's up!"
                value={draft.lose_message}
                onChange={(e) => set({ lose_message: e.target.value }, false)}
                onBlur={blur}
              />
            </label>
          )}
        </>
      )}
      <p className="tiny muted" style={{ margin: 0 }}>Republish the link for changes to go live.</p>
    </div>
  )
}
