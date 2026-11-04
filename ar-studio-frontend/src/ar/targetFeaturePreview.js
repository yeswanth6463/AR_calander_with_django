/**
 * Target Feature Points Preview Utilities.
 * Renders high-contrast grayscale targets with rich red feature circles (OpenCV ORB / Vuforia style)
 * for AR tracking quality assessment and in-viewport visualization.
 */

export function calculateTrackingQuality(featureCount = 0) {
  if (featureCount >= 500) {
    return {
      stars: 5,
      rating: 5,
      label: 'Optimal for Tracking',
      color: '#22c55e',
      bg: 'rgba(34, 197, 94, 0.15)',
      description: 'Outstanding visual feature density and distribution. Provides rock-solid AR tracking.',
    }
  }
  if (featureCount >= 300) {
    return {
      stars: 4,
      rating: 4,
      label: 'Good Tracking Stability',
      color: '#84cc16',
      bg: 'rgba(132, 204, 22, 0.15)',
      description: 'Good feature distribution across the image plane. Ideal for stable, shake-free tracking.',
    }
  }
  if (featureCount >= 150) {
    return {
      stars: 3,
      rating: 3,
      label: 'Moderate Tracking',
      color: '#eab308',
      bg: 'rgba(234, 179, 8, 0.15)',
      description: 'Adequate feature points. Keep camera within 1–2 meters for best detection reliability.',
    }
  }
  if (featureCount >= 50) {
    return {
      stars: 2,
      rating: 2,
      label: 'Weak Feature Count',
      color: '#f97316',
      bg: 'rgba(249, 115, 22, 0.15)',
      description: 'Few visual corners detected. AR tracking may slip; high-contrast imagery is recommended.',
    }
  }
  return {
    stars: 1,
    rating: 1,
    label: 'Poor Tracking Image',
    color: '#ef4444',
    bg: 'rgba(239, 68, 68, 0.15)',
    description: 'Insufficient visual texture. Use an image with text, sharp borders, or rich patterns.',
  }
}

/**
 * Draws image onto target canvas in grayscale with red feature point circles.
 */
export function drawFeaturePreview(
  canvas,
  img,
  keypoints = [],
  {
    grayscale = true,
    showFeatures = true,
    circleScale = 1.0,
    strokeColor = '#ff2222',
  } = {}
) {
  if (!canvas || !img) return
  const w = img.naturalWidth || img.videoWidth || img.width || canvas.width
  const h = img.naturalHeight || img.videoHeight || img.height || canvas.height
  if (!w || !h) return

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return

  // 1. Draw base image
  ctx.drawImage(img, 0, 0, w, h)

  // 2. Grayscale conversion for tracking feature contrast
  if (grayscale) {
    try {
      const imgData = ctx.getImageData(0, 0, w, h)
      const d = imgData.data
      for (let i = 0; i < d.length; i += 4) {
        // Luminance
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        d[i] = g
        d[i + 1] = g
        d[i + 2] = g
      }
      ctx.putImageData(imgData, 0, 0)
    } catch {
      // Fallback filter if getImageData blocked by CORS
      ctx.filter = 'grayscale(100%) contrast(108%)'
      ctx.drawImage(img, 0, 0, w, h)
      ctx.filter = 'none'
    }
  }

  // 3. Draw Red Feature Circles
  if (showFeatures && Array.isArray(keypoints) && keypoints.length > 0) {
    ctx.save()
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = Math.max(1.5, Math.round(w / 700))

    const count = keypoints.length
    for (let i = 0; i < count; i++) {
      const kp = keypoints[i]
      const x = typeof kp.x === 'number' ? kp.x : kp[0]
      const y = typeof kp.y === 'number' ? kp.y : kp[1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue

      let size = kp.size
      if (!size || size < 4) {
        // Deterministic multi-scale variation for raw [x, y] points (8px to 32px diameter)
        const pseudo = Math.abs(Math.sin(x * 12.9898 + y * 78.233))
        size = 8 + pseudo * 24
      }

      const radius = Math.max(3.5, Math.min(36, (size / 2) * circleScale))

      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }
}

