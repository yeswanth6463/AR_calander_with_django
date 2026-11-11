/**
 * One place to build GLTFLoaders, so every viewer can read models written by
 * the AR model optimiser (src/ar/modelOptimizer.js):
 *   EXT_meshopt_compression / KHR_mesh_quantization → Meshopt decoder (bundled, ~10 KB)
 *   EXT_texture_webp                              → native in three.js
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

export function createGltfLoader() {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  return loader
}
