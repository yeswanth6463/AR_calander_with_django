import { useEffect, useRef, useState } from 'react'

export default function UnityGizmoToolbar({
  mode = 'translate',
  onModeChange,
  space = 'world',
  onSpaceChange,
  snapEnabled = false,
  onToggleSnap,
  gizmoSize = 1,
  onSizeChange,
  onReset,
  rectOrientation = 'horizontal',
  onRectOrientationChange,
  // Set false when the host already binds Q/W/E/R/T/Y/X — otherwise X would
  // toggle the space twice per keypress and cancel itself out.
  enableHotkeys = true,
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const cubeBtnRef = useRef(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!menuOpen) return
    const handleClickOutside = (e) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        cubeBtnRef.current &&
        !cubeBtnRef.current.contains(e.target)
      ) {
        setMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', handleClickOutside)
    return () => window.removeEventListener('pointerdown', handleClickOutside)
  }, [menuOpen])

  // Keyboard shortcuts (Q, W, E, R, T, Y, X, Escape)
  useEffect(() => {
    const handleKeyDown = (e) => {
      const activeEl = document.activeElement
      const isInput =
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          activeEl.isContentEditable)
      if (isInput) return
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const key = e.key.toLowerCase()
      if (key === 'escape' && menuOpen) {
        setMenuOpen(false)
        return
      }
      if (!enableHotkeys) return
      if (key === 'q') onModeChange('view')
      else if (key === 'w') onModeChange('translate')
      else if (key === 'e') onModeChange('rotate')
      else if (key === 'r') onModeChange('scale')
      else if (key === 't') onModeChange('rect')
      else if (key === 'y') onModeChange('universal')
      else if (key === 'x') onSpaceChange(space === 'world' ? 'local' : 'world')
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onModeChange, onSpaceChange, space, menuOpen, enableHotkeys])

  const tools = [
    {
      id: 'view',
      label: 'Hand Tool',
      hotkey: 'Q',
      description: 'Pan & orbit view without gizmo',
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
          <path d="M10 1.8a1.2 1.2 0 0 0-1.2 1.2v7.1L7.5 9a1.2 1.2 0 0 0-1.7.2 1.2 1.2 0 0 0 .2 1.7l4.4 4.5c.9.9 1.5 2.1 1.7 3.4H17a3.8 3.8 0 0 0 3.8-3.8V6.8a1.2 1.2 0 0 0-1.2-1.3 1.2 1.2 0 0 0-1.3 1.3v2.2h-.5V3.8a1.2 1.2 0 0 0-1.3-1.3 1.2 1.2 0 0 0-1.2 1.3v4.5h-.5V2a1.2 1.2 0 0 0-1.3-1.2A1.2 1.2 0 0 0 13.2 2v7h-.5V3a1.2 1.2 0 0 0-1.2-1.2H10z" />
        </svg>
      ),
    },
    {
      id: 'translate',
      label: 'Move Tool',
      hotkey: 'W',
      description: 'Translate object with 3 arrows (XYZ)',
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
          <rect x="11" y="5" width="2" height="14" />
          <rect x="5" y="11" width="14" height="2" />
          <polygon points="12,1 8,6 16,6" />
          <polygon points="12,23 8,18 16,18" />
          <polygon points="1,12 6,8 6,16" />
          <polygon points="23,12 18,8 18,16" />
        </svg>
      ),
    },
    {
      id: 'scale',
      label: 'Scale Tool',
      hotkey: 'R',
      description: 'Scale object (drag center cube to scale evenly)',
      icon: (
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
          <rect x="3.5" y="14.5" width="6" height="6" fill="currentColor" stroke="none" />
          <line x1="9.5" y1="14.5" x2="16.5" y2="7.5" />
          <polyline points="12 7.5 16.5 7.5 16.5 12" />
        </svg>
      ),
    },
    {
      id: 'rotate',
      label: 'Rotate Tool',
      hotkey: 'E',
      description: 'Rotate object around axes',
      icon: (
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12a9 9 0 0 0-9-9 9 9 0 0 0-6.4 2.6L3 8" />
          <polyline points="3 3 3 8 8 8" />
          <path d="M3 12a9 9 0 0 0 9 9 9 9 0 0 0 6.4-2.6L21 16" />
          <polyline points="21 21 21 16 16 16" />
        </svg>
      ),
    },
    {
      id: 'rect',
      label: 'Rect Tool',
      hotkey: 'T',
      description: 'Planar transform on image target surface',
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <rect
            x="5.5"
            y="5.5"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <rect x="3.5" y="3.5" width="4.5" height="4.5" fill="currentColor" />
          <rect x="16" y="3.5" width="4.5" height="4.5" fill="currentColor" />
          <rect x="3.5" y="16" width="4.5" height="4.5" fill="currentColor" />
          <rect x="16" y="16" width="4.5" height="4.5" fill="currentColor" />
        </svg>
      ),
    },
    {
      id: 'universal',
      label: 'Transform Tool',
      hotkey: 'Y',
      description: 'Move, rotate & scale at once',
      icon: (
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="7" x2="12" y2="17" strokeWidth="1.6" />
          <line x1="7" y1="12" x2="17" y2="12" strokeWidth="1.6" />
          <polyline points="10 8.5 12 6.5 14 8.5" strokeWidth="1.5" />
          <polyline points="10 15.5 12 17.5 14 15.5" strokeWidth="1.5" />
          <polyline points="8.5 10 6.5 12 8.5 14" strokeWidth="1.5" />
          <polyline points="15.5 10 17.5 12 15.5 14" strokeWidth="1.5" />
          <path d="M8 4.8 A 8.5 8.5 0 0 1 16 4.8" strokeWidth="1.5" />
          <path d="M19.2 8 A 8.5 8.5 0 0 1 19.2 16" strokeWidth="1.5" />
          <path d="M16 19.2 A 8.5 8.5 0 0 1 8 19.2" strokeWidth="1.5" />
          <path d="M4.8 16 A 8.5 8.5 0 0 1 4.8 8" strokeWidth="1.5" />
          <path d="M3 7 L3 3 L7 3" strokeWidth="1.6" />
          <path d="M21 17 L21 21 L17 21" strokeWidth="1.6" />
        </svg>
      ),
    },
  ]

  const activeTool = tools.find((t) => t.id === mode) || tools[1]

  return (
    <div className="unity-gizmo-container">
      <div className="unity-gizmo-bar" role="toolbar" aria-label="Unity Scene Gizmo Tools">
        {/* Top Drag Handle Lines */}
        <div className="unity-drag-grip" title="Unity Scene Tools">
          <span />
          <span />
        </div>

        {/* Cube Settings Toggle Button */}
        <button
          ref={cubeBtnRef}
          type="button"
          className={`unity-cube-toggle ${menuOpen ? 'open' : ''}`}
          onClick={() => setMenuOpen((o) => !o)}
          title={`Tool Settings (${space === 'world' ? 'Global' : 'Local'} space · Click for options)`}
          aria-expanded={menuOpen}
          aria-haspopup="true"
        >
          <svg
            className="unity-cube-icon"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2.5 L19.5 6.8 L19.5 15.4 L12 19.7 L4.5 15.4 L4.5 6.8 Z" />
            <path d="M12 2.5 L12 19.7" />
            <path d="M4.5 6.8 L12 11.1 L19.5 6.8" />
          </svg>
          <svg className="unity-down-arrow" viewBox="0 0 10 6" width="7" height="5" fill="currentColor">
            <path d="M1 1 L5 5 L9 1 Z" />
          </svg>
        </button>

        {/* Vertical Stack of 6 Gizmo Tools */}
        <div className="unity-tools-list">
          {tools.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`unity-tool-btn ${mode === t.id ? 'active' : ''}`}
              onClick={() => onModeChange(t.id)}
              aria-label={`${t.label} (${t.hotkey})`}
              aria-pressed={mode === t.id}
            >
              {t.icon}
              <div className="unity-tool-tooltip">
                <span className="unity-tooltip-title">{t.label}</span>
                <span className="unity-hotkey-badge">{t.hotkey}</span>
              </div>
            </button>
          ))}

          {onReset && (
            <>
              <div className="unity-toolbar-divider" />
              <button
                type="button"
                className="unity-tool-btn unity-reset-tool-btn"
                onClick={() => onReset('all')}
                aria-label="Reset Model Transform"
                title="Reset Model (Position 0, Rotation 0, Scale 1)"
              >
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                <div className="unity-tool-tooltip">
                  <span className="unity-tooltip-title">Reset Model</span>
                  <span className="unity-hotkey-badge">Reset</span>
                </div>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tool Settings Dropdown Popover */}
      {menuOpen && (
        <div ref={menuRef} className="unity-settings-popover" role="dialog" aria-label="Gizmo Tool Settings">
          <div className="unity-popover-header">
            <span>TOOL HANDLE SETTINGS</span>
            <button
              type="button"
              className="unity-popover-close"
              onClick={() => setMenuOpen(false)}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Coordinate Space */}
          <div className="unity-setting-group">
            <div className="unity-setting-label">
              <span>Coordinate Space</span>
              <span className="unity-hotkey-badge">X</span>
            </div>
            <div className="unity-button-toggle">
              <button
                type="button"
                className={space === 'world' ? 'active' : ''}
                onClick={() => onSpaceChange('world')}
              >
                Global
              </button>
              <button
                type="button"
                className={space === 'local' ? 'active' : ''}
                onClick={() => onSpaceChange('local')}
              >
                Local
              </button>
            </div>
          </div>

          {/* Snapping */}
          <div className="unity-setting-group">
            <div className="unity-setting-label">
              <span>Grid Snapping</span>
              <span className="unity-setting-desc">{snapEnabled ? '0.1m · 15°' : 'Off'}</span>
            </div>
            <button
              type="button"
              className={`unity-snap-btn ${snapEnabled ? 'active' : ''}`}
              onClick={onToggleSnap}
            >
              {snapEnabled ? '✓ Snapping Enabled' : 'Enable Snapping'}
            </button>
          </div>

          {/* Gizmo Size */}
          <div className="unity-setting-group">
            <div className="unity-setting-label">
              <span>Gizmo Size</span>
              <span className="unity-setting-desc">{Math.round(gizmoSize * 100)}%</span>
            </div>
            <div className="unity-size-options">
              {[0.75, 1, 1.25].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={gizmoSize === s ? 'active' : ''}
                  onClick={() => onSizeChange(s)}
                >
                  {s === 0.75 ? 'Small' : s === 1 ? 'Normal' : 'Large'}
                </button>
              ))}
            </div>
          </div>

          {/* Rect Plane Orientation */}
          {onRectOrientationChange && (
            <div className="unity-setting-group">
              <div className="unity-setting-label">
                <span>Rect Tool Orientation</span>
                <span className="unity-setting-desc">{rectOrientation === 'vertical' ? 'Vertical' : 'Horizontal'}</span>
              </div>
              <div className="unity-button-toggle">
                <button
                  type="button"
                  className={rectOrientation !== 'vertical' ? 'active' : ''}
                  onClick={() => onRectOrientationChange('horizontal')}
                >
                  Horizontal (Surface)
                </button>
                <button
                  type="button"
                  className={rectOrientation === 'vertical' ? 'active' : ''}
                  onClick={() => onRectOrientationChange('vertical')}
                >
                  Vertical
                </button>
              </div>
            </div>
          )}

          {/* Transform Reset */}
          {onReset && (
            <div className="unity-setting-group unity-reset-group">
              <div className="unity-setting-label">
                <span>Reset Transform</span>
              </div>
              <div className="unity-reset-buttons">
                <button type="button" onClick={() => onReset('all')} title="Reset all model transform properties">
                  Reset All
                </button>
                <button type="button" onClick={() => onReset('pos')} title="Reset position to origin">
                  Position
                </button>
                <button type="button" onClick={() => onReset('rot')} title="Reset rotation to 0°">
                  Rotation
                </button>
                <button type="button" onClick={() => onReset('scale')} title="Reset scale to 1x">
                  Scale
                </button>
              </div>
            </div>
          )}

          <div className="unity-popover-footer">
            <span>Unity Shortcuts: Q, W, E, R, T, Y</span>
          </div>
        </div>
      )}

      {/* Floating Contextual Helper Badge */}
      <div className="unity-context-badge">
        <span className="unity-badge-name">{activeTool.label}</span>
        <span className="unity-badge-desc">{activeTool.description}</span>
        <span className="unity-space-badge" title="Press X to toggle Global / Local">
          {space === 'world' ? 'Global' : 'Local'}
        </span>
      </div>
    </div>
  )
}
