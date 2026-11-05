import { PF, PS } from '../net/net'
import { P } from './constants'

interface Sample { t: number; s: Float32Array }

/**
 * A peer's character as we see it: states arrive ~20 times a second and are
 * rendered ~100 ms in the past, interpolated between the two surrounding samples.
 */
export class RemotePlayer {
  name = 'Player'
  team = 0
  buf: Sample[] = []
  // interpolated view
  x = 0; y = 0; z = 0
  vx = 0; vz = 0
  yaw = 0
  pitch = 0
  hp = P.maxHp
  alive = false
  shield = false
  tool = 0
  kills = 0
  deaths = 0
  swingAt = -99
  lastSwing = 0
  walk = 0
  speed = 0
  lastSeen = 0
  wasAlive = false

  constructor(public id: string) {}

  push(s: Float32Array, now: number) {
    this.lastSeen = now
    const last = this.buf[this.buf.length - 1]
    if (last && s[PS.SEQ] <= last.s[PS.SEQ] && s[PS.SEQ] > last.s[PS.SEQ] - 1000) return // stale/out of order
    this.buf.push({ t: now, s })
    if (this.buf.length > 12) this.buf.shift()
    this.team = s[PS.TEAM] | 0
    this.kills = s[PS.KILLS] | 0
    this.deaths = s[PS.DEATHS] | 0
    this.hp = s[PS.HP]
    if (s[PS.SWING] !== this.lastSwing) {
      this.lastSwing = s[PS.SWING]
      this.swingAt = now
    }
  }

  /** Interpolate to (now - delay). Returns true if a new swing/attack started. */
  update(now: number, dt: number, delay = 100) {
    const b = this.buf
    if (!b.length) return
    const rt = now - delay
    let a = b[0], c = b[b.length - 1]
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1].t <= rt) { a = b[i - 1]; c = b[i]; break }
    }
    let k = c.t > a.t ? (rt - a.t) / (c.t - a.t) : 1
    k = Math.max(0, Math.min(1.25, k)) // allow slight extrapolation
    const A = a.s, C = c.s
    const teleport = Math.abs(C[PS.X] - A[PS.X]) + Math.abs(C[PS.Y] - A[PS.Y]) + Math.abs(C[PS.Z] - A[PS.Z]) > 20
    if (teleport) k = 1
    this.x = A[PS.X] + (C[PS.X] - A[PS.X]) * k
    this.y = A[PS.Y] + (C[PS.Y] - A[PS.Y]) * k
    this.z = A[PS.Z] + (C[PS.Z] - A[PS.Z]) * k
    let dy = C[PS.YAW] - A[PS.YAW]
    while (dy > Math.PI) dy -= Math.PI * 2
    while (dy < -Math.PI) dy += Math.PI * 2
    this.yaw = A[PS.YAW] + dy * Math.min(k, 1)
    this.pitch = A[PS.PITCH] + (C[PS.PITCH] - A[PS.PITCH]) * Math.min(k, 1)
    this.vx = C[PS.VX]; this.vz = C[PS.VZ]
    const flags = C[PS.FLAGS] | 0
    this.alive = (flags & PF.Alive) !== 0
    this.shield = (flags & PF.Shield) !== 0
    this.tool = C[PS.TOOL] | 0
    const sp = Math.hypot(this.vx, this.vz)
    this.speed = Math.min(1, sp / P.speed)
    if (flags & PF.Grounded) this.walk += sp * dt * 0.45
  }
}
