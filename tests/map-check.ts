// Sanity checks for the generated map: brick count and no overlapping bricks.
import { buildMap } from '../src/game/map.ts'
const m = buildMap()
const b = m.bricks
let overlaps = 0
for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
  const A = b[i], B = b[j]
  const ox = (A.sx + B.sx) / 2 - Math.abs(A.x - B.x)
  const oy = (A.sy + B.sy) / 2 - Math.abs(A.y - B.y)
  const oz = (A.sz + B.sz) / 2 - Math.abs(A.z - B.z)
  if (ox > 0.01 && oy > 0.01 && oz > 0.01) { overlaps++; if (overlaps < 8) console.log('overlap', i, j, A, B) }
}
console.log('bricks', b.length, 'overlaps', overlaps, 'teams', m.teams.map(t => t.coreBrick))
if (overlaps) process.exit(1)
