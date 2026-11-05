import RAPIER from '@dimforge/rapier3d-compat'
import { BOX_STRIDE, Mat } from '../render/scene'
import { BF, type BrickDef, type GameMap } from './map'

export const GRAVITY = 60
export const MAX_BUILT = 240

// Rapier interaction groups: (membership << 16) | filter
export const G_BRICK = (0x0001 << 16) | 0xffff
export const G_PLAYER = (0x0002 << 16) | 0x0001
export const G_DEBRIS = (0x0004 << 16) | 0x0001
export const G_RAY = (0x0008 << 16) | 0x0001

// runtime brick flags
export const ALIVE = 1, RELEASED = 2, SOLID = 4, ROOT = 8, CORE = 16, BUILT = 32

export interface RayHit {
  dist: number
  brick: number // -1 if not a brick
  nx: number; ny: number; nz: number
}

/**
 * Owns the Rapier world and the canonical brick state.
 *
 * Bricks start as fixed bodies welded into structures. On the host, explosions
 * "release" bricks (fixed -> dynamic), then a flood fill from the island roots
 * releases anything left without support. Clients never simulate bricks: they mirror
 * the host's snapshots with kinematic bodies and smooth the visuals in between.
 */
export class World {
  phys!: RAPIER.World
  readonly cap: number
  readonly n: number
  inst: Float32Array
  half: Float32Array
  home: Float32Array
  flags: Uint8Array
  team: Int8Array
  hidden: Uint8Array
  bodies: (RAPIER.RigidBody | null)[]
  nbr: number[][]
  colliderBrick = new Map<number, number>()
  released: number[] = []
  awake: Uint8Array
  target: Float32Array
  smoothing = new Set<number>()
  dirtyMin = Infinity
  dirtyMax = 0
  builtNext = 0
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })

  constructor(public map: GameMap, public isHost: boolean) {
    this.n = map.bricks.length
    this.cap = this.n + MAX_BUILT
    this.inst = new Float32Array(this.cap * BOX_STRIDE)
    this.half = new Float32Array(this.cap * 3)
    this.home = new Float32Array(this.cap * 3)
    this.flags = new Uint8Array(this.cap)
    this.team = new Int8Array(this.cap).fill(-1)
    this.hidden = new Uint8Array(this.cap)
    this.bodies = new Array(this.cap).fill(null)
    this.nbr = Array.from({ length: this.cap }, () => [])
    this.awake = new Uint8Array(this.cap)
    this.target = new Float32Array(this.cap * 7)
    this.reset()
  }

  /** (Re)build the whole world from the map definition. */
  reset() {
    if (this.phys) this.phys.free()
    this.phys = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 })
    this.phys.timestep = 1 / 60
    this.colliderBrick.clear()
    this.released = []
    this.smoothing.clear()
    this.inst.fill(0)
    this.flags.fill(0)
    this.hidden.fill(0)
    this.awake.fill(0)
    this.team.fill(-1)
    this.bodies.fill(null)
    for (const a of this.nbr) a.length = 0
    this.builtNext = 0
    this.map.bricks.forEach((b, i) => this.spawnBrick(i, b))
    this.computeAdjacency()
    this.computeHidden()
    // the first step builds the broad-phase for ~2k colliders (~50 ms): pay it during loading
    this.phys.step()
    this.dirtyMin = 0
    this.dirtyMax = this.cap
  }

  private spawnBrick(i: number, b: BrickDef) {
    const o = i * BOX_STRIDE, d = this.inst
    d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.z
    d[o + 3] = 0; d[o + 4] = 0; d[o + 5] = 0; d[o + 6] = 1
    d[o + 7] = b.sx; d[o + 8] = b.sy; d[o + 9] = b.sz
    d[o + 10] = b.r; d[o + 11] = b.g; d[o + 12] = b.b
    d[o + 13] = b.mat; d[o + 14] = 1; d[o + 15] = i
    this.half[i * 3] = b.sx / 2; this.half[i * 3 + 1] = b.sy / 2; this.half[i * 3 + 2] = b.sz / 2
    this.home[i * 3] = b.x; this.home[i * 3 + 1] = b.y; this.home[i * 3 + 2] = b.z
    let f = ALIVE
    if (b.flags & BF.Root) f |= ROOT
    if (b.flags & BF.Solid) f |= SOLID
    if (b.flags & BF.Core) f |= CORE
    this.flags[i] = f
    this.team[i] = b.team
    const body = this.phys.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.x, b.y, b.z))
    const s = 0.02
    const col = this.phys.createCollider(
      RAPIER.ColliderDesc.cuboid(b.sx / 2 - s, b.sy / 2 - s, b.sz / 2 - s)
        .setFriction(0.8).setRestitution(0.05).setDensity(1).setCollisionGroups(G_BRICK),
      body,
    )
    this.colliderBrick.set(col.handle, i)
    this.bodies[i] = body
    this.markDirty(i)
  }

  markDirty(i: number) {
    if (i < this.dirtyMin) this.dirtyMin = i
    if (i + 1 > this.dirtyMax) this.dirtyMax = i + 1
  }

  clearDirty() {
    this.dirtyMin = Infinity
    this.dirtyMax = 0
  }

  /** Bricks touching (faces or edges) are welded together. */
  private computeAdjacency() {
    const grid = this.grid()
    const eps = 0.06
    for (let i = 0; i < this.n; i++) {
      if (!(this.flags[i] & ALIVE)) continue
      const seen = new Set<number>()
      this.forCells(i, eps, key => {
        const cell = grid.get(key)
        if (!cell) return
        for (const j of cell) {
          if (j <= i || seen.has(j)) continue
          seen.add(j)
          if (this.touching(i, j, eps)) {
            this.nbr[i].push(j)
            this.nbr[j].push(i)
          }
        }
      })
    }
  }

  private touching(i: number, j: number, eps: number) {
    const a = i * BOX_STRIDE, b = j * BOX_STRIDE, d = this.inst, h = this.half
    return (
      Math.abs(d[a] - d[b]) <= h[i * 3] + h[j * 3] + eps &&
      Math.abs(d[a + 1] - d[b + 1]) <= h[i * 3 + 1] + h[j * 3 + 1] + eps &&
      Math.abs(d[a + 2] - d[b + 2]) <= h[i * 3 + 2] + h[j * 3 + 2] + eps
    )
  }

  private static CELL = 4
  private cellKey(x: number, y: number, z: number) {
    return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512)
  }
  private forCells(i: number, pad: number, fn: (key: number) => void) {
    const C = World.CELL, o = i * BOX_STRIDE, d = this.inst
    const x0 = Math.floor((d[o] - this.half[i * 3] - pad) / C), x1 = Math.floor((d[o] + this.half[i * 3] + pad) / C)
    const y0 = Math.floor((d[o + 1] - this.half[i * 3 + 1] - pad) / C), y1 = Math.floor((d[o + 1] + this.half[i * 3 + 1] + pad) / C)
    const z0 = Math.floor((d[o + 2] - this.half[i * 3 + 2] - pad) / C), z1 = Math.floor((d[o + 2] + this.half[i * 3 + 2] + pad) / C)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) fn(this.cellKey(x, y, z))
  }
  private grid() {
    const g = new Map<number, number[]>()
    for (let i = 0; i < this.n; i++) {
      if (!(this.flags[i] & ALIVE)) continue
      this.forCells(i, 0, k => {
        let c = g.get(k)
        if (!c) g.set(k, (c = []))
        c.push(i)
      })
    }
    return g
  }

  /**
   * For the CPU renderer: mark faces that are completely covered by neighbouring
   * bricks (sampled at the centre and four inset corners).
   */
  private computeHidden() {
    const grid = this.grid(), C = World.CELL, d = this.inst, h = this.half
    const inside = (x: number, y: number, z: number, self: number) => {
      const cell = grid.get(this.cellKey(Math.floor(x / C), Math.floor(y / C), Math.floor(z / C)))
      if (!cell) return false
      for (const j of cell) {
        if (j === self) continue
        const o = j * BOX_STRIDE
        if (Math.abs(x - d[o]) < h[j * 3] && Math.abs(y - d[o + 1]) < h[j * 3 + 1] && Math.abs(z - d[o + 2]) < h[j * 3 + 2]) return true
      }
      return false
    }
    const p = [0, 0, 0]
    for (let i = 0; i < this.n; i++) {
      const o = i * BOX_STRIDE
      let mask = 0
      for (let f = 0; f < 6; f++) {
        const ax = f >> 1, sgn = f & 1 ? -1 : 1
        const u = (ax + 1) % 3, v = (ax + 2) % 3
        let all = true
        for (let s = 0; s < 5 && all; s++) {
          const su = s === 0 ? 0 : s & 1 ? 1 : -1
          const sv = s === 0 ? 0 : s & 2 ? 1 : -1
          p[ax] = d[o + ax] + sgn * (h[i * 3 + ax] + 0.05)
          p[u] = d[o + u] + su * (h[i * 3 + u] - 0.1)
          p[v] = d[o + v] + sv * (h[i * 3 + v] - 0.1)
          all = inside(p[0], p[1], p[2], i)
        }
        if (all) mask |= 1 << f
      }
      this.hidden[i] = mask
    }
  }

  /** Density 1: mass = volume. (Rapier's mass() can lag a body-type change by a step.) */
  mass(i: number) {
    return 8 * this.half[i * 3] * this.half[i * 3 + 1] * this.half[i * 3 + 2]
  }

  isAlive(i: number) {
    return (this.flags[i] & ALIVE) !== 0
  }

  /** Detach a brick from its structure. Host: becomes dynamic. Client: kinematic mirror. */
  release(i: number) {
    const f = this.flags[i]
    if (!(f & ALIVE) || f & (RELEASED | SOLID)) return false
    this.flags[i] = f | RELEASED
    const body = this.bodies[i]!
    body.setBodyType(this.isHost ? RAPIER.RigidBodyType.Dynamic : RAPIER.RigidBodyType.KinematicPositionBased, true)
    this.released.push(i)
    this.awake[i] = 1
    this.hidden[i] = 0
    for (const j of this.nbr[i]) this.hidden[j] = 0
    return true
  }

  /** Host: blast bricks within radius, then drop anything left unsupported. Returns released ids. */
  explode(x: number, y: number, z: number, radius: number, power: number) {
    const out: number[] = []
    const d = this.inst
    for (let i = 0; i < this.cap; i++) {
      const f = this.flags[i]
      if (!(f & ALIVE) || f & SOLID) continue
      const o = i * BOX_STRIDE
      const dx = d[o] - x, dy = d[o + 1] - y, dz = d[o + 2] - z
      const r = radius + Math.max(this.half[i * 3], this.half[i * 3 + 1], this.half[i * 3 + 2]) * 0.6
      const dist2 = dx * dx + dy * dy + dz * dz
      if (dist2 > r * r) continue
      if (!(f & RELEASED)) this.release(i)
      const body = this.bodies[i]
      if (!body || !this.isHost) continue
      const dist = Math.sqrt(dist2) || 0.01
      const fall = 1 - Math.min(1, dist / r)
      const mass = this.mass(i)
      const k = (power * mass * (0.35 + fall)) / dist
      body.applyImpulse({ x: dx * k, y: dy * k + power * mass * 0.25 * fall, z: dz * k }, true)
      body.applyTorqueImpulse({ x: (Math.random() - 0.5) * k, y: (Math.random() - 0.5) * k, z: (Math.random() - 0.5) * k }, true)
      out.push(i)
    }
    out.push(...this.checkSupport())
    return out
  }

  /** Host: flood fill from roots across welded bricks; release everything unreachable. */
  checkSupport() {
    const seen = new Uint8Array(this.cap)
    const stack: number[] = []
    for (let i = 0; i < this.cap; i++) {
      const f = this.flags[i]
      if (f & ALIVE && f & ROOT && !(f & RELEASED)) { seen[i] = 1; stack.push(i) }
    }
    while (stack.length) {
      const i = stack.pop()!
      for (const j of this.nbr[i]) {
        if (seen[j]) continue
        const f = this.flags[j]
        if (!(f & ALIVE) || f & RELEASED) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    const dropped: number[] = []
    for (let i = 0; i < this.cap; i++) {
      const f = this.flags[i]
      if (f & ALIVE && !(f & RELEASED) && !seen[i]) {
        this.release(i)
        dropped.push(i)
      }
    }
    return dropped
  }

  /**
   * Host: copy awake dynamic bodies into render data. Returns ids that moved
   * (including ones that just fell asleep, so clients get the final resting pose)
   * and ids that fell into the void and were deleted.
   */
  syncFromPhysics(moved: number[], removed: number[]) {
    const d = this.inst
    for (let k = this.released.length - 1; k >= 0; k--) {
      const i = this.released[k]
      const body = this.bodies[i]
      if (!body || !(this.flags[i] & ALIVE)) {
        this.released.splice(k, 1)
        continue
      }
      const sleeping = body.isSleeping()
      if (sleeping && !this.awake[i]) continue
      const t = body.translation(), r = body.rotation()
      if (t.y < this.map.voidY) {
        this.remove(i)
        removed.push(i)
        this.released.splice(k, 1)
        continue
      }
      const o = i * BOX_STRIDE
      d[o] = t.x; d[o + 1] = t.y; d[o + 2] = t.z
      d[o + 3] = r.x; d[o + 4] = r.y; d[o + 5] = r.z; d[o + 6] = r.w
      this.markDirty(i)
      moved.push(i)
      this.awake[i] = sleeping ? 0 : 1
    }
  }

  /** Delete a brick entirely (fell into the void, or recycled builder slot). */
  remove(i: number) {
    if (!(this.flags[i] & ALIVE)) return
    const body = this.bodies[i]
    if (body) {
      for (let c = 0; c < body.numColliders(); c++) this.colliderBrick.delete(body.collider(c).handle)
      this.phys.removeRigidBody(body)
    }
    this.bodies[i] = null
    this.flags[i] = 0
    this.smoothing.delete(i)
    const o = i * BOX_STRIDE
    this.inst[o + 7] = this.inst[o + 8] = this.inst[o + 9] = 0
    for (const j of this.nbr[i]) {
      this.hidden[j] = 0
      const a = this.nbr[j], idx = a.indexOf(i)
      if (idx >= 0) a.splice(idx, 1)
    }
    this.nbr[i].length = 0
    this.markDirty(i)
  }

  /** Client: apply one brick transform from a host snapshot. */
  applyRemote(i: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number) {
    if (i >= this.cap || !(this.flags[i] & ALIVE)) return
    if (!(this.flags[i] & RELEASED)) this.release(i)
    const body = this.bodies[i]!
    if (this.isHost) {
      body.setTranslation({ x, y, z }, true)
      body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true)
    } else {
      body.setNextKinematicTranslation({ x, y, z })
      body.setNextKinematicRotation({ x: qx, y: qy, z: qz, w: qw })
    }
    const t = this.target, o = i * 7
    t[o] = x; t[o + 1] = y; t[o + 2] = z; t[o + 3] = qx; t[o + 4] = qy; t[o + 5] = qz; t[o + 6] = qw
    this.smoothing.add(i)
  }

  /** Client: ease rendered bricks towards their latest snapshot pose. */
  smooth(dt: number) {
    if (!this.smoothing.size) return
    const k = 1 - Math.exp(-dt * 14), d = this.inst, t = this.target
    for (const i of this.smoothing) {
      const o = i * BOX_STRIDE, p = i * 7
      const dx = t[p] - d[o], dy = t[p + 1] - d[o + 1], dz = t[p + 2] - d[o + 2]
      // snap on teleports (e.g. first snapshot after a long gap)
      if (dx * dx + dy * dy + dz * dz > 100) {
        d[o] = t[p]; d[o + 1] = t[p + 1]; d[o + 2] = t[p + 2]
      } else {
        d[o] += dx * k; d[o + 1] += dy * k; d[o + 2] += dz * k
      }
      // quaternion nlerp
      let qx = d[o + 3], qy = d[o + 4], qz = d[o + 5], qw = d[o + 6]
      const dot = qx * t[p + 3] + qy * t[p + 4] + qz * t[p + 5] + qw * t[p + 6]
      const s = dot < 0 ? -1 : 1
      qx += (t[p + 3] * s - qx) * k; qy += (t[p + 4] * s - qy) * k
      qz += (t[p + 5] * s - qz) * k; qw += (t[p + 6] * s - qw) * k
      const l = Math.hypot(qx, qy, qz, qw) || 1
      d[o + 3] = qx / l; d[o + 4] = qy / l; d[o + 5] = qz / l; d[o + 6] = qw / l
      this.markDirty(i)
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 0.002 && 1 - Math.abs(dot) < 1e-6) this.smoothing.delete(i)
    }
  }

  /** Host migration: take over simulation of the bricks we were mirroring. */
  promote() {
    this.isHost = true
    for (const i of this.released) {
      const body = this.bodies[i]
      if (!body) continue
      const o = i * BOX_STRIDE, d = this.inst
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
      body.setTranslation({ x: d[o], y: d[o + 1], z: d[o + 2] }, true)
      body.setRotation({ x: d[o + 3], y: d[o + 4], z: d[o + 5], w: d[o + 6] }, true)
      this.awake[i] = 1
    }
    this.smoothing.clear()
  }

  demote() {
    this.isHost = false
    for (const i of this.released) this.bodies[i]?.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
  }

  /** Builder tool: place a new brick in a recycled slot. Returns the slot. */
  createBrick(slot: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, rgb: number[]) {
    if (slot < this.n || slot >= this.cap) return -1
    this.remove(slot)
    this.spawnBrick(slot, { x, y, z, sx, sy, sz, r: rgb[0], g: rgb[1], b: rgb[2], mat: Mat.Studs, flags: 0, team: -1 })
    this.flags[slot] |= BUILT
    this.inst[slot * BOX_STRIDE + 15] = slot
    // weld to whatever it touches
    for (let j = 0; j < this.cap; j++) {
      if (j === slot || !(this.flags[j] & ALIVE) || this.flags[j] & RELEASED) continue
      if (this.touching(slot, j, 0.06)) {
        this.nbr[slot].push(j)
        this.nbr[j].push(slot)
      }
    }
    return slot
  }

  nextBuildSlot() {
    const s = this.n + this.builtNext
    this.builtNext = (this.builtNext + 1) % MAX_BUILT
    return s
  }

  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, out: RayHit): boolean {
    this.ray.origin = { x: ox, y: oy, z: oz }
    this.ray.dir = { x: dx, y: dy, z: dz }
    const hit = this.phys.castRayAndGetNormal(this.ray, max, true, undefined, G_RAY)
    if (!hit) return false
    out.dist = hit.timeOfImpact
    out.nx = hit.normal.x; out.ny = hit.normal.y; out.nz = hit.normal.z
    out.brick = this.colliderBrick.get(hit.collider.handle) ?? -1
    return true
  }

  /** Small push on a dynamic brick (slingshot pellets, sword). Host only. */
  nudge(i: number, ix: number, iy: number, iz: number) {
    if (!this.isHost || !(this.flags[i] & RELEASED)) return
    const body = this.bodies[i]
    const m = this.mass(i)
    if (body) body.applyImpulse({ x: ix * m, y: iy * m, z: iz * m }, true)
  }

  /** True if the core brick has been knocked off its pedestal or destroyed. */
  coreLost(i: number) {
    if (!(this.flags[i] & ALIVE)) return true
    if (!(this.flags[i] & RELEASED)) return false
    const o = i * BOX_STRIDE, d = this.inst
    const dx = d[o] - this.home[i * 3], dy = d[o + 1] - this.home[i * 3 + 1], dz = d[o + 2] - this.home[i * 3 + 2]
    return dy < -2.5 || dx * dx + dz * dz > 9
  }
}
