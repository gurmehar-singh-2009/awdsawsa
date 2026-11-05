import RAPIER from '@dimforge/rapier3d-compat'
import { mat4FromQPS, quat, type Q } from '../engine/math'
import { Mat, type BoxList, type MeshDraw } from '../render/scene'
import { G_DEBRIS, type World } from './world'

interface Particle {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  life: number; max: number
  size: number
  r: number; g: number; b: number
  grav: number
  glow: boolean
}

interface Blast { x: number; y: number; z: number; r: number; t: number; tint: number[] }
interface Debris { body: RAPIER.RigidBody; s: number[]; c: number[]; t: number }

/**
 * Cosmetic effects. Everything here is local-only (never networked): particles are
 * simple ballistic cubes, explosion flashes are translucent spheres, and death debris
 * uses short-lived local physics bodies that collide with bricks but nothing else.
 */
export class Effects {
  parts: Particle[] = []
  pool: Particle[] = []
  blasts: Blast[] = []
  debris: Debris[] = []
  maxParticles = 300
  private q: Q = quat()

  constructor(public world: World) {}

  clear() {
    this.parts.length = 0
    this.blasts.length = 0
    this.debris.length = 0 // bodies die with the old physics world
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, c: number[], grav = 30, glow = false) {
    if (this.parts.length >= this.maxParticles) return
    const p = this.pool.pop() ?? ({} as Particle)
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz
    p.life = life; p.max = life; p.size = size
    p.r = c[0]; p.g = c[1]; p.b = c[2]; p.grav = grav; p.glow = glow
    this.parts.push(p)
  }

  explosion(x: number, y: number, z: number, r: number) {
    this.blasts.push({ x, y, z, r, t: 0, tint: [1, 0.62, 0.2] })
    const n = Math.min(40, Math.round(r * 4))
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.random() * 2 - 1, s = 8 + Math.random() * r * 3
      const k = Math.sqrt(1 - b * b)
      const fire = i < n * 0.6
      this.spawn(x, y, z, Math.cos(a) * k * s, b * s + 6, Math.sin(a) * k * s, 0.5 + Math.random() * 0.7,
        fire ? 0.6 + Math.random() * 0.8 : 0.5 + Math.random() * 0.5,
        fire ? [1, 0.4 + Math.random() * 0.5, 0.1] : [0.35, 0.33, 0.32], fire ? 4 : 18, fire)
    }
  }

  puff(x: number, y: number, z: number, c: number[], n = 6, speed = 6) {
    for (let i = 0; i < n; i++) {
      this.spawn(x, y, z, (Math.random() - 0.5) * speed, Math.random() * speed, (Math.random() - 0.5) * speed,
        0.35 + Math.random() * 0.3, 0.25 + Math.random() * 0.25, c, 25)
    }
  }

  /** Character shatters into its parts (local physics, removed after a few seconds). */
  shatter(parts: { x: number; y: number; z: number; q: Q; s: number[]; c: number[] }[], vx: number, vy: number, vz: number) {
    for (const p of parts) {
      const body = this.world.phys.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(p.q)
          .setLinvel(vx + (Math.random() - 0.5) * 14, vy + Math.random() * 10, vz + (Math.random() - 0.5) * 14)
          .setAngvel({ x: Math.random() * 8 - 4, y: Math.random() * 8 - 4, z: Math.random() * 8 - 4 }),
      )
      this.world.phys.createCollider(
        RAPIER.ColliderDesc.cuboid(p.s[0] / 2, p.s[1] / 2, p.s[2] / 2).setDensity(0.5).setCollisionGroups(G_DEBRIS),
        body,
      )
      this.debris.push({ body, s: p.s, c: p.c, t: 0 })
    }
    while (this.debris.length > 60) this.removeDebris(0)
  }

  private removeDebris(i: number) {
    const d = this.debris[i]
    if (this.world.phys.getRigidBody(d.body.handle)) this.world.phys.removeRigidBody(d.body)
    this.debris.splice(i, 1)
  }

  update(dt: number) {
    const ps = this.parts
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]
      p.life -= dt
      if (p.life <= 0) {
        ps[i] = ps[ps.length - 1]
        ps.pop()
        this.pool.push(p)
        continue
      }
      p.vy -= p.grav * dt
      const drag = Math.exp(-dt * 2.5)
      p.vx *= drag; p.vy *= drag; p.vz *= drag
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      this.blasts[i].t += dt
      if (this.blasts[i].t > 0.45) this.blasts.splice(i, 1)
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      this.debris[i].t += dt
      if (this.debris[i].t > 5 || this.debris[i].body.translation().y < -80) this.removeDebris(i)
    }
  }

  draw(out: BoxList, alphaMeshes: MeshDraw[], matPool: Float32Array[]) {
    for (const p of this.parts) {
      const k = p.life / p.max, s = p.size * (0.4 + 0.6 * k)
      out.push(p.x, p.y, p.z, 0, 0, 0, 1, s, s, s, p.r, p.g, p.b, p.glow ? Mat.Glow : Mat.Smooth, 1, 0)
    }
    for (const d of this.debris) {
      const t = d.body.translation(), r = d.body.rotation()
      const shrink = d.t > 4 ? 1 - (d.t - 4) : 1
      out.push(t.x, t.y, t.z, r.x, r.y, r.z, r.w, d.s[0] * shrink, d.s[1] * shrink, d.s[2] * shrink, d.c[0], d.c[1], d.c[2], Mat.Smooth, 1, 0)
    }
    for (const b of this.blasts) {
      const k = b.t / 0.45
      const m = matPool.pop() ?? new Float32Array(16)
      this.q.x = this.q.y = this.q.z = 0; this.q.w = 1
      mat4FromQPS(this.q, b.x, b.y, b.z, b.r * (0.35 + 0.75 * Math.sqrt(k)), m)
      alphaMeshes.push({ mesh: 'sphere', m, tint: b.tint, alpha: 0.75 * (1 - k) })
    }
  }
}
