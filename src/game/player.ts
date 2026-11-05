import RAPIER from '@dimforge/rapier3d-compat'
import { clamp } from '../engine/math'
import { P } from './constants'
import { G_PLAYER, type RayHit, type World } from './world'

/**
 * The player we control. Movement is client-authoritative: a Rapier kinematic
 * character controller handles steps, slopes and collisions with bricks.
 */
export class LocalPlayer {
  x = 0; y = 0; z = 0
  vx = 0; vy = 0; vz = 0
  yaw = 0
  pitch = -0.15
  grounded = false
  hp = P.maxHp
  alive = false
  team = 0
  tool = 0
  kills = 0
  deaths = 0
  lastAttack = 99
  cooldownUntil = [0, 0, 0, 0, 0]
  shieldUntil = 0
  respawnAt = 0
  lastHurt = -99
  lastHitBy = ''
  walk = 0
  spawned = false
  private body: RAPIER.RigidBody | null = null
  private collider: RAPIER.Collider | null = null
  private ctrl: RAPIER.KinematicCharacterController | null = null

  attach(world: World) {
    const phys = world.phys
    this.body = phys.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.x, this.y + P.halfHeight + P.radius, this.z))
    this.collider = phys.createCollider(
      RAPIER.ColliderDesc.capsule(P.halfHeight, P.radius).setCollisionGroups(G_PLAYER).setFriction(0),
      this.body,
    )
    this.ctrl = phys.createCharacterController(0.06)
    this.ctrl.enableAutostep(1.15, 0.3, true)
    this.ctrl.enableSnapToGround(0.6)
    this.ctrl.setMaxSlopeClimbAngle((55 * Math.PI) / 180)
    this.ctrl.setApplyImpulsesToDynamicBodies(true)
    this.ctrl.setCharacterMass(8)
  }

  /** The physics world is being rebuilt; forget handles into it. */
  detach() {
    this.body = null
    this.collider = null
    this.ctrl = null
  }

  get colliderRef() {
    return this.collider
  }

  teleport(x: number, y: number, z: number) {
    this.x = x; this.y = y; this.z = z
    this.vx = this.vy = this.vz = 0
    this.body?.setTranslation({ x, y: y + P.halfHeight + P.radius, z }, true)
  }

  /** mx/mz: desired move in camera space (-1..1); returns true when a jump happened. */
  move(dt: number, mx: number, mz: number, jump: boolean) {
    if (!this.ctrl || !this.collider || !this.body) return false
    // desired horizontal velocity in world space
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw)
    let wx = mx * c - mz * s, wz = -mx * s - mz * c
    const l = Math.hypot(wx, wz)
    if (l > 1) { wx /= l; wz /= l }
    const tx = wx * P.speed, tz = wz * P.speed
    const accel = (this.grounded ? P.accelGround : P.accelAir) * dt
    const dx = tx - this.vx, dz = tz - this.vz
    const dl = Math.hypot(dx, dz)
    if (dl <= accel) { this.vx = tx; this.vz = tz } else { this.vx += (dx / dl) * accel; this.vz += (dz / dl) * accel }

    let jumped = false
    if (jump && this.grounded) {
      this.vy = P.jump
      this.grounded = false
      jumped = true
    }
    this.vy -= P.gravity * dt
    if (this.vy < -120) this.vy = -120

    const want = { x: this.vx * dt, y: this.vy * dt, z: this.vz * dt }
    this.ctrl.computeColliderMovement(this.collider, want, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, G_PLAYER)
    const mv = this.ctrl.computedMovement()
    this.x += mv.x; this.y += mv.y; this.z += mv.z
    this.grounded = this.ctrl.computedGrounded()
    if (this.grounded && this.vy < 0) this.vy = 0
    if (want.y > 0 && mv.y < want.y * 0.5) this.vy = Math.min(this.vy, 0) // bumped head
    // lose horizontal speed into walls so knockback doesn't "stick"
    if (dt > 0) {
      if (Math.abs(mv.x) < Math.abs(want.x) * 0.5) this.vx *= 0.5
      if (Math.abs(mv.z) < Math.abs(want.z) * 0.5) this.vz *= 0.5
    }
    this.body.setNextKinematicTranslation({ x: this.x, y: this.y + P.halfHeight + P.radius, z: this.z })
    const sp = Math.hypot(this.vx, this.vz)
    if (this.grounded) this.walk += sp * dt * 0.45
    return jumped
  }

  /** Third-person camera position with collision against bricks. */
  camera(zoom: number, out: { x: number; y: number; z: number }, world: World, hit: RayHit) {
    const hx = this.x, hy = this.y + P.eye, hz = this.z
    if (zoom < 0.5) {
      out.x = hx; out.y = hy; out.z = hz
      return
    }
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch)
    const fx = -Math.sin(this.yaw) * cp, fy = sp, fz = -Math.cos(this.yaw) * cp
    // over-the-shoulder offset to the right
    const side = clamp(zoom / 6, 0, 1) * 1.6
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw)
    const sx = hx + rx * side, sz = hz + rz * side
    let dx = -fx, dy = -fy, dz = -fz
    const l = Math.hypot(dx, dy, dz)
    dx /= l; dy /= l; dz /= l
    let d = zoom
    if (world.raycast(sx, hy, sz, dx, dy, dz, zoom + 0.5, hit)) d = Math.max(0.3, hit.dist - 0.5)
    out.x = sx + dx * d; out.y = hy + dy * d; out.z = sz + dz * d
  }
}
