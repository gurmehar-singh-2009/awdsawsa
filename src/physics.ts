import RAPIER from '@dimforge/rapier3d-compat'
// Imported by path because the package's export map hides the .wasm file.
import wasmUrl from '../node_modules/@dimforge/rapier3d-compat/dist/rapier_wasm3d_bg.wasm?url'

/** Load the physics engine (streams + compiles the .wasm; see vite.config.ts). */
export async function initPhysics() {
  ;(globalThis as { __RAPIER_WASM__?: string }).__RAPIER_WASM__ = wasmUrl
  await RAPIER.init()
}
