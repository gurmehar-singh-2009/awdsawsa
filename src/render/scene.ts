import type { Camera } from '../engine/math'

/**
 * Everything in Brickfall is drawn from two primitives:
 *  - box instances (bricks, characters, particles), 16 floats each
 *  - small triangle meshes exported from Blender (tools, rockets, cores)
 * Both the WebGL and the CPU renderer consume exactly this data.
 */
export const BOX_STRIDE = 16
// layout: px py pz | qx qy qz qw | sx sy sz | r g b | material | alpha | seed
export const Mat = {
  Plastic: 0,
  Studs: 1, // studded top face
  Glow: 2, // emissive
  Rock: 3, // island rock: grass top, noisy sides
  Smooth: 4, // no outline (characters, particles)
} as const

export class BoxList {
  data: Float32Array
  count = 0
  constructor(public capacity: number) {
    this.data = new Float32Array(capacity * BOX_STRIDE)
  }
  clear() {
    this.count = 0
  }
  /** Returns the base float offset of the new instance, or -1 if full. */
  push(
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    sx: number, sy: number, sz: number,
    r: number, g: number, b: number,
    mat: number, alpha = 1, seed = 0,
  ) {
    if (this.count >= this.capacity) return -1
    const o = this.count++ * BOX_STRIDE, d = this.data
    d[o] = px; d[o + 1] = py; d[o + 2] = pz
    d[o + 3] = qx; d[o + 4] = qy; d[o + 5] = qz; d[o + 6] = qw
    d[o + 7] = sx; d[o + 8] = sy; d[o + 9] = sz
    d[o + 10] = r; d[o + 11] = g; d[o + 12] = b
    d[o + 13] = mat; d[o + 14] = alpha; d[o + 15] = seed
    return o
  }
}

export interface MeshData {
  /** interleaved per vertex: px py pz nx ny nz r g b glow (10 floats) */
  verts: Float32Array
  triCount: number
  radius: number
}

export interface MeshDraw {
  mesh: string
  m: Float32Array // column-major model matrix
  tint: number[] | null // replaces near-white vertex colours
  alpha: number
}

export interface Environment {
  skyTop: number[]
  skyHorizon: number[]
  ground: number[] // ambient from below
  sunDir: number[] // normalized, pointing towards the sun
  sunColor: number[]
  fogNear: number
  fogFar: number
}

export interface Frame {
  cam: Camera
  env: Environment
  time: number
  /** world bricks (persistent buffer, only dirty ranges change) */
  bricks: Float32Array
  brickCount: number
  brickDirtyMin: number // instance index range [min, max) that changed since last frame
  brickDirtyMax: number
  /** per brick bitmask of faces fully hidden by neighbours (CPU renderer optimisation) */
  brickHidden: Uint8Array
  dyn: BoxList // opaque per-frame boxes
  dynAlpha: BoxList // translucent per-frame boxes
  meshes: MeshDraw[]
  alphaMeshes: MeshDraw[]
}

export interface Renderer {
  readonly kind: 'webgl' | 'cpu'
  readonly label: string
  /** css size of the canvas, and the internal resolution scale */
  resize(cssW: number, cssH: number, scale: number): void
  render(f: Frame): void
  destroy(): void
}

export const ENV: Environment = {
  skyTop: [0.24, 0.47, 0.86],
  skyHorizon: [0.70, 0.83, 0.95],
  ground: [0.36, 0.33, 0.30],
  sunDir: normalize([0.45, 0.8, 0.35]),
  sunColor: [1.0, 0.95, 0.85],
  fogNear: 90,
  fogFar: 290,
}

function normalize(v: number[]) {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}
