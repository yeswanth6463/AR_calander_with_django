import { useEffect, useRef, useState } from 'react'
import { createFaceStage } from '../ar/faceStage'
import { createObjectStage } from '../ar/objectStage'

/**
 * Live camera + face tracking / object detection with items attached.
 *
 * props:
 *   mode       'face' | 'object'
 *   items      normalised items ({ id, anchor, model: { url, format }, transform })
 *   settings   project type_settings
 *   onStatus(text), onTracking(bool)   optional callbacks
 */
export default function TrackingStage({ mode, items, settings, markers, onStatus, onTracking, onReady, className = '' }) {
  const hostRef = useRef(null)
  const stageRef = useRef(null)
  const itemsRef = useRef(items)
  const callbacks = useRef({ onStatus, onTracking, onReady })
  const markersRef = useRef(markers)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('starting…')

  useEffect(() => {
    callbacks.current = { onStatus, onTracking, onReady }
  }, [onStatus, onTracking, onReady])

  const occlusion = !!settings?.occlusion
  const minConfidence = settings?.min_confidence ?? 0.5
  const showLabels = settings?.show_labels ?? true

  useEffect(() => {
    let disposed = false
    let stage = null
    const host = hostRef.current
    const report = (text) => {
      if (disposed) return
      setStatus(text)
      callbacks.current.onStatus?.(text)
    }
    const create =
      mode === 'face'
        ? createFaceStage(host, {
            occlusion,
            markers: markersRef.current,
            onStatus: report,
            onFaceChange: (found) => !disposed && callbacks.current.onTracking?.(found),
          })
        : createObjectStage(host, {
            minConfidence,
            showLabels,
            onStatus: report,
            onDetections: (list) => {
              if (disposed) return
              const watched = new Set(itemsRef.current.map((i) => i.anchor?.value))
              callbacks.current.onTracking?.(list.some((d) => watched.has(d.label)))
            },
          })
    create
      .then((s) => {
        if (disposed) return s.dispose()
        stage = s
        stageRef.current = s
        s.setItems(itemsRef.current)
        callbacks.current.onReady?.(s)
      })
      .catch((err) => {
        if (!disposed) setError(err?.message || String(err))
      })
    return () => {
      disposed = true
      stageRef.current = null
      callbacks.current.onReady?.(null)
      stage?.dispose()
    }
  }, [mode, occlusion, minConfidence, showLabels])

  useEffect(() => {
    itemsRef.current = items
    stageRef.current?.setItems(items)
  }, [items])

  useEffect(() => {
    markersRef.current = markers
    stageRef.current?.setMarkers?.(markers)
  }, [markers])

  return (
    <div ref={hostRef} className={`camstage ${className}`}>
      {error ? (
        <div className="camstage-msg error">⚠️ {error}</div>
      ) : (
        status !== 'ready' && <div className="camstage-msg">{status}</div>
      )}
    </div>
  )
}
