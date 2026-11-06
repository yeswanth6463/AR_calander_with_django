/**
 * Game rules for a published AR project (Project.game_settings):
 *   { enabled, goal: 'none' | 'score' | 'collect_all', target_score,
 *     time_limit (seconds, 0 = none), intro, win_message, lose_message }
 *
 * "Collect all" counts every item whose tap actions hide it ("Hide this
 * model"); the player wins once all of them are hidden.
 */

export const GAME_GOALS = [
  { id: 'none', label: 'No goal (just play / beat the clock)' },
  { id: 'score', label: 'Reach a target score' },
  { id: 'collect_all', label: 'Collect every model' },
]

export const DEFAULT_GAME = {
  enabled: false,
  goal: 'score',
  target_score: 100,
  time_limit: 60,
  intro: '',
  win_message: '',
  lose_message: '',
}

export const isCollectible = (item) =>
  (item?.behaviors?.on_tap || []).some((rule) => rule?.action === 'hide_self')

export const gameUsesScore = (game) => game?.goal === 'score'

/** Plain-language description shown on the start card. */
export function describeGoal(game, collectibleCount) {
  const parts = []
  if (game.goal === 'score') parts.push(`Reach ${formatNumber(game.target_score)} points`)
  else if (game.goal === 'collect_all') parts.push(`Collect all ${collectibleCount} item${collectibleCount === 1 ? '' : 's'}`)
  if (game.time_limit > 0) {
    parts.push(parts.length ? `within ${formatTime(game.time_limit)}` : `Score as much as you can in ${formatTime(game.time_limit)}`)
  }
  if (!parts.length) parts.push('Tap the models to play')
  return parts.join(' ')
}

/** entries: iterable of { item, fit } */
export function hasWon(game, score, entries) {
  if (game.goal === 'score') return score >= game.target_score
  if (game.goal === 'collect_all') {
    let total = 0
    for (const { item, fit } of entries) {
      if (!isCollectible(item)) continue
      total++
      if (fit.visible) return false
    }
    return total > 0
  }
  return false
}

export const formatTime = (seconds) => {
  const s = Math.max(0, Math.ceil(seconds))
  const m = Math.floor(s / 60)
  return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}

const formatNumber = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
