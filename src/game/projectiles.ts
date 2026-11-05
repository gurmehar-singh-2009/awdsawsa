import { mat4FromQPS, quat, type Q } from '../engine/math'
import { Mat, type BoxList, type MeshDraw } from '../render/scene'
import { BOMB, PELLET, ROCKET, TOOL } from './constants'
import type { RayHit, World } from './world'

export interface Target { id: string; x: number; y: number; z: number; team: number; alive: boolean }

export interface Proj {
  id: string
  kind: number // TOOL.Rocket | TOOL.Bomb | TOOL.Sling
  owner: string
  team: number
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  t: number
  dead: boolean
  resting: boolean
  waiting: boolean // hit something locally; waiting for the host's explosion
}

const hit: RayHit = { dist: 0, brick: -1, nx: 0, ny: 0, nz: 0 }

/**
 * Every peer simulates every projectile from the shooter's fire event. Outcomes are
 * split by authority: explosions are decided by the host (so brick destruction is
 * consistent), pellet hits on players by the shooter (so hits feel instant).
 */
export class Projectiles {
  list: Proj[] = []
  onRocketImpact: (p: Proj, x: number, y: number, z: number) => void = () => {}
  onBombFuse: (p: Proj) => void = () => {}
  onPelletPlayer: (p: Proj, target: string) => void = () => {}
  onPelletBrick: (p: Proj, brick: number) => void = () => {}
  private q: Q = quat()

  constructor(public world: World) {}

  add(p: Omit<Proj, 't' | 'dead' | 'resting' | 'waiting'>) {
    if (this.list.length > 200) this.list.shift()
    this.list.push({ ...p, t: 0, dead: false, resting: false, waiting: false })
  }

  /** Called when the host announces an explosion for this projectile. */
  detonated(id: string) {
    for (const p of this.list) if (p.id === id) p.dead = true
  }

  clear() {
    this.list.length = 0
  }

  step(dt: number, targets: Target[]) {
    for (const p of this.list) {
      if (p.dead) continue
      p.t += dt
      if (p.waiting) {
        if (p.t > 2) p.dead = true // the host never confirmed: drop it
        continue
      }
      if (p.kind === TOOL.Rocket) this.stepRocket(p, dt, targets)
      else if (p.kind === TOOL.Bomb) this.stepBomb(p, dt)
      else this.stepPellet(p, dt, targets)
    }
    this.list = this.list.filter(p => !p.dead)
  }

  private segment(p: Proj, dt: number, targets: Target[] | null): { t: number; brick: number; player: string } | null {
    const dx = p.vx * dt, dy = p.vy * dt, dz = p.vz * dt
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < 1e-6) return null
    let best: { t: number; brick: number; player: string } | null = null
    if (this.world.raycast(p.x, p.y, p.z, dx / len, dy / len, dz / len, len, hit)) {
      best = { t: hit.dist / len, brick: hit.brick, player: '' }
    }
    if (targets) {
      for (const tg of targets) {
        if (!tg.alive || (tg.id === p.owner && p.t < 0.25)) continue
        // sample the segment against a vertical capsule around the character
        for (let s = 0; s <= 4; s++) {
          const f = s / 4
          if (best && f > best.t) break
          const x = p.x + dx * f, y = p.y + dy * f, z = p.z + dz * f
          const cy = Math.min(Math.max(y, tg.y + 0.9), tg.y + 3.9)
          const ex = x - tg.x, ey = y - cy, ez = z - tg.z
          if (ex * ex + ey * ey + ez * ez < 1.2 * 1.2) {
            best = { t: f, brick: -1, player: tg.id }
            break
          }
        }
      }
    }
    return best
  }

  private stepRocket(p: Proj, dt: number, targets: Target[]) {
    const h = this.segment(p, dt, targets)
    if (h) {
      const x = p.x + p.vx * dt * h.t, y = p.y + p.vy * dt * h.t, z = p.z + p.vz * dt * h.t
      p.x = x; p.y = y; p.z = z
      p.waiting = true
      this.onRocketImpact(p, x, y, z)
      return
    }
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
    if (p.t > ROCKET.life || p.y < -80) {
      p.waiting = true
      this.onRocketImpact(p, p.x, p.y, p.z)
    }
  }

  private stepBomb(p: Proj, dt: number) {
    if (p.t >= BOMB.fuse) {
      p.waiting = true
      this.onBombFuse(p)
      return
    }
    if (p.y < -80) { p.dead = true; return }
    if (p.resting) {
      // re-check support (the floor might have been blown away)
      if (!this.world.raycast(p.x, p.y, p.z, 0, -1, 0, 0.75, hit)) p.resting = false
      return
    }
    p.vy -= 60 * dt
    const h = this.segment(p, dt, null)
    if (h) {
      // segment() ran the ray cast, so `hit` holds the surface normal
      const t = h.t
      p.x += p.vx * dt * t + hit.nx * 0.05; p.y += p.vy * dt * t + hit.ny * 0.05; p.z += p.vz * dt * t + hit.nz * 0.05
      // bounce: reflect with damping
      const vn = p.vx * hit.nx + p.vy * hit.ny + p.vz * hit.nz
      p.vx = (p.vx - 1.5 * vn * hit.nx) * 0.6
      p.vy = (p.vy - 1.5 * vn * hit.ny) * 0.6
      p.vz = (p.vz - 1.5 * vn * hit.nz) * 0.6
      if (hit.ny > 0.6 && Math.hypot(p.vx, p.vy, p.vz) < 3) {
        p.resting = true
        p.vx = p.vy = p.vz = 0
        p.y += 0.55
      }
      return
    }
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
  }

  private stepPellet(p: Proj, dt: number, targets: Target[]) {
    p.vy -= PELLET.gravity * dt
    const h = this.segment(p, dt, targets.filter(t => t.team !== p.team))
    if (h) {
      if (h.player) this.onPelletPlayer(p, h.player)
      else if (h.brick >= 0) this.onPelletBrick(p, h.brick)
      p.dead = true
      p.x += p.vx * dt * h.t; p.y += p.vy * dt * h.t; p.z += p.vz * dt * h.t
      return
    }
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
    if (p.t > PELLET.life) p.dead = true
  }

  draw(meshes: MeshDraw[], boxes: BoxList, matPool: Float32Array[], time: number) {
    for (const p of this.list) {
      if (p.dead || p.waiting) continue
      if (p.kind === TOOL.Sling) {
        boxes.push(p.x, p.y, p.z, 0, 0, 0, 1, 0.35, 0.35, 0.35, 0.85, 0.85, 0.8, Mat.Smooth, 1, 0)
        continue
      }
      const m = matPool.pop() ?? new Float32Array(16)
      if (p.kind === TOOL.Rocket) {
        // the model's nose points down -Z: orient it along the velocity
        const yaw = Math.atan2(-p.vx, -p.vz)
        const pitch = Math.atan2(p.vy, Math.hypot(p.vx, p.vz))
        eulerYP(yaw, pitch, this.q)
        mat4FromQPS(this.q, p.x, p.y, p.z, 1.2, m)
        meshes.push({ mesh: 'rocket', m, tint: null, alpha: 1 })
      } else {
        const blink = p.t > BOMB.fuse - 1 ? (Math.sin(time * 30) > 0 ? [1.6, 0.6, 0.6] : null) : null
        eulerYP(p.t * 2, 0, this.q)
        mat4FromQPS(this.q, p.x, p.y, p.z, 1, m)
        meshes.push({ mesh: 'bomb', m, tint: blink, alpha: 1 })
      }
    }
  }
}

/** Quaternion for yaw (about Y) then pitch (about local X). */
export function eulerYP(yaw: number, pitch: number, out: Q) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2)
  out.x = cy * sp; out.y = sy * cp; out.z = -sy * sp; out.w = cy * cp
  return out
}
