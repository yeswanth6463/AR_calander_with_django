import * as THREE from 'three'

const waitFor = (element, event, errorEvent, message) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      element.removeEventListener(event, onLoad)
      element.removeEventListener(errorEvent, onError)
    }
    const onLoad = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(message))
    }
    element.addEventListener(event, onLoad, { once: true })
    element.addEventListener(errorEvent, onError, { once: true })
  })

const STILL_IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'webp']

export async function createMediaPanel(url, format) {
  if (STILL_IMAGE_FORMATS.includes(format)) return createImagePanel(url)
  const isGif = format === 'gif'
  let source
  let canvas
  let updateTexture
  let disposeSource

  if (isGif) {
    source = new Image()
    source.crossOrigin = 'anonymous'
    const loaded = waitFor(source, 'load', 'error', 'Could not load GIF')
    source.src = url
    await loaded
    canvas = document.createElement('canvas')
    canvas.width = source.naturalWidth
    canvas.height = source.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create GIF texture')
    updateTexture = () => context.drawImage(source, 0, 0, canvas.width, canvas.height)
    updateTexture()
    disposeSource = () => {
      source.src = ''
    }
  } else {
    source = document.createElement('video')
    source.crossOrigin = 'anonymous'
    source.muted = true
    source.loop = true
    source.playsInline = true
    source.preload = 'auto'
    const loaded = waitFor(source, 'loadeddata', 'error', 'Could not load video')
    source.src = url
    source.load()
    await loaded
    await source.play()
    disposeSource = () => {
      source.pause()
      source.removeAttribute('src')
      source.load()
    }
  }

  const texture = isGif
    ? new THREE.CanvasTexture(canvas)
    : new THREE.VideoTexture(source)
  texture.colorSpace = THREE.SRGBColorSpace
  const width = isGif ? canvas.width : source.videoWidth
  const height = isGif ? canvas.height : source.videoHeight
  const aspect = width && height ? width / height : 16 / 9
  const geometry = new THREE.PlaneGeometry(0.5, 0.5 / aspect)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geometry, material)

  return {
    mesh,
    update: () => {
      if (isGif) {
        updateTexture()
        texture.needsUpdate = true
      }
    },
    dispose: () => {
      disposeSource()
      geometry.dispose()
      material.dispose()
      texture.dispose()
    },
  }
}

async function createImagePanel(url) {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  const loaded = waitFor(image, 'load', 'error', 'Could not load image')
  image.src = url
  await loaded
  const texture = new THREE.Texture(image)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  const aspect = image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1
  const geometry = new THREE.PlaneGeometry(0.5, 0.5 / aspect)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    transparent: true, // PNG / WebP cut-outs
    alphaTest: 0.02,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  return {
    mesh,
    update: () => {},
    dispose: () => {
      geometry.dispose()
      material.dispose()
      texture.dispose()
    },
  }
}
