import { mat4FromQPS, qAxis, qMul, qRot, qYaw, quat, v3, type Q } from '../engine/math'
import { Mat, type BoxList, type MeshDraw } from '../render/scene'
import { TOOLS } from './constants'

/** Pose needed to draw a character. Both local and remote players produce one. */
export interface Pose {
  x: number; y: number; z: number
  yaw: number
  pitch: number
  team: number[] // torso colour
  walk: number // walk cycle phase
  speed: number // 0..1 of max speed
  tool: number
  swing: number // seconds since last attack (large = idle)
  alpha: number
}

export const SKIN = [0.96, 0.8, 0.62]
export const PANTS = [0.2, 0.22, 0.3]

const qb = quat(), qp = quat(), qq = quat(), qt = quat(), tmp = v3(), tmp2 = v3()
const TOOL_FIX = qAxis(1, 0, 0, -Math.PI / 2)

/**
 * Push one body part. pivot/offset are in body space (feet origin, facing -Z);
 * the part rotates by `rot` around its pivot.
 */
function part(out: BoxList, p: Pose, body: Q, rot: Q, px: number, py: number, pz: number,
  ox: number, oy: number, oz: number, sx: number, sy: number, sz: number, c: number[], seed: number) {
  qRot(rot, ox, oy, oz, tmp)
  qRot(body, px + tmp.x, py + tmp.y, pz + tmp.z, tmp2)
  qMul(body, rot, qt)
  out.push(p.x + tmp2.x, p.y + tmp2.y, p.z + tmp2.z, qt.x, qt.y, qt.z, qt.w, sx, sy, sz, c[0], c[1], c[2], Mat.Smooth, p.alpha, seed)
}

export function drawAvatar(out: BoxList, meshes: MeshDraw[] | null, p: Pose, firstPerson: boolean, matPool: Float32Array[]) {
  qYaw(p.yaw, qb)
  const sw = Math.sin(p.walk) * 0.9 * p.speed
  // legs
  qAxis(1, 0, 0, sw, qp)
  if (!firstPerson) {
    part(out, p, qb, qp, -0.5, 2, 0, 0, -1, 0, 0.98, 2, 1, PANTS, 1)
    qAxis(1, 0, 0, -sw, qp)
    part(out, p, qb, qp, 0.5, 2, 0, 0, -1, 0, 0.98, 2, 1, PANTS, 2)
    // torso + head + face
    qp.x = qp.y = qp.z = 0; qp.w = 1
    part(out, p, qb, qp, 0, 3, 0, 0, 0, 0, 2, 2, 1, p.team, 3)
    qAxis(1, 0, 0, p.pitch * 0.4, qq)
    part(out, p, qb, qq, 0, 4, 0, 0, 0.62, 0, 1.25, 1.25, 1.25, SKIN, 4)
    part(out, p, qb, qq, 0, 4, 0, -0.27, 0.72, -0.63, 0.18, 0.28, 0.04, DARK, 5)
    part(out, p, qb, qq, 0, 4, 0, 0.27, 0.72, -0.63, 0.18, 0.28, 0.04, DARK, 6)
    part(out, p, qb, qq, 0, 4, 0, 0, 0.36, -0.63, 0.52, 0.1, 0.04, DARK, 7)
    // left arm swings opposite the left leg
    qAxis(1, 0, 0, -sw, qp)
    part(out, p, qb, qp, -1.5, 3.85, 0, 0, -0.85, 0, 1, 2, 1, SKIN, 8)
  }
  // right arm holds the tool out front, following the aim pitch
  let armA = Math.PI / 2 + p.pitch * 0.85
  if (p.tool === 0 && p.swing < 0.3) {
    // sword slash: raise then chop
    const t = p.swing / 0.3
    armA = t < 0.3 ? Math.PI / 2 + 1.2 * (t / 0.3) : Math.PI / 2 + 1.2 - 2.0 * ((t - 0.3) / 0.7)
  } else if (p.swing < 0.15) armA += 0.35 * (1 - p.swing / 0.15) // recoil
  qAxis(1, 0, 0, armA, qp)
  part(out, p, qb, qp, 1.5, 3.85, 0, 0, -0.85, 0, 1, 2, 1, firstPerson ? p.team : SKIN, 9)

  if (meshes && p.tool >= 0 && p.tool < TOOLS.length) {
    qRot(qp, 0, -1.85, 0, tmp)
    qRot(qb, 1.5 + tmp.x, 3.85 + tmp.y, tmp.z, tmp2)
    qMul(qb, qp, qt)
    qMul(qt, TOOL_FIX, qq)
    const m = matPool.pop() ?? new Float32Array(16)
    mat4FromQPS(qq, p.x + tmp2.x, p.y + tmp2.y, p.z + tmp2.z, 1, m)
    meshes.push({ mesh: TOOLS[p.tool].mesh, m, tint: null, alpha: 1 })
  }
}

const DARK = [0.12, 0.12, 0.14]

/** World transforms for the six main parts, used to spawn ragdoll debris on death. */
export function avatarParts(p: Pose) {
  qYaw(p.yaw, qb)
  const parts: { x: number; y: number; z: number; q: Q; s: number[]; c: number[] }[] = []
  const add = (x: number, y: number, z: number, s: number[], c: number[]) => {
    qRot(qb, x, y, z, tmp)
    parts.push({ x: p.x + tmp.x, y: p.y + tmp.y, z: p.z + tmp.z, q: { ...qb }, s, c })
  }
  add(-0.5, 1, 0, [0.98, 2, 1], PANTS)
  add(0.5, 1, 0, [0.98, 2, 1], PANTS)
  add(0, 3, 0, [2, 2, 1], p.team)
  add(0, 4.62, 0, [1.25, 1.25, 1.25], SKIN)
  add(-1.5, 3, 0, [1, 2, 1], SKIN)
  add(1.5, 3, 0, [1, 2, 1], SKIN)
  return parts
}
