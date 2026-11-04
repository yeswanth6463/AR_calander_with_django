import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../api'
import { drawFeaturePreview, calculateTrackingQuality } from '../ar/targetFeaturePreview'

const rel = (url) => {
  try {
    return new URL(url, window.location.origin).pathname
  } catch {
    return url
  }
}

export default function TargetFeatureModal({ target, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('features') // 'features' | 'original'
  const [featureData, setFeatureData] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [circleScale, setCircleScale] = useState(1)
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 })

  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const viewportRef = useRef(null)

  // Load target details & rich keypoints
  useEffect(() => {
    if (!target) return
    let alive = true
    setLoading(true)
    setError('')

    const loadTarget = async () => {
      try {
        let details = null
        try {
          details = await api(`/targets/${target.id}/features/`)
        } catch {
          // Fallback to local target data if offline or older backend
          const kps = target.tracking_data?.rich_keypoints || target.tracking_data?.keypoints || []
          details = {
            target_id: target.id,
            name: target.name,
            feature_count: kps.length,
            rich_keypoints: kps,
            width: target.tracking_data?.width || 0,
            height: target.tracking_data?.height || 0,
          }
        }
        if (!alive) return
        setFeatureData(details)

        // Load image element
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          if (!alive) return
          imgRef.current = img
          setLoading(false)
        }
        img.onerror = () => {
          if (!alive) return
          setError('Failed to load target image.')
          setLoading(false)
        }
        img.src = rel(target.image)
      } catch (err) {
        if (!alive) return
        setError(err.message || 'Failed to load target feature points.')
        setLoading(false)
      }
    }

    loadTarget()
    return () => {
      alive = false
    }
  }, [target])

  // Redraw canvas whenever mode, featureData, or circleScale change
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return

    const kps =
      featureData?.rich_keypoints ||
      featureData?.keypoints ||
      target?.tracking_data?.rich_keypoints ||
      target?.tracking_data?.keypoints ||
      []

    drawFeaturePreview(canvas, img, kps, {
      grayscale: mode === 'features',
      showFeatures: mode === 'features',
      circleScale,
      strokeColor: '#ff2222',
    })
  }, [featureData, mode, circleScale, target])

  useEffect(() => {
    if (!loading && imgRef.current) {
      renderCanvas()
    }
  }, [loading, renderCanvas])

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Mouse pan handling
  const handlePointerDown = (e) => {
    if (e.button !== 0) return
    setIsPanning(true)
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    }
  }

  const handlePointerMove = (e) => {
    if (!isPanning) return
    const dx = e.clientX - panStartRef.current.x
    const dy = e.clientY - panStartRef.current.y
    setPan({
      x: panStartRef.current.panX + dx,
      y: panStartRef.current.panY + dy,
    })
  }

  const handlePointerUp = () => {
    setIsPanning(false)
  }

  const handleWheel = (e) => {
    e.preventDefault()
    const delta = e.deltaY < 0 ? 0.15 : -0.15
    setZoom((z) => Math.min(3.5, Math.max(0.4, +(z + delta).toFixed(2))))
  }

  const resetZoom = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const handleDownload = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const a = document.createElement('a')
    a.download = `${target?.name || 'target'}_features.png`
    a.href = canvas.toDataURL('image/png')
    a.click()
  }

  const featureCount =
    featureData?.feature_count ??
    target?.tracking_data?.keypoints?.length ??
    featureData?.rich_keypoints?.length ??
    0

  const quality = calculateTrackingQuality(featureCount)

  return (
    <div className="target-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="target-modal-window" onClick={(e) => e.stopPropagation()}>
        {/* Top Header */}
        <div className="target-modal-header">
          <div className="target-modal-title-wrap">
            <span className="target-modal-tag">AR TARGET FEATURE PREVIEW</span>
            <h2>{target.name}</h2>
          </div>

          <div className="target-modal-header-badges">
            <div
              className="target-quality-pill"
              style={{ background: quality.bg, color: quality.color, borderColor: quality.color }}
            >
              <span className="stars">{'★'.repeat(quality.stars)}{'☆'.repeat(5 - quality.stars)}</span>
              <span className="quality-text">{quality.label}</span>
            </div>

            <div className="target-features-count-chip">
              <span className="count-num">{featureCount.toLocaleString()}</span>
              <span className="count-label">Keypoints</span>
            </div>

            <button
              type="button"
              className="target-modal-close-btn"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close dialog"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="target-modal-toolbar">
          <div className="target-view-mode-toggle">
            <button
              type="button"
              className={`target-mode-btn ${mode === 'features' ? 'active' : ''}`}
              onClick={() => setMode('features')}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
              Feature Points (Grayscale)
            </button>
            <button
              type="button"
              className={`target-mode-btn ${mode === 'original' ? 'active' : ''}`}
              onClick={() => setMode('original')}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
                <path d="M21 15l-5-5L5 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Original Image (Color)
            </button>
          </div>

          <div className="target-modal-toolbar-right">
            {mode === 'features' && (
              <div className="target-scale-slider-wrap" title="Adjust feature circle size">
                <span className="tiny muted">Circle Size:</span>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={circleScale}
                  onChange={(e) => setCircleScale(parseFloat(e.target.value))}
                />
                <span className="slider-val">{Math.round(circleScale * 100)}%</span>
              </div>
            )}

            <div className="target-zoom-controls">
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(1)))}
                title="Zoom Out (-)"
              >
                −
              </button>
              <button
                type="button"
                className="btn ghost small zoom-reset-btn"
                onClick={resetZoom}
                title="Reset zoom & pan"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setZoom((z) => Math.min(3.5, +(z + 0.2).toFixed(1)))}
                title="Zoom In (+)"
              >
                +
              </button>
            </div>

            <button
              type="button"
              className="btn small target-download-btn"
              onClick={handleDownload}
              title="Download feature preview image"
            >
              Download
            </button>
          </div>
        </div>

        {/* Main Canvas Viewport */}
        <div
          ref={viewportRef}
          className={`target-preview-viewport ${isPanning ? 'panning' : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        >
          {loading && (
            <div className="target-modal-loading">
              <div className="target-spinner" />
              <span>Analyzing feature points with OpenCV…</span>
            </div>
          )}

          {error && <div className="target-modal-error">{error}</div>}

          <div
            className="target-canvas-stage"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
            }}
          >
            <canvas ref={canvasRef} className="target-feature-canvas" />
          </div>

          <div className="target-viewport-hint">
            Scroll to zoom · Drag to pan
          </div>
        </div>

        {/* Footer Info & Advice */}
        <div className="target-modal-footer">
          <div className="target-footer-info">
            <span className="info-item">
              <strong>Dimensions:</strong>{' '}
              {featureData?.width && featureData?.height
                ? `${featureData.width} × ${featureData.height} px`
                : 'Auto'}
            </span>
            <span className="info-item">
              <strong>Physical Size:</strong> {target.target_width} m
            </span>
            <span className="info-item">
              <strong>Algorithm:</strong> OpenCV ORB (Oriented FAST and Rotated BRIEF)
            </span>
          </div>

          <p className="target-footer-advice">
            {quality.description}
          </p>
        </div>
      </div>
    </div>
  )
}

