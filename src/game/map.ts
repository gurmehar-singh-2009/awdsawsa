import { Mat } from '../render/scene'

/**
 * Deterministic map generator for "Skyhold": four floating team islands, each with a
 * walled keep and a tower crowned by the team's Core, linked to a central fort by
 * destructible brick bridges. Every peer builds the exact same brick list from code,
 * so the map never has to be sent over the network.
 */

export const BF = {
  Root: 1, // anchored to the world (supports other bricks)
  Solid: 2, // indestructible
  Core: 4,
} as const

export interface BrickDef {
  x: number; y: number; z: number // centre
  sx: number; sy: number; sz: number // full size (always axis-aligned)
  r: number; g: number; b: number
  mat: number
  flags: number
  team: number
}

export interface TeamDef {
  name: string
  color: number[]
  island: { x: number; z: number }
  spawn: { x: number; y: number; z: number; yaw: number }
  coreBrick: number
  flag: { x: number; y: number; z: number; yaw: number }
}

export const TEAM_INFO = [
  { name: 'Red', color: [0.82, 0.17, 0.15] },
  { name: 'Blue', color: [0.13, 0.4, 0.86] },
  { name: 'Green', color: [0.2, 0.64, 0.27] },
  { name: 'Yellow', color: [0.96, 0.78, 0.15] },
]

export const ISLAND_DIST = 84
const TEAM_ISLAND_HALF = 20
const CENTER_HALF = 26

export interface GameMap {
  bricks: BrickDef[]
  teams: TeamDef[]
  /** bricks below this height are deleted (fell into the void) */
  voidY: number
}

type Gap = [number, number] // interval along a run that stays open

class Builder {
  bricks: BrickDef[] = []

  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, c: number[], mat: number = Mat.Studs, flags = 0, team = -1) {
    this.bricks.push({ x, y, z, sx, sy, sz, r: c[0], g: c[1], b: c[2], mat, flags, team })
    return this.bricks.length - 1
  }

  /**
   * A straight one-brick-thick run along X (axis 0) or Z (axis 2) between a and b,
   * at layer `ly` (bottom y), with running-bond offsets and open gaps.
   */
  run(axis: 0 | 2, a: number, b: number, fixed: number, ly: number, c: number[], gaps: Gap[] = [], h = 1, th = 1) {
    // subtract gaps
    let parts: Gap[] = [[a, b]]
    for (const [g0, g1] of gaps) {
      const next: Gap[] = []
      for (const [p0, p1] of parts) {
        if (g1 <= p0 || g0 >= p1) { next.push([p0, p1]); continue }
        if (g0 > p0) next.push([p0, g0])
        if (g1 < p1) next.push([g1, p1])
      }
      parts = next
    }
    for (const [p0, p1] of parts) {
      let s = p0
      let first = (Math.round(ly) & 1) === 1 ? 2 : 4
      while (s < p1 - 1e-6) {
        let len = Math.min(first, p1 - s)
        first = 4
        // avoid slivers: merge a tiny remainder into this brick
        if (p1 - (s + len) > 0 && p1 - (s + len) < 1) len = p1 - s
        const m = s + len / 2
        if (axis === 0) this.add(m, ly + h / 2, fixed, len, h, th, c)
        else this.add(fixed, ly + h / 2, m, th, h, len, c)
        s += len
      }
    }
  }

  /** Square ring wall with interlocking corners. gaps keyed by side: 'n','s','e','w' (world coords along that side). */
  ring(cx: number, cz: number, half: number, ly0: number, layers: number, color: (ly: number) => number[], gapsFor: (side: string, ly: number) => Gap[] = () => []) {
    const x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half
    for (let l = 0; l < layers; l++) {
      const ly = ly0 + l, c = color(l)
      const full = (l & 1) === 0
      // north (z0) / south (z1) walls run along X
      const xa = full ? x0 : x0 + 1, xb = full ? x1 : x1 - 1
      this.run(0, xa, xb, z0 + 0.5, ly, c, gapsFor('n', l))
      this.run(0, xa, xb, z1 - 0.5, ly, c, gapsFor('s', l))
      const za = full ? z0 + 1 : z0, zb = full ? z1 - 1 : z1
      this.run(2, za, zb, x0 + 0.5, ly, c, gapsFor('w', l))
      this.run(2, za, zb, x1 - 0.5, ly, c, gapsFor('e', l))
    }
  }

  /** Crenellations along the top of a square ring (N/S own the corners, so nothing overlaps). */
  crenels(cx: number, cz: number, half: number, ly: number, c: number[], skip?: (x: number, z: number) => boolean) {
    for (let t = -half; t + 2 <= half; t += 4) {
      for (const z of [cz - half + 0.5, cz + half - 0.5]) {
        const x = cx + t + 1
        if (!skip?.(x, z)) this.add(x, ly + 0.5, z, 2, 1, 1, c)
      }
    }
    for (let t = -half + 2; t + 2 <= half - 1; t += 4) {
      for (const x of [cx - half + 0.5, cx + half - 0.5]) {
        const z = cz + t + 1
        if (!skip?.(x, z)) this.add(x, ly + 0.5, z, 1, 1, 2, c)
      }
    }
  }

  /** Floating island made of tapered indestructible rock slabs. Top surface at y = 0. */
  island(cx: number, cz: number, half: number) {
    const rock = [0.5, 0.43, 0.36]
    this.add(cx, -1.5, cz, half * 2, 3, half * 2, rock, Mat.Rock, BF.Root | BF.Solid)
    this.add(cx, -5.5, cz, half * 1.6, 5, half * 1.6, rock, Mat.Rock, BF.Root | BF.Solid)
    this.add(cx, -11, cz, half * 1.1, 6, half * 1.1, [0.44, 0.38, 0.33], Mat.Rock, BF.Root | BF.Solid)
    this.add(cx, -16.5, cz, half * 0.55, 5, half * 0.55, [0.4, 0.35, 0.31], Mat.Rock, BF.Root | BF.Solid)
  }

  /**
   * Spiral steps cantilevered off the outside of a square tower.
   * Each side has (side/2) steps of 2 plus a 3x3 corner landing; every step rises 1.
   * Returns the position of the final step.
   */
  stairs(cx: number, cz: number, half: number, count: number, startSide: number, c: number[]) {
    const out = 3
    let last = { x: cx, z: cz, side: 0 }
    let n = 0
    for (let side = startSide; n < count; side = (side + 1) % 4) {
      // walk along a side, then the corner
      for (let k = 0; k < half && n < count; k++, n++) {
        const t = -half + 1 + k * 2
        let x = 0, z = 0, sx = 2, sz = 2
        if (side === 0) { x = cx + t; z = cz + half + out / 2; sz = out }
        else if (side === 1) { x = cx + half + out / 2; z = cz - t; sx = out }
        else if (side === 2) { x = cx - t; z = cz - half - out / 2; sz = out }
        else { x = cx - half - out / 2; z = cz + t; sx = out }
        this.add(x, n + 0.5, z, sx, 1, sz, c)
        last = { x, z, side }
      }
      if (n >= count) break
      // corner landing
      const h = half + out / 2
      const corners = [[h, h], [h, -h], [-h, -h], [-h, h]]
      const [ox, oz] = corners[side]
      this.add(cx + ox, n + 0.5, cz + oz, out, 1, out, c)
      last = { x: cx + ox, z: cz + oz, side }
      n++
    }
    return last
  }
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t)
const GRAY = [0.62, 0.63, 0.64]
const STONE = [0.45, 0.46, 0.5]
const WOOD = [0.62, 0.44, 0.27]

export function buildMap(): GameMap {
  const B = new Builder()
  const teams: TeamDef[] = []

  // ---------------------------------------------------------- centre fort
  B.island(0, 0, CENTER_HALF)
  const fortHalf = 11
  const gate: Gap = [-3, 3]
  B.ring(0, 0, fortHalf, 0, 4, l => (l === 3 ? STONE : GRAY), (_s, l) => (l < 3 ? [gate] : []))
  B.crenels(0, 0, fortHalf, 4, STONE, (x, z) => Math.abs(x) < 4 || Math.abs(z) < 4)
  // centre tower with outside stairs and a lookout roof
  const ctHalf = 3, ctH = 13
  B.ring(0, 0, ctHalf, 0, ctH, l => (l % 4 === 3 ? STONE : GRAY))
  B.add(0, ctH - 0.5, 0, 4, 1, 4, STONE)
  const cLast = B.stairs(0, 0, ctHalf, ctH, 0, WOOD)
  B.crenels(0, 0, ctHalf, ctH, STONE, (x, z) => Math.hypot(x - cLast.x, z - cLast.z) < 4.5)
  // a few cover walls in the courtyard ring between fort and island edge
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4
    const x = Math.round(Math.cos(a) * 18), z = Math.round(Math.sin(a) * 18)
    for (let l = 0; l < 3; l++) B.run(i & 1 ? 2 : 0, (i & 1 ? z : x) - 4, (i & 1 ? z : x) + 4, i & 1 ? x : z, l, l === 2 ? STONE : GRAY)
  }

  // ---------------------------------------------------------- team islands
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  TEAM_INFO.forEach((info, t) => {
    const [dx, dz] = dirs[t]
    const ix = dx * ISLAND_DIST, iz = dz * ISLAND_DIST
    B.island(ix, iz, TEAM_ISLAND_HALF)
    const tc = info.color
    const wallC = mix(tc, GRAY, 0.45), darkC = mix(tc, [0.1, 0.1, 0.1], 0.35)

    // outer wall, gate faces the centre
    const half = 13
    const gateSide = dx > 0 ? 'w' : dx < 0 ? 'e' : dz > 0 ? 'n' : 's'
    const gateAt = gateSide === 'w' || gateSide === 'e' ? iz : ix
    B.ring(ix, iz, half, 0, 5, l => (l === 4 ? darkC : wallC), (s, l) => (s === gateSide && l < 4 ? [[gateAt - 3, gateAt + 3]] : []))
    B.crenels(ix, iz, half, 5, darkC, (x, z) => {
      if (gateSide === 'w' || gateSide === 'e') return Math.abs(z - iz) < 4 && Math.abs(Math.abs(x - ix) - half) < 2
      return Math.abs(x - ix) < 4 && Math.abs(Math.abs(z - iz) - half) < 2
    })

    // tower + stairs + roof + core
    const th = 5, tH = 22
    B.ring(ix, iz, th, 0, tH, l => (l % 6 === 5 ? darkC : tc))
    for (let a = -1; a <= 1; a += 2) for (let b = -3; b <= 3; b += 2) B.add(ix + a * 2, tH - 0.5, iz + b, 4, 1, 2, darkC)
    // stairs start on the side facing the gate so players walk straight onto them
    const startSide = gateSide === 's' ? 0 : gateSide === 'e' ? 1 : gateSide === 'n' ? 2 : 3
    const last = B.stairs(ix, iz, th, tH, startSide, STONE)
    B.crenels(ix, iz, th, tH, darkC, (x, z) => Math.hypot(x - last.x, z - last.z) < 5)
    const coreBrick = B.add(ix, tH + 1, iz, 2, 2, 2, tc, Mat.Glow, BF.Core, t)

    // spawn just inside the gate
    const sx = ix - dx * 9.5, sz = iz - dz * 9.5
    const yaw = Math.atan2(dx, dz) // looking towards the centre island
    teams.push({
      name: info.name,
      color: tc,
      island: { x: ix, z: iz },
      spawn: { x: sx, y: 0.1, z: sz, yaw: yaw },
      coreBrick,
      flag: { x: ix - dx * 16 + dz * 6, y: 0, z: iz - dz * 16 + dx * 6, yaw },
    })

    // bridge from the team island to the centre island, 4 wide, planks of 2
    const from = CENTER_HALF, to = ISLAND_DIST - TEAM_ISLAND_HALF
    for (let r = from, k = 0; r < to - 1e-6; r += 2, k++) {
      const c = k & 1 ? WOOD : mix(WOOD, [0.3, 0.2, 0.1], 0.25)
      const m = r + 1
      if (dx !== 0) B.add(dx * m, -0.5, 0, 2, 1, 4, c)
      else B.add(0, -0.5, dz * m, 4, 1, 2, c)
    }
  })

  return { bricks: B.bricks, teams, voidY: -70 }
}
