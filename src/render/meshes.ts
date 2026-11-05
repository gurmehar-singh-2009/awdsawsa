import models from '../assets/models.json'
import type { MeshData } from './scene'

type Raw = { palette: number[][]; meshes: Record<string, { p: number[]; n: number[]; c: number[] }> }

/** Expand the compact Blender export into interleaved vertex arrays. */
function build(): Record<string, MeshData> {
  const raw = models as unknown as Raw
  const out: Record<string, MeshData> = {}
  for (const [name, m] of Object.entries(raw.meshes)) {
    const tris = m.c.length
    const v = new Float32Array(tris * 3 * 10)
    let r2 = 0
    for (let t = 0; t < tris; t++) {
      const pal = raw.palette[m.c[t]]
      for (let k = 0; k < 3; k++) {
        const o = (t * 3 + k) * 10, p = (t * 3 + k) * 3
        v[o] = m.p[p]; v[o + 1] = m.p[p + 1]; v[o + 2] = m.p[p + 2]
        v[o + 3] = m.n[t * 3]; v[o + 4] = m.n[t * 3 + 1]; v[o + 5] = m.n[t * 3 + 2]
        v[o + 6] = pal[0]; v[o + 7] = pal[1]; v[o + 8] = pal[2]; v[o + 9] = pal[3]
        r2 = Math.max(r2, v[o] * v[o] + v[o + 1] * v[o + 1] + v[o + 2] * v[o + 2])
      }
    }
    out[name] = { verts: v, triCount: tris, radius: Math.sqrt(r2) }
  }
  out.sphere = icosphere(2)
  return out
}

/** Unit icosphere (white), used for explosions and spawn shields. */
function icosphere(sub: number): MeshData {
  const t = (1 + Math.sqrt(5)) / 2
  let vs: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(norm)
  let fs = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
    [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10],
    [8, 6, 7], [9, 8, 1],
  ]
  for (let s = 0; s < sub; s++) {
    const nf: number[][] = []
    const cache = new Map<string, number>()
    const mid = (a: number, b: number) => {
      const k = a < b ? a + ',' + b : b + ',' + a
      let i = cache.get(k)
      if (i === undefined) {
        i = vs.length
        vs.push(norm([(vs[a][0] + vs[b][0]) / 2, (vs[a][1] + vs[b][1]) / 2, (vs[a][2] + vs[b][2]) / 2]))
        cache.set(k, i)
      }
      return i
    }
    for (const [a, b, c] of fs) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a)
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    fs = nf
  }
  const v = new Float32Array(fs.length * 30)
  fs.forEach((f, i) => {
    const n = norm([0, 1, 2].map(k => (vs[f[0]][k] + vs[f[1]][k] + vs[f[2]][k]) / 3))
    f.forEach((vi, k) => {
      const o = (i * 3 + k) * 10
      v.set(vs[vi], o)
      v.set(n, o + 3)
      v[o + 6] = 1; v[o + 7] = 1; v[o + 8] = 1; v[o + 9] = 1 // emissive
    })
  })
  return { verts: v, triCount: fs.length, radius: 1 }
  function norm(p: number[]) {
    const l = Math.hypot(p[0], p[1], p[2])
    return [p[0] / l, p[1] / l, p[2] / l]
  }
}

export const MESHES = build()
