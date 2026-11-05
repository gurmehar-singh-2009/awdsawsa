// Small allocation-free math helpers. Y is up, the camera looks down -Z at yaw 0.

export type V3 = { x: number; y: number; z: number }
export type Q = { x: number; y: number; z: number; w: number }

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z })
export const quat = (x = 0, y = 0, z = 0, w = 1): Q => ({ x, y, z, w })

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export function len3(x: number, y: number, z: number) {
  return Math.sqrt(x * x + y * y + z * z)
}

/** Quaternion for a rotation of `a` radians about the Y axis. */
export function qYaw(a: number, out: Q = quat()): Q {
  out.x = 0; out.y = Math.sin(a / 2); out.z = 0; out.w = Math.cos(a / 2)
  return out
}

export function qAxis(ax: number, ay: number, az: number, a: number, out: Q = quat()): Q {
  const s = Math.sin(a / 2)
  out.x = ax * s; out.y = ay * s; out.z = az * s; out.w = Math.cos(a / 2)
  return out
}

/** out = a * b */
export function qMul(a: Q, b: Q, out: Q = quat()): Q {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  out.x = x; out.y = y; out.z = z; out.w = w
  return out
}

/** Rotate (x, y, z) by q, writing into out. */
export function qRot(q: Q, x: number, y: number, z: number, out: V3): V3 {
  // v + 2w(q×v) + 2 q×(q×v)
  const tx = 2 * (q.y * z - q.z * y)
  const ty = 2 * (q.z * x - q.x * z)
  const tz = 2 * (q.x * y - q.y * x)
  out.x = x + q.w * tx + (q.y * tz - q.z * ty)
  out.y = y + q.w * ty + (q.z * tx - q.x * tz)
  out.z = z + q.w * tz + (q.x * ty - q.y * tx)
  return out
}

export function qNlerp(a: Q, b: Q, t: number, out: Q): Q {
  const d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  const s = d < 0 ? -1 : 1
  out.x = a.x + (b.x * s - a.x) * t
  out.y = a.y + (b.y * s - a.y) * t
  out.z = a.z + (b.z * s - a.z) * t
  out.w = a.w + (b.w * s - a.w) * t
  const l = Math.hypot(out.x, out.y, out.z, out.w) || 1
  out.x /= l; out.y /= l; out.z /= l; out.w /= l
  return out
}

/** Column-major 4x4 matrix from rotation q, translation p and uniform scale s. */
export function mat4FromQPS(q: Q, px: number, py: number, pz: number, s: number, out: Float32Array) {
  const { x, y, z, w } = q
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  out[0] = (1 - (yy + zz)) * s; out[1] = (xy + wz) * s; out[2] = (xz - wy) * s; out[3] = 0
  out[4] = (xy - wz) * s; out[5] = (1 - (xx + zz)) * s; out[6] = (yz + wx) * s; out[7] = 0
  out[8] = (xz + wy) * s; out[9] = (yz - wx) * s; out[10] = (1 - (xx + yy)) * s; out[11] = 0
  out[12] = px; out[13] = py; out[14] = pz; out[15] = 1
  return out
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Camera with an orthonormal basis. Both renderers consume this directly:
 * right/up/fwd are world-space axes, fwd points where the camera looks.
 */
export class Camera {
  pos = v3()
  yaw = 0
  pitch = 0
  fov = (70 * Math.PI) / 180
  near = 0.1
  far = 300
  aspect = 16 / 9
  right = v3(1, 0, 0)
  up = v3(0, 1, 0)
  fwd = v3(0, 0, -1)
  viewProj = new Float32Array(16)

  update() {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw)
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch)
    this.fwd.x = -sy * cp; this.fwd.y = sp; this.fwd.z = -cy * cp
    this.right.x = cy; this.right.y = 0; this.right.z = -sy
    // up = right × fwd
    const r = this.right, f = this.fwd
    this.up.x = r.y * f.z - r.z * f.y
    this.up.y = r.z * f.x - r.x * f.z
    this.up.z = r.x * f.y - r.y * f.x

    const t = 1 / Math.tan(this.fov / 2)
    const n = this.near, fa = this.far
    const a = t / this.aspect
    const zA = (fa + n) / (n - fa), zB = (2 * fa * n) / (n - fa)
    const p = this.pos, m = this.viewProj
    // view rows (camera looks down -Z in view space) multiplied by projection
    const tx = -(r.x * p.x + r.y * p.y + r.z * p.z)
    const u = this.up
    const ty = -(u.x * p.x + u.y * p.y + u.z * p.z)
    const tz = f.x * p.x + f.y * p.y + f.z * p.z // = -(-f·p)
    // view matrix rows: r, u, -f
    m[0] = a * r.x; m[4] = a * r.y; m[8] = a * r.z; m[12] = a * tx
    m[1] = t * u.x; m[5] = t * u.y; m[9] = t * u.z; m[13] = t * ty
    m[2] = zA * -f.x; m[6] = zA * -f.y; m[10] = zA * -f.z; m[14] = zA * tz + zB
    m[3] = f.x; m[7] = f.y; m[11] = f.z; m[15] = -tz
  }

  /** Project world point to normalized screen coords [0..1]; returns false if behind camera. */
  project(x: number, y: number, z: number, out: { x: number; y: number; d: number }) {
    const dx = x - this.pos.x, dy = y - this.pos.y, dz = z - this.pos.z
    const vz = dx * this.fwd.x + dy * this.fwd.y + dz * this.fwd.z
    if (vz < this.near) return false
    const t = Math.tan(this.fov / 2)
    const vx = dx * this.right.x + dy * this.right.y + dz * this.right.z
    const vy = dx * this.up.x + dy * this.up.y + dz * this.up.z
    out.x = 0.5 + (vx / (vz * t * this.aspect)) * 0.5
    out.y = 0.5 - (vy / (vz * t)) * 0.5
    out.d = vz
    return true
  }
}
