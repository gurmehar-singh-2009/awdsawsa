// Headless physics check: build the world, blast a tower base, simulate, report timings.
import RAPIER from '@dimforge/rapier3d-compat'
import { buildMap } from '../src/game/map.ts'
import { World } from '../src/game/world.ts'
await RAPIER.init()
const map = buildMap()
let t0 = performance.now()
const w = new World(map, true)
console.log('build ms', (performance.now() - t0).toFixed(1), 'bricks', w.n)
const hiddenFaces = Array.from(w.hidden).reduce((a, m) => a + popcount(m), 0)
console.log('hidden faces', hiddenFaces, 'of', w.n * 6)
// support check on an intact map must not drop anything
console.log('dropped on intact map', w.checkSupport().length)
// blast the base of the red tower (island at +84, 0)
t0 = performance.now()
const rel = w.explode(84 + 5, 1, 0, 6, 40)
console.log('explode released', rel.length, 'ms', (performance.now() - t0).toFixed(2))
let worst = 0, total = 0
for (let s = 0; s < 600; s++) {
  const a = performance.now()
  w.phys.step()
  const moved: number[] = [], removed: number[] = []
  w.syncFromPhysics(moved, removed)
  const dt = performance.now() - a
  total += dt; worst = Math.max(worst, dt)
  if (s % 120 === 0) console.log('step', s, 'moving', moved.length, 'released', w.released.length, 'ms', dt.toFixed(2))
}
console.log('avg step ms', (total / 600).toFixed(2), 'worst', worst.toFixed(2))
console.log('red core lost?', w.coreLost(map.teams[0].coreBrick))
// blast bridge midpoint and make sure only nearby planks fall
const before = w.released.length
w.explode(45, -0.5, 0, 3, 30)
console.log('bridge blast released', w.released.length - before)
function popcount(m: number) { let c = 0; while (m) { c += m & 1; m >>= 1 } return c }
