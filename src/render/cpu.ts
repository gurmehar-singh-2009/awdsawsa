import { BOX_STRIDE, type Frame, type MeshDraw, type Renderer } from './scene'
import { MESHES } from './meshes'

/*
 * Software renderer for machines without a usable GPU. Draws into a small
 * ImageData (typically 240-480 px wide) that CSS scales up with pixelated filtering.
 *
 * Tricks that keep it fast:
 *  - flat shading: one colour per face, so the inner loop is a depth test + store
 *  - faces hidden by neighbouring bricks are skipped via a precomputed bitmask
 *  - sphere/frustum + fog-distance culling per box before any per-vertex work
 *  - box faces are back-face culled analytically (one dot product per face)
 *  - edge-function rasteriser with incremental depth and early row exit
 *  - translucency through ordered dithering, so no sorting is needed
 */

const BAYER = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16))

export class CpuRenderer implements Renderer {
  readonly kind = 'cpu'
  readonly label = 'CPU (software)'
  private ctx: CanvasRenderingContext2D
  private img!: ImageData
  private px!: Uint32Array
  private zb!: Float32Array
  private W = 0
  private H = 0
  // camera state for the current frame
  private cx = 0; private cy = 0; private cz = 0
  private rx = 0; private ry = 0; private rz = 0
  private ux = 0; private uy = 0; private uz = 0
  private fx = 0; private fy = 0; private fz = 0
  private sx = 0; private sy = 0 // focal lengths in pixels
  private tanX = 0; private tanY = 0
  private near = 0.1
  private far = 300
  private f!: Frame
  // clip scratch: up to 8 verts (x, y, z)
  private pin = new Float32Array(24)
  private pout = new Float32Array(24)
  private scr = new Float32Array(24)
  private corner = new Float32Array(24)
  private alpha = 1

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!ctx) throw new Error('no 2d context')
    this.ctx = ctx
    canvas.style.imageRendering = 'pixelated'
  }

  resize(w: number, h: number, scale: number) {
    const W = Math.max(64, Math.round(w * scale)), H = Math.max(36, Math.round(h * scale))
    if (W === this.W && H === this.H) return
    this.W = W
    this.H = H
    this.canvas.width = W
    this.canvas.height = H
    this.img = this.ctx.createImageData(W, H)
    this.px = new Uint32Array(this.img.data.buffer)
    this.zb = new Float32Array(W * H)
  }

  render(f: Frame) {
    this.f = f
    const c = f.cam, W = this.W, H = this.H
    this.cx = c.pos.x; this.cy = c.pos.y; this.cz = c.pos.z
    this.rx = c.right.x; this.ry = c.right.y; this.rz = c.right.z
    this.ux = c.up.x; this.uy = c.up.y; this.uz = c.up.z
    this.fx = c.fwd.x; this.fy = c.fwd.y; this.fz = c.fwd.z
    this.tanY = Math.tan(c.fov / 2)
    this.tanX = this.tanY * c.aspect
    this.sx = W / 2 / this.tanX
    this.sy = H / 2 / this.tanY
    this.near = Math.max(0.05, c.near)
    this.far = f.env.fogFar

    this.drawSky()
    this.zb.fill(0)

    const hidden = f.brickHidden
    this.drawBoxes(f.bricks, f.brickCount, hidden)
    this.drawBoxes(f.dyn.data, f.dyn.count, null)
    for (const m of f.meshes) this.drawMesh(m, false)
    for (const m of f.alphaMeshes) this.drawMesh(m, true)
    this.drawBoxes(f.dynAlpha.data, f.dynAlpha.count, null, true)

    this.ctx.putImageData(this.img, 0, 0)
  }

  private drawSky() {
    const e = this.f.env, W = this.W, H = this.H, px = this.px
    for (let y = 0; y < H; y++) {
      const ndc = 1 - (2 * (y + 0.5)) / H
      const dx = this.fx + this.ux * ndc * this.tanY
      const dy = this.fy + this.uy * ndc * this.tanY
      const dz = this.fz + this.uz * ndc * this.tanY
      const h = dy / Math.sqrt(dx * dx + dy * dy + dz * dz)
      let r: number, g: number, b: number
      if (h >= 0) {
        const t = smooth(0, 0.55, h)
        r = e.skyHorizon[0] + (e.skyTop[0] - e.skyHorizon[0]) * t
        g = e.skyHorizon[1] + (e.skyTop[1] - e.skyHorizon[1]) * t
        b = e.skyHorizon[2] + (e.skyTop[2] - e.skyHorizon[2]) * t
      } else {
        const t = 1 - smooth(0, 0.4, -h) * 0.18
        r = e.skyHorizon[0] * t; g = e.skyHorizon[1] * t; b = e.skyHorizon[2] * t
      }
      px.fill(pack(r, g, b), y * W, y * W + W)
    }
  }

  /** Lit + fogged colour for a face with world normal n at camera distance d. */
  private shade(r: number, g: number, b: number, nx: number, ny: number, nz: number, d: number, mat: number) {
    const e = this.f.env
    if (mat === 2) {
      r = r * 1.25 + 0.15; g = g * 1.25 + 0.15; b = b * 1.25 + 0.15
    } else {
      const s = e.sunDir
      const dif = Math.max(0, nx * s[0] + ny * s[1] + nz * s[2]) * 0.78
      const t = ny * 0.5 + 0.5
      const ar = (e.ground[0] + (e.skyHorizon[0] - e.ground[0]) * t) * 0.62
      const ag = (e.ground[1] + (e.skyHorizon[1] - e.ground[1]) * t) * 0.62
      const ab = (e.ground[2] + (e.skyHorizon[2] - e.ground[2]) * t) * 0.62
      r *= ar + e.sunColor[0] * dif
      g *= ag + e.sunColor[1] * dif
      b *= ab + e.sunColor[2] * dif
    }
    let fo = (d - e.fogNear) / (e.fogFar - e.fogNear)
    if (fo > 0) {
      if (fo > 1) fo = 1
      fo *= fo
      r += (e.skyHorizon[0] - r) * fo
      g += (e.skyHorizon[1] - g) * fo
      b += (e.skyHorizon[2] - b) * fo
    }
    return pack(r, g, b)
  }

  private drawBoxes(d: Float32Array, count: number, hidden: Uint8Array | null, translucent = false) {
    const far = this.far, cxw = this.cx, cyw = this.cy, czw = this.cz
    const rx = this.rx, ry = this.ry, rz = this.rz, ux = this.ux, uy = this.uy, uz = this.uz
    const fx = this.fx, fy = this.fy, fz = this.fz
    const secX = Math.sqrt(1 + this.tanX * this.tanX), secY = Math.sqrt(1 + this.tanY * this.tanY)
    const k = this.corner
    for (let i = 0; i < count; i++) {
      const o = i * BOX_STRIDE
      const sxs = d[o + 7], sys = d[o + 8], szs = d[o + 9]
      if (sxs === 0) continue // removed
      const mask = hidden ? hidden[i] : 0
      if (mask === 63) continue
      const wx = d[o] - cxw, wy = d[o + 1] - cyw, wz = d[o + 2] - czw
      const vz = wx * fx + wy * fy + wz * fz
      const rad = 0.5 * Math.sqrt(sxs * sxs + sys * sys + szs * szs)
      if (vz < -rad || vz - rad > far) continue
      const vx = wx * rx + wy * ry + wz * rz
      if (Math.abs(vx) - rad * secX > vz * this.tanX) continue
      const vy = wx * ux + wy * uy + wz * uz
      if (Math.abs(vy) - rad * secY > vz * this.tanY) continue

      this.alpha = translucent ? d[o + 14] : 1
      // half-axes in world space (rotated by quaternion), then camera space
      const qx = d[o + 3], qy = d[o + 4], qz = d[o + 5], qw = d[o + 6]
      const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz
      const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2
      const wxq = qw * x2, wyq = qw * y2, wzq = qw * z2
      // rotation matrix columns = world directions of local axes
      const m0 = 1 - (yy + zz), m1 = xy + wzq, m2 = xz - wyq
      const m3 = xy - wzq, m4 = 1 - (xx + zz), m5 = yz + wxq
      const m6 = xz + wyq, m7 = yz - wxq, m8 = 1 - (xx + yy)
      const hx = sxs / 2, hy = sys / 2, hz = szs / 2
      // camera-space half axes
      const axx = (m0 * rx + m1 * ry + m2 * rz) * hx, axy = (m0 * ux + m1 * uy + m2 * uz) * hx, axz = (m0 * fx + m1 * fy + m2 * fz) * hx
      const ayx = (m3 * rx + m4 * ry + m5 * rz) * hy, ayy = (m3 * ux + m4 * uy + m5 * uz) * hy, ayz = (m3 * fx + m4 * fy + m5 * fz) * hy
      const azx = (m6 * rx + m7 * ry + m8 * rz) * hz, azy = (m6 * ux + m7 * uy + m8 * uz) * hz, azz = (m6 * fx + m7 * fy + m8 * fz) * hz
      // 8 corners: index bits (x, y, z) sign
      for (let c = 0; c < 8; c++) {
        const sx = c & 1 ? 1 : -1, sy = c & 2 ? 1 : -1, sz = c & 4 ? 1 : -1
        k[c * 3] = vx + sx * axx + sy * ayx + sz * azx
        k[c * 3 + 1] = vy + sx * axy + sy * ayy + sz * azy
        k[c * 3 + 2] = vz + sx * axz + sy * ayz + sz * azz
      }
      const r = d[o + 10], g = d[o + 11], b = d[o + 12], mat = d[o + 13]
      const vary = mat === 4 || mat === 2 ? 1 : 0.86 + 0.14 * ((d[o + 15] * 0.6180339) % 1)
      const dist = Math.sqrt(vx * vx + vy * vy + vz * vz)
      // faces: +X -X +Y -Y +Z -Z
      for (let fIdx = 0; fIdx < 6; fIdx++) {
        if (mask & (1 << fIdx)) continue
        const axis = fIdx >> 1, sgn = fIdx & 1 ? -1 : 1
        let nx: number, ny: number, nz: number // camera-space outward half axis
        let wnx: number, wny: number, wnz: number // world normal
        if (axis === 0) { nx = axx * sgn; ny = axy * sgn; nz = axz * sgn; wnx = m0 * sgn; wny = m1 * sgn; wnz = m2 * sgn }
        else if (axis === 1) { nx = ayx * sgn; ny = ayy * sgn; nz = ayz * sgn; wnx = m3 * sgn; wny = m4 * sgn; wnz = m5 * sgn }
        else { nx = azx * sgn; ny = azy * sgn; nz = azz * sgn; wnx = m6 * sgn; wny = m7 * sgn; wnz = m8 * sgn }
        // back-face: face centre (c + n) dotted with outward n
        if (!translucent && (vx + nx) * nx + (vy + ny) * ny + (vz + nz) * nz >= 0) continue
        let cr = r, cg = g, cb = b
        if (mat === 3) {
          if (wny > 0.5) { cr = 0.33; cg = 0.6; cb = 0.24 } else { const t = 0.86 + 0.1 * ((i * 7 + fIdx) % 3) / 2; cr *= t; cg *= t; cb *= t }
        }
        const color = this.shade(cr * vary, cg * vary, cb * vary, wnx, wny, wnz, dist, mat)
        // corner indices for this face, in a consistent loop
        const bit = 1 << axis, want = sgn > 0 ? bit : 0
        const o1 = axis === 0 ? 2 : 1, o2 = axis === 2 ? 2 : 4
        const a0 = want, a1 = want | o1, a2 = want | o1 | o2, a3 = want | o2
        this.quad(a0, a1, a2, a3, color)
      }
    }
  }

  private quad(a: number, b: number, c: number, d: number, color: number) {
    const k = this.corner, p = this.pin
    p[0] = k[a * 3]; p[1] = k[a * 3 + 1]; p[2] = k[a * 3 + 2]
    p[3] = k[b * 3]; p[4] = k[b * 3 + 1]; p[5] = k[b * 3 + 2]
    p[6] = k[c * 3]; p[7] = k[c * 3 + 1]; p[8] = k[c * 3 + 2]
    p[9] = k[d * 3]; p[10] = k[d * 3 + 1]; p[11] = k[d * 3 + 2]
    this.poly(4, color)
  }

  /** Clip the polygon in `pin` against the near plane, project, and fan-rasterise. */
  private poly(n: number, color: number) {
    const near = this.near
    let src = this.pin, cnt = n
    let allIn = true
    for (let i = 0; i < n; i++) if (src[i * 3 + 2] < near) { allIn = false; break }
    if (!allIn) {
      const dst = this.pout
      let m = 0
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const az = src[i * 3 + 2], bz = src[j * 3 + 2]
        const ain = az >= near, bin = bz >= near
        if (ain) { dst[m * 3] = src[i * 3]; dst[m * 3 + 1] = src[i * 3 + 1]; dst[m * 3 + 2] = az; m++ }
        if (ain !== bin) {
          const t = (near - az) / (bz - az)
          dst[m * 3] = src[i * 3] + (src[j * 3] - src[i * 3]) * t
          dst[m * 3 + 1] = src[i * 3 + 1] + (src[j * 3 + 1] - src[i * 3 + 1]) * t
          dst[m * 3 + 2] = near
          m++
        }
      }
      if (m < 3) return
      src = dst
      cnt = m
    }
    const s = this.scr, hw = this.W / 2, hh = this.H / 2
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9
    for (let i = 0; i < cnt; i++) {
      const iz = 1 / src[i * 3 + 2]
      const x = hw + src[i * 3] * iz * this.sx
      const y = hh - src[i * 3 + 1] * iz * this.sy
      s[i * 3] = x; s[i * 3 + 1] = y; s[i * 3 + 2] = iz
      if (x < minx) minx = x; if (x > maxx) maxx = x
      if (y < miny) miny = y; if (y > maxy) maxy = y
    }
    if (maxx < 0 || minx >= this.W || maxy < 0 || miny >= this.H) return
    for (let i = 1; i < cnt - 1; i++) {
      this.tri(s[0], s[1], s[2], s[i * 3], s[i * 3 + 1], s[i * 3 + 2], s[i * 3 + 3], s[i * 3 + 4], s[i * 3 + 5], color)
    }
  }

  private tri(
    x0: number, y0: number, w0: number, x1: number, y1: number, w1: number, x2: number, y2: number, w2: number,
    color: number,
  ) {
    let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
    if (area === 0) return
    if (area < 0) {
      // normalise winding (culling already happened in 3D)
      let t = x1; x1 = x2; x2 = t
      t = y1; y1 = y2; y2 = t
      t = w1; w1 = w2; w2 = t
      area = -area
    }
    const W = this.W, H = this.H
    let minX = Math.floor(Math.min(x0, x1, x2)), maxX = Math.ceil(Math.max(x0, x1, x2))
    let minY = Math.floor(Math.min(y0, y1, y2)), maxY = Math.ceil(Math.max(y0, y1, y2))
    if (minX < 0) minX = 0
    if (minY < 0) minY = 0
    if (maxX > W - 1) maxX = W - 1
    if (maxY > H - 1) maxY = H - 1
    if (minX > maxX || minY > maxY) return
    const inv = 1 / area
    // edge function steps
    const e0dx = -(y2 - y1), e0dy = x2 - x1
    const e1dx = -(y0 - y2), e1dy = x0 - x2
    const e2dx = -(y1 - y0), e2dy = x1 - x0
    const px0 = minX + 0.5, py0 = minY + 0.5
    let r0 = (x2 - x1) * (py0 - y1) - (y2 - y1) * (px0 - x1)
    let r1 = (x0 - x2) * (py0 - y2) - (y0 - y2) * (px0 - x2)
    let r2 = (x1 - x0) * (py0 - y0) - (y1 - y0) * (px0 - x0)
    const wdx = (e0dx * w0 + e1dx * w1 + e2dx * w2) * inv
    const wdy = (e0dy * w0 + e1dy * w1 + e2dy * w2) * inv
    let rw = (r0 * w0 + r1 * w1 + r2 * w2) * inv
    const zb = this.zb, px = this.px
    const alpha = this.alpha
    for (let y = minY; y <= maxY; y++) {
      let e0 = r0, e1 = r1, e2 = r2, w = rw
      let idx = y * W + minX
      let inside = false
      if (alpha >= 1) {
        for (let x = minX; x <= maxX; x++, idx++) {
          if (e0 >= 0 && e1 >= 0 && e2 >= 0) {
            inside = true
            if (w > zb[idx]) { zb[idx] = w; px[idx] = color }
          } else if (inside) break
          e0 += e0dx; e1 += e1dx; e2 += e2dx; w += wdx
        }
      } else {
        const row = (y & 3) * 4
        for (let x = minX; x <= maxX; x++, idx++) {
          if (e0 >= 0 && e1 >= 0 && e2 >= 0) {
            inside = true
            if (w > zb[idx] && alpha > BAYER[row + (x & 3)]) px[idx] = color
          } else if (inside) break
          e0 += e0dx; e1 += e1dx; e2 += e2dx; w += wdx
        }
      }
      r0 += e0dy; r1 += e1dy; r2 += e2dy; rw += wdy
    }
  }

  private drawMesh(d: MeshDraw, translucent: boolean) {
    const mesh = MESHES[d.mesh]
    if (!mesh) return
    const m = d.m, v = mesh.verts
    const tx = m[12] - this.cx, ty = m[13] - this.cy, tz = m[14] - this.cz
    // bounding-sphere cull
    const scale = Math.hypot(m[0], m[1], m[2])
    const rad = mesh.radius * scale
    const vz = tx * this.fx + ty * this.fy + tz * this.fz
    if (vz < -rad || vz - rad > this.far) return
    const dist = Math.max(0, vz)
    this.alpha = translucent ? d.alpha : 1
    const p = this.pin
    const tint = d.tint
    for (let t = 0; t < mesh.triCount; t++) {
      const base = t * 30
      for (let k = 0; k < 3; k++) {
        const o = base + k * 10
        const lx = v[o], ly = v[o + 1], lz = v[o + 2]
        const wx = m[0] * lx + m[4] * ly + m[8] * lz + tx
        const wy = m[1] * lx + m[5] * ly + m[9] * lz + ty
        const wz = m[2] * lx + m[6] * ly + m[10] * lz + tz
        p[k * 3] = wx * this.rx + wy * this.ry + wz * this.rz
        p[k * 3 + 1] = wx * this.ux + wy * this.uy + wz * this.uz
        p[k * 3 + 2] = wx * this.fx + wy * this.fy + wz * this.fz
      }
      const nlx = v[base + 3], nly = v[base + 4], nlz = v[base + 5]
      let nx = m[0] * nlx + m[4] * nly + m[8] * nlz
      let ny = m[1] * nlx + m[5] * nly + m[9] * nlz
      let nz = m[2] * nlx + m[6] * nly + m[10] * nlz
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      nx /= nl; ny /= nl; nz /= nl
      if (!translucent) {
        const cnx = nx * this.rx + ny * this.ry + nz * this.rz
        const cny = nx * this.ux + ny * this.uy + nz * this.uz
        const cnz = nx * this.fx + ny * this.fy + nz * this.fz
        if (p[0] * cnx + p[1] * cny + p[2] * cnz >= 0) continue
      }
      let r = v[base + 6], g = v[base + 7], b = v[base + 8]
      if (tint && r > 0.85 && g > 0.85 && b > 0.85) { r *= tint[0]; g *= tint[1]; b *= tint[2] }
      const color = this.shade(r, g, b, nx, ny, nz, dist, v[base + 9] > 0.5 ? 2 : 0)
      this.poly(3, color)
    }
  }

  destroy() {}
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function pack(r: number, g: number, b: number) {
  const R = r >= 1 ? 255 : r <= 0 ? 0 : (r * 255) | 0
  const G = g >= 1 ? 255 : g <= 0 ? 0 : (g * 255) | 0
  const B = b >= 1 ? 255 : b <= 0 ? 0 : (b * 255) | 0
  return (0xff000000 | (B << 16) | (G << 8) | R) >>> 0
}
