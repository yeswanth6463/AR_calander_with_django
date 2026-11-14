import { useState } from 'react'
import { FACE_POINTS, OBJECT_LABELS, PROJECT_TYPES, projectTypeMeta } from '../ar/anchors'
import { SCRIPT_TEMPLATE } from '../ar/gameEngine'

const GAME_KINDS = [
  { id: 'collect_all', title: 'Collect items', blurb: 'Players tap models to collect them all.' },
  { id: 'score', title: 'Reach a score', blurb: 'Players earn points until they hit a target.' },
  { id: 'none', title: 'Custom game', blurb: 'You define how to win with rules or a script.' },
]
const TIME_LIMITS = [
  { value: 0, label: 'No limit' },
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
]
const LOGIC_STYLES = [
  { id: 'rules', title: 'Rule builder', blurb: '“When … if … do …” blocks, no coding.' },
  { id: 'script', title: 'JavaScript', blurb: 'Write code against a small game API.' },
  { id: 'both', title: 'Both', blurb: 'Rules for the basics, a script for the rest.' },
]
const SENSITIVITY = [
  { value: 0.35, label: 'Find more (may mis-detect)' },
  { value: 0.5, label: 'Balanced' },
  { value: 0.7, label: 'Only confident matches' },
]

/**
 * Asks what kind of project the user wants and the questions specific to
 * that type, then creates the project.
 * props: onCreate(body) → Promise, onCancel()
 */
export default function NewProjectWizard({ onCreate, onCancel }) {
  const [step, setStep] = useState(0)
  const [type, setType] = useState(null)
  const [arExperienceMode, setArExperienceMode] = useState('target_image') // 'target_image' | 'user_model'
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [gameKind, setGameKind] = useState('collect_all')
  const [targetScore, setTargetScore] = useState(100)
  const [timeLimit, setTimeLimit] = useState(60)
  const [logicStyle, setLogicStyle] = useState('rules')
  const [facePoint, setFacePoint] = useState('eyes')
  const [occlusion, setOcclusion] = useState(false)
  const [objectLabel, setObjectLabel] = useState('cup')
  const [confidence, setConfidence] = useState(0.5)
  const [showLabels, setShowLabels] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const meta = type ? projectTypeMeta(type) : null

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim()) return
    const body = { name: name.trim(), description: description.trim(), project_type: type }
    if (type === 'image_ar') {
      body.type_settings = { mode: arExperienceMode }
    } else if (type === 'game') {
      body.game_settings = {
        enabled: true,
        goal: gameKind,
        target_score: gameKind === 'score' ? Number(targetScore) || 100 : 0,
        time_limit: Number(timeLimit) || 0,
        intro: '',
        win_message: '',
        lose_message: '',
      }
      if (logicStyle !== 'rules') {
        body.game_logic = { variables: [], rules: [], script_enabled: true, script: SCRIPT_TEMPLATE }
      }
    } else if (type === 'face') {
      body.type_settings = { default_point: facePoint, occlusion }
    } else if (type === 'object') {
      body.type_settings = { default_label: objectLabel, min_confidence: Number(confidence), show_labels: showLabels }
    }
    setBusy(true)
    setError('')
    try {
      await onCreate(body)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  // Calculate total steps
  const totalSteps = type === 'image_ar' ? 3 : 2

  return (
    <div className="wizard-backdrop" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="wizard">
        <div className="wizard-head">
          <div>
            <div className="tiny muted">New project · step {step + 1} of {totalSteps}</div>
            <h2 id="wizard-title">
              {step === 0
                ? 'What do you want to create?'
                : step === 1 && type === 'image_ar'
                ? 'Choose AR Experience Mode'
                : `${meta.icon} ${meta.title}`}
            </h2>
          </div>
          <button type="button" className="btn ghost small" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Step 0: Choose Project Type */}
        {step === 0 && (
          <div className="wizard-types">
            {PROJECT_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`wizard-type ${type === t.id ? 'active' : ''}`}
                onClick={() => {
                  setType(t.id)
                  setStep(1)
                }}
              >
                <span className="wizard-type-icon" aria-hidden="true">{t.icon}</span>
                <span className="wizard-type-title">{t.title}</span>
                <span className="wizard-type-blurb">{t.blurb}</span>
              </button>
            ))}
          </div>
        )}

        {/* Step 1 for AR Experience: Choose Mode (Target Image vs User 3D Model) */}
        {step === 1 && type === 'image_ar' && (
          <div className="wizard-form">
            <p className="wizard-blurb-lead" style={{ margin: '0 0 14px', color: 'var(--muted)', fontSize: '13px' }}>
              Select how you want to build this AR Experience:
            </p>
            <div className="wizard-types">
              <button
                type="button"
                className={`wizard-type ${arExperienceMode === 'target_image' ? 'active' : ''}`}
                onClick={() => setArExperienceMode('target_image')}
                style={{ cursor: 'pointer' }}
              >
                <span className="wizard-type-icon" aria-hidden="true">🎯</span>
                <span className="wizard-type-title">Target Image Experience</span>
                <span className="wizard-type-blurb">
                  Anchor 3D content to a physical printed image, packaging, or marker (traditional marker-based tracking).
                </span>
              </button>

              <button
                type="button"
                className={`wizard-type ${arExperienceMode === 'user_model' ? 'active' : ''}`}
                onClick={() => setArExperienceMode('user_model')}
                style={{ cursor: 'pointer' }}
              >
                <span className="wizard-type-icon" aria-hidden="true">🧊</span>
                <span className="wizard-type-title">Upload Custom 3D Model</span>
                <span className="wizard-type-blurb">
                  Upload your own 3D model (.glb / .gltf) directly. Manipulate with drag, rotate, and scale controls in AR.
                </span>
              </button>
            </div>

            <div className="wizard-actions" style={{ marginTop: '16px' }}>
              <button type="button" className="btn ghost" onClick={() => setStep(0)}>
                ← Back
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => setStep(2)}
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* Final Step: Project Details Form */}
        {((step === 1 && type !== 'image_ar') || (step === 2 && type === 'image_ar')) && (
          <form className="wizard-form" onSubmit={submit}>
            <label>
              Project name
              <input required autoFocus maxLength={150} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Description <span className="muted">(optional)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>

            {type === 'image_ar' && (
              <p className="tiny muted wizard-note">
                {arExperienceMode === 'user_model'
                  ? '🧊 You will be able to upload your own 3D models (.glb/.gltf) and interactively drag, rotate, and scale them in AR.'
                  : '🎯 Next you’ll upload a target image (the picture people scan) and the 3D models or videos to show on it.'}
              </p>
            )}

            {type === 'game' && (
              <>
                <fieldset>
                  <legend>What kind of game is it?</legend>
                  <div className="wizard-choices">
                    {GAME_KINDS.map((k) => (
                      <Choice key={k.id} active={gameKind === k.id} onClick={() => setGameKind(k.id)} {...k} />
                    ))}
                  </div>
                </fieldset>
                {gameKind === 'score' && (
                  <label>
                    Points needed to win
                    <input type="number" min="1" value={targetScore} onChange={(e) => setTargetScore(e.target.value)} />
                  </label>
                )}
                <fieldset>
                  <legend>Time limit</legend>
                  <div className="wizard-pills">
                    {TIME_LIMITS.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        className={`wizard-pill ${timeLimit === t.value ? 'active' : ''}`}
                        onClick={() => setTimeLimit(t.value)}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>How do you want to build the game logic?</legend>
                  <div className="wizard-choices">
                    {LOGIC_STYLES.map((k) => (
                      <Choice key={k.id} active={logicStyle === k.id} onClick={() => setLogicStyle(k.id)} {...k} />
                    ))}
                  </div>
                </fieldset>
                <p className="tiny muted wizard-note">
                  Players start the game by scanning a target image. You can upload 3D models, images, videos and
                  sounds as game assets.
                </p>
              </>
            )}

            {type === 'face' && (
              <>
                <label>
                  Where will your first effect go?
                  <select value={facePoint} onChange={(e) => setFacePoint(e.target.value)}>
                    {FACE_POINTS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wizard-check">
                  <input type="checkbox" checked={occlusion} onChange={(e) => setOcclusion(e.target.checked)} />
                  Hide parts of models behind the head (hat backs, glasses arms) — experimental
                </label>
                <p className="tiny muted wizard-note">Viewers use their front camera. Nothing is recorded or uploaded.</p>
              </>
            )}

            {type === 'object' && (
              <>
                <label>
                  Which object should trigger your content?
                  <select value={objectLabel} onChange={(e) => setObjectLabel(e.target.value)}>
                    {OBJECT_LABELS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Detection sensitivity
                  <select value={confidence} onChange={(e) => setConfidence(Number(e.target.value))}>
                    {SENSITIVITY.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wizard-check">
                  <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
                  Show detection boxes and labels to viewers
                </label>
                <p className="tiny muted wizard-note">
                  Detects 80 everyday object types in real time. You can add content for more objects later.
                </p>
              </>
            )}

            {error && <div className="auth-error">{error}</div>}
            <div className="wizard-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => setStep(type === 'image_ar' ? 1 : 0)}
                disabled={busy}
              >
                ← Back
              </button>
              <button className="btn primary" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function Choice({ title, blurb, active, onClick }) {
  return (
    <button type="button" className={`wizard-choice ${active ? 'active' : ''}`} onClick={onClick} aria-pressed={active}>
      <span className="wizard-choice-title">{title}</span>
      <span className="wizard-choice-blurb">{blurb}</span>
    </button>
  )
}
