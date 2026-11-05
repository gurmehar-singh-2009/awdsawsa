import { defineConfig, type Plugin } from 'vite'

/**
 * @dimforge/rapier3d-compat inlines its 3 MB WebAssembly binary as a 4 MB base64
 * string. This swaps that string for a streamed fetch of the real .wasm file
 * (exposed by src/physics-wasm.ts), which is ~30% smaller over the wire and can be
 * compiled while it downloads.
 */
function rapierStreamingWasm(): Plugin {
  return {
    name: 'rapier-streaming-wasm',
    enforce: 'pre',
    transform(code, id) {
      if (!/rapier3d-compat[\\/]dist[\\/]rapier\.mjs$/.test(id)) return
      const re = /[A-Za-z_$][\w$]*\.toByteArray\("AGFzbQ[^"]*"\)\.buffer/
      if (!re.test(code)) {
        this.warn('rapier base64 wasm not found; leaving it inlined')
        return
      }
      return { code: code.replace(re, 'fetch(globalThis.__RAPIER_WASM__)'), map: null }
    },
  }
}

// Relative base so the build works from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  plugins: [rapierStreamingWasm()],
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
})
