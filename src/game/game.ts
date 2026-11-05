import { Audio } from '../engine/audio'
import { Input } from '../engine/input'
import { Camera, clamp, mat4FromQPS, qYaw, quat } from '../engine/math'
import { CpuRenderer } from '../render/cpu'
import { BOX_STRIDE, BoxList, ENV, Mat, type Environment, type Frame, type Renderer } from '../render/scene'
import { WebGLRenderer } from '../render/webgl'
import { Net, PF, PS, decodeBricks, encodeBricks, fromB64, netOptions, toB64, type PeerInfo } from '../net/net'
import { Hud, esc, teamCss, type ScoreRow, type TeamStatus } from '../ui/hud'
import { avatarParts, drawAvatar, type Pose } from './avatar'
import { BOMB, BUILD, P, PELLET, ROCKET, SWORD, TOOL, TOOLS, VOID_Y } from './constants'
import { Effects } from './effects'
import { TEAM_INFO, buildMap, type GameMap } from './map'
import { LocalPlayer } from './player'
import { Projectiles, eulerYP, type Proj, type Target } from './projectiles'
import { RemotePlayer } from './remote'
import { ALIVE, BUILT, RELEASED, World, type RayHit } from './world'

export interface Settings {
  renderer: 'auto' | 'webgl' | 'cpu'
  quality: 'low' | 'medium' | 'high'
  dynres: boolean
  fps: boolean
  volume: number
  sens: number
}

const STEP = 1 / 60
const STATE_HZ = 20
const SNAP_HZ = 15
const CONNECT_WAIT = 2.5
type Json = Record<string, unknown>

export class Game {
  map: GameMap = buildMap()
  world: World
  me = new LocalPlayer()
  remotes = new Map<string, RemotePlayer>()
  proj: Projectiles
  fx: Effects
  net = new Net()
  hud = new Hud()
  audio = new Audio()
  input: Input
  cam = new Camera()
  renderer!: Renderer
  env: Environment = { ...ENV }

  // round state (authoritative on the host, mirrored elsewhere)
  round = 1
  roundState: 'play' | 'end' = 'play'
  winner = -1
  endAt = 0
  cores = [true, true, true, true]

  name = 'Player'
  time = 0
  zoom = 13
  dynScale = 1
  fpsShown = 0
  teamChosen = false
  chatOpen = false
  paused = false
  pickingTeam = false
  onPause: (p: boolean) => void = () => {}

  private frame: Frame
  private matPool: Float32Array[] = []
  private acc = 0
  private last = 0
  private stateTimer = 0
  private snapTimer = 0
  private roundTimer = 0
  private seq = 0
  private swingCount = 0
  private projCount = 0
  private moved = new Set<number>()
  private removed: number[] = []
  private joinTime = 0
  private frames = 0
  private fpsTimer = 0
  private hit: RayHit = { dist: 0, brick: -1, nx: 0, ny: 0, nz: 0 }
  private camPos = { x: 0, y: 30, z: 60 }
  private proj2 = { x: 0, y: 0, d: 0 }
  private q = quat()
  private targets: Target[] = []
  private raf = 0
  private bg: Worker | null = null

  constructor(public settings: Settings, private stage: HTMLElement) {
    this.world = new World(this.map, true)
    this.me.attach(this.world)
    this.proj = new Projectiles(this.world)
    this.fx = new Effects(this.world)
    this.frame = {
      cam: this.cam, env: this.env, time: 0,
      bricks: this.world.inst, brickCount: this.world.cap, brickDirtyMin: 0, brickDirtyMax: this.world.cap,
      brickHidden: this.world.hidden,
      dyn: new BoxList(6000), dynAlpha: new BoxList(256), meshes: [], alphaMeshes: [],
    }
    this.makeRenderer()
    this.input = new Input(this.stage)
    this.applySettings()
    this.wireProjectiles()
    this.wireNet()
    this.hud.onToolClick = i => this.selectTool(i)
    addEventListener('resize', () => this.resize())
    document.addEventListener('pointerlockchange', () => this.onLockChange())
    this.bindTouch()
  }

  // ------------------------------------------------------------------ setup

  makeRenderer() {
    this.renderer?.destroy()
    this.stage.querySelector('canvas')?.remove()
    let canvas = document.createElement('canvas')
    this.stage.appendChild(canvas)
    let r: Renderer | null = null
    if (this.settings.renderer !== 'cpu') {
      r = WebGLRenderer.create(canvas, this.settings.quality === 'high')
      if (!r) console.warn('WebGL unavailable or software-only; using the CPU renderer')
    }
    if (!r) {
      canvas.remove()
      canvas = document.createElement('canvas')
      this.stage.appendChild(canvas)
      r = new CpuRenderer(canvas)
    }
    this.renderer = r
    this.world.dirtyMin = 0
    this.world.dirtyMax = this.world.cap
    this.dynScale = 1
    this.resize()
  }

  applySettings() {
    const s = this.settings
    this.audio.setVolume(s.volume)
    this.input.sensitivity = s.sens
    const q = s.quality
    this.fx.maxParticles = q === 'low' ? 100 : q === 'medium' ? 220 : 400
    this.env.fogFar = this.renderer.kind === 'cpu' ? (q === 'high' ? 240 : 190) : q === 'low' ? 220 : 290
    this.env.fogNear = this.env.fogFar * 0.3
    this.cam.far = this.env.fogFar + 20
    this.resize()
  }

  resize() {
    const w = innerWidth, h = innerHeight
    this.cam.aspect = w / h
    let scale: number
    const dpr = devicePixelRatio || 1
    const q = this.settings.quality
    if (this.renderer.kind === 'webgl') {
      const base = q === 'low' ? 0.6 : q === 'medium' ? Math.min(dpr, 1) : Math.min(dpr, 1.75)
      scale = base * this.dynScale
    } else {
      const target = q === 'low' ? 240 : q === 'medium' ? 320 : 448
      scale = (Math.min(target, w) / w) * this.dynScale
    }
    this.renderer.resize(w, h, scale)
  }

  // ------------------------------------------------------------------ lifecycle

  start(roomId: string, name: string) {
    this.name = name
    this.audio.unlock()
    this.joinTime = this.time
    this.net.me = () => ({ name: this.name, team: this.me.team })
    const ok = this.net.join(roomId, netOptions(location.search))
    this.hud.show(true)
    this.hud.chat('', ok ? `Joined room "${roomId}". Share the invite link to play with friends.` : 'Offline: P2P is unavailable in this browser.', '', true)
    this.last = performance.now()
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop)
      this.tick(t)
    }
    this.raf = requestAnimationFrame(loop)
    // Browsers pause requestAnimationFrame in hidden tabs. A worker timer keeps the
    // simulation and networking alive (important when we're the brick host).
    const src = 'setInterval(() => postMessage(0), 50)'
    this.bg = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    this.bg.onmessage = () => { if (document.hidden) this.tick(performance.now()) }
  }

  stop() {
    cancelAnimationFrame(this.raf)
    this.bg?.terminate()
    this.net.leave()
  }

  private tick(tms: number) {
    const dt = clamp((tms - this.last) / 1000, 0, 0.1)
    this.last = tms
    this.time += dt
    this.handleKeys()

    this.acc += dt
    let steps = 0
    while (this.acc >= STEP && steps < 4) {
      this.fixed(STEP)
      this.acc -= STEP
      steps++
    }
    if (steps === 4) this.acc = 0

    const now = performance.now()
    for (const r of this.remotes.values()) r.update(now, dt)
    if (!this.net.isHost) this.world.smooth(dt)
    this.fx.update(dt)
    this.updateCamera()
    if (!document.hidden) this.draw()
    this.netTick(dt)
    this.hudTick(dt)
    this.input.endFrame()
  }

  // ------------------------------------------------------------------ simulation

  private fixed(dt: number) {
    const me = this.me, inp = this.input
    // auto-pick a team once we've had a moment to discover peers
    if (!this.teamChosen && this.time - this.joinTime > CONNECT_WAIT) this.autoTeam()

    if (me.alive) {
      const active = inp.locked && !this.chatOpen && !this.paused && !this.pickingTeam
      let mx = 0, mz = 0, jump = false
      if (active) {
        mx = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0) + inp.moveX
        mz = (inp.down('KeyW') ? 1 : 0) - (inp.down('KeyS') ? 1 : 0) - inp.moveY
        jump = inp.down('Space') || inp.touchJump
      }
      if (me.move(dt, mx, mz, jump)) this.audio.play('jump', undefined, 0.6)
      me.lastAttack += dt
      if (active && (inp.fire || inp.firePressed)) this.useTool()
      // regen
      if (this.time - me.lastHurt > P.regenDelay && me.hp < P.maxHp) me.hp = Math.min(P.maxHp, me.hp + P.regen * dt)
      if (me.y < VOID_Y) {
        const recent = this.time - me.lastHurt < 8 ? me.lastHitBy : ''
        this.die(recent, -1)
      }
    } else if (this.teamChosen && this.time >= me.respawnAt && this.roundState === 'play' && this.cores[me.team]) {
      this.respawn()
    }

    this.world.phys.step()

    if (this.net.isHost) {
      const movedNow: number[] = []
      this.world.syncFromPhysics(movedNow, this.removed)
      for (const i of movedNow) this.moved.add(i)
    }

    // projectile targets: everyone alive
    const t = this.targets
    t.length = 0
    if (me.alive) t.push({ id: this.net.selfId, x: me.x, y: me.y, z: me.z, team: me.team, alive: true })
    for (const r of this.remotes.values()) if (r.alive) t.push({ id: r.id, x: r.x, y: r.y, z: r.z, team: r.team, alive: true })
    this.proj.step(dt, t)
    // rocket smoke
    for (const p of this.proj.list) {
      if (p.kind === TOOL.Rocket && !p.waiting && Math.random() < 0.6) this.fx.spawn(p.x, p.y, p.z, 0, 1, 0, 0.6, 0.45, [0.8, 0.8, 0.8], -2)
    }

    if (this.net.isHost) {
      this.roundTimer -= dt
      if (this.roundTimer <= 0) {
        this.roundTimer = 0.25
        this.hostRound()
      }
    }
  }

  private autoTeam() {
    this.teamChosen = true
    const counts = [0, 0, 0, 0]
    for (const r of this.remotes.values()) counts[r.team]++
    for (const p of this.net.peers.values()) if (!this.remotes.has(p.id)) counts[p.team]++
    let best: number[] = []
    let min = Infinity
    for (let t = 0; t < 4; t++) {
      if (!this.cores[t]) continue
      if (counts[t] < min) { min = counts[t]; best = [t] } else if (counts[t] === min) best.push(t)
    }
    if (!best.length) best = [0]
    this.me.team = best[Math.floor(Math.random() * best.length)]
    this.net.hello()
    if (this.roundState === 'play' && this.cores[this.me.team]) this.respawn()
  }

  setTeam(t: number) {
    if (t === this.me.team && this.teamChosen) return
    this.teamChosen = true
    this.me.team = t
    if (this.me.alive) {
      this.me.alive = false
      this.me.respawnAt = this.time + 1
    } else this.me.respawnAt = Math.min(this.me.respawnAt, this.time + 1)
    this.net.hello()
    this.hud.chat('', `You joined ${TEAM_INFO[t].name}.`, '', true)
  }

  private respawn() {
    const me = this.me, sp = this.map.teams[me.team].spawn
    const a = Math.random() * Math.PI * 2, r = Math.random() * 3
    me.teleport(sp.x + Math.cos(a) * r, sp.y + 0.2, sp.z + Math.sin(a) * r)
    me.yaw = sp.yaw
    me.pitch = -0.12
    me.hp = P.maxHp
    me.alive = true
    me.shieldUntil = this.time + P.shield
    me.lastHurt = -99
    me.lastHitBy = ''
    me.cooldownUntil.fill(0)
  }

  private die(by: string, tool: number) {
    const me = this.me
    if (!me.alive) return
    me.alive = false
    me.hp = 0
    me.deaths++
    me.respawnAt = this.time + P.respawn
    this.fx.shatter(avatarParts(this.myPose()), me.vx, me.vy, me.vz)
    this.audio.play('death')
    this.net.event({ k: 'died', by, tool })
    this.killFeed(by, this.net.selfId, tool)
  }

  private hurt(dmg: number, by: string, kx: number, ky: number, kz: number, tool: number) {
    const me = this.me
    if (!me.alive) return
    me.vx += kx; me.vy += ky; me.vz += kz
    if (ky > 0) me.grounded = false
    if (this.time < me.shieldUntil || dmg <= 0) return
    me.hp -= dmg
    me.lastHurt = this.time
    if (by) me.lastHitBy = by
    this.audio.play('hit')
    if (me.hp <= 0) this.die(by, tool)
  }

  private selectTool(i: number) {
    if (i < 0 || i >= TOOLS.length || i === this.me.tool) return
    this.me.tool = i
    this.audio.play('click', undefined, 0.6)
  }

  /** Where the crosshair points: first brick or player along the camera ray. */
  private aimPoint(out: { x: number; y: number; z: number }) {
    const c = this.cam
    let d = 400
    if (this.world.raycast(c.pos.x, c.pos.y, c.pos.z, c.fwd.x, c.fwd.y, c.fwd.z, 400, this.hit)) d = this.hit.dist
    for (const r of this.remotes.values()) {
      if (!r.alive) continue
      // ray vs player sphere approx
      const px = r.x - c.pos.x, py = r.y + 2.4 - c.pos.y, pz = r.z - c.pos.z
      const t = px * c.fwd.x + py * c.fwd.y + pz * c.fwd.z
      if (t < 0 || t > d) continue
      const ex = px - c.fwd.x * t, ey = py - c.fwd.y * t, ez = pz - c.fwd.z * t
      if (ex * ex + ey * ey * 0.35 + ez * ez < 1.4) d = t
    }
    out.x = c.pos.x + c.fwd.x * d; out.y = c.pos.y + c.fwd.y * d; out.z = c.pos.z + c.fwd.z * d
    return d
  }

  private muzzle(out: { x: number; y: number; z: number }) {
    const me = this.me, s = Math.sin(me.yaw), c = Math.cos(me.yaw)
    out.x = me.x + c * 1.5 - s * 2.0
    out.y = me.y + 3.9 + Math.sin(me.pitch) * 1.5
    out.z = me.z - s * 1.5 - c * 2.0
  }

  private useTool() {
    const me = this.me, tool = me.tool
    if (this.time < me.cooldownUntil[tool]) return
    if (this.roundState === 'end') return
    const aim = { x: 0, y: 0, z: 0 }, mz = { x: 0, y: 0, z: 0 }
    const dist = this.aimPoint(aim)
    this.muzzle(mz)
    let dx = aim.x - mz.x, dy = aim.y - mz.y, dz = aim.z - mz.z
    let l = Math.hypot(dx, dy, dz)
    if (dist < 3 || l < 1) { dx = this.cam.fwd.x; dy = this.cam.fwd.y; dz = this.cam.fwd.z; l = 1 }
    dx /= l; dy /= l; dz /= l
    me.cooldownUntil[tool] = this.time + TOOLS[tool].cooldown
    me.lastAttack = 0
    this.swingCount++

    if (tool === TOOL.Sword) {
      this.audio.play('swing')
      this.melee()
      return
    }
    if (tool === TOOL.Build) {
      this.tryBuild()
      return
    }
    let v: number[]
    if (tool === TOOL.Rocket) v = [dx * ROCKET.speed, dy * ROCKET.speed, dz * ROCKET.speed]
    else if (tool === TOOL.Bomb) v = [dx * BOMB.speed + me.vx * 0.5, dy * BOMB.speed + BOMB.up, dz * BOMB.speed + me.vz * 0.5]
    else v = [dx * PELLET.speed, dy * PELLET.speed, dz * PELLET.speed]
    const id = `${this.net.selfId}:${++this.projCount}`
    const e = { k: 'fire', id, tool, team: me.team, o: [mz.x, mz.y, mz.z], v }
    this.spawnProjectile(e, this.net.selfId)
    this.net.event(e)
  }

  private spawnProjectile(e: Json, owner: string) {
    const o = e.o as number[], v = e.v as number[], tool = Number(e.tool)
    if (!Array.isArray(o) || !Array.isArray(v) || ![TOOL.Rocket, TOOL.Bomb, TOOL.Sling].includes(tool as 1)) return
    this.proj.add({ id: String(e.id), kind: tool, owner, team: Number(e.team) | 0, x: o[0], y: o[1], z: o[2], vx: v[0], vy: v[1], vz: v[2] })
    const pos = { x: o[0], y: o[1], z: o[2] }
    this.audio.play(tool === TOOL.Rocket ? 'launch' : tool === TOOL.Bomb ? 'bombThrow' : 'pellet', pos)
  }

  private melee() {
    const me = this.me, fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw)
    for (const r of this.remotes.values()) {
      if (!r.alive || r.team === me.team) continue
      const dx = r.x - me.x, dz = r.z - me.z, dy = r.y - me.y
      const d = Math.hypot(dx, dz)
      if (d > SWORD.range || Math.abs(dy) > 4.5) continue
      if (d > 1 && (dx * fx + dz * fz) / d < 0.25) continue
      this.net.event({ k: 'hit', to: r.id, dmg: SWORD.damage, kb: [fx * SWORD.knock, 12, fz * SWORD.knock], tool: TOOL.Sword }, r.id)
      this.hud.hitmarker()
      this.audio.play('hit', { x: r.x, y: r.y, z: r.z }, 0.7)
    }
  }

  private tryBuild() {
    const c = this.cam
    if (!this.world.raycast(c.pos.x, c.pos.y, c.pos.z, c.fwd.x, c.fwd.y, c.fwd.z, BUILD.range + this.zoom, this.hit) || this.hit.ny < 0.6) {
      this.me.cooldownUntil[TOOL.Build] = this.time + 0.2
      return
    }
    const px = c.pos.x + c.fwd.x * this.hit.dist, py = c.pos.y + c.fwd.y * this.hit.dist, pz = c.pos.z + c.fwd.z * this.hit.dist
    const axis = Math.abs(c.fwd.x) > Math.abs(c.fwd.z) ? 2 : 0
    const req = { k: 'build', p: [px, py, pz], axis, team: this.me.team }
    if (this.net.isHost) this.hostBuild(req)
    else this.net.event(req, this.net.hostId)
    this.audio.play('build', { x: px, y: py, z: pz })
  }

  // ------------------------------------------------------------------ host duties

  private hostBuild(e: Json) {
    const p = e.p as number[], axis = Number(e.axis) === 2 ? 2 : 0, team = clamp(Number(e.team) | 0, 0, 3)
    if (!Array.isArray(p) || p.some(v => !Number.isFinite(v))) return
    const w = this.world
    const by = Math.abs(p[1] - Math.round(p[1])) < 0.3 ? Math.round(p[1]) : p[1]
    const cx = Math.floor(p[0]) + 0.5, cz = Math.floor(p[2]) + 0.5
    const tc = TEAM_INFO[team].color
    const pattern = [[4, 4], [2, 4, 2], [4, 4]]
    const made: number[][] = []
    pattern.forEach((row, l) => {
      let s = -4
      for (const len of row) {
        const m = s + len / 2
        s += len
        const x = axis === 0 ? cx + m : cx, z = axis === 2 ? cz + m : cz
        const sx = axis === 0 ? len : 1, sz = axis === 2 ? len : 1, y = by + l + 0.5
        if (this.overlapsBrick(x, y, z, sx / 2, 0.5, sz / 2)) continue
        const shade = 0.85 + 0.15 * ((l + made.length) % 2)
        const rgb = [tc[0] * shade, tc[1] * shade, tc[2] * shade]
        const slot = w.nextBuildSlot()
        w.createBrick(slot, x, y, z, sx, 1, sz, rgb)
        made.push([slot, x, y, z, sx, 1, sz, rgb[0], rgb[1], rgb[2]])
      }
    })
    if (!made.length) return
    this.net.hostEvent({ k: 'mk', b: made })
    for (const i of w.checkSupport()) this.moved.add(i)
  }

  private overlapsBrick(x: number, y: number, z: number, hx: number, hy: number, hz: number) {
    const w = this.world, d = w.inst
    for (let i = 0; i < w.cap; i++) {
      if (!(w.flags[i] & ALIVE)) continue
      const o = i * BOX_STRIDE
      if (Math.abs(d[o] - x) < hx + w.half[i * 3] - 0.05 && Math.abs(d[o + 1] - y) < hy + w.half[i * 3 + 1] - 0.05 &&
        Math.abs(d[o + 2] - z) < hz + w.half[i * 3 + 2] - 0.05) return true
    }
    return false
  }

  private hostBoom(p: Proj, x: number, y: number, z: number, radius: number, power: number, damage: number) {
    const rel = this.world.explode(x, y, z, radius, power)
    for (const i of rel) this.moved.add(i)
    const e = { k: 'boom', id: p.id, p: [x, y, z], r: radius, dmg: damage, pw: power, owner: p.owner, tool: p.kind }
    this.net.hostEvent(e)
    this.applyBoom(e)
  }

  /** Everyone: effects + damage/knockback to our own character. */
  private applyBoom(e: Json) {
    const p = e.p as number[]
    if (!Array.isArray(p)) return
    const [x, y, z] = p, r = Number(e.r) || 6, owner = String(e.owner ?? '')
    this.proj.detonated(String(e.id))
    this.fx.explosion(x, y, z, r)
    this.audio.play('boom', { x, y, z })
    const me = this.me
    if (!me.alive) return
    const cx = me.x - x, cy = me.y + 2.4 - y, cz = me.z - z
    const d = Math.hypot(cx, cy, cz)
    const reach = r * 1.25
    if (d > reach) return
    const fall = 1 - d / reach
    const k = (Number(e.pw) || 30) * fall * 1.1 / Math.max(d, 0.5)
    const self = owner === this.net.selfId
    const ownerTeam = self ? me.team : this.remotes.get(owner)?.team ?? -1
    let dmg = d < r ? (Number(e.dmg) || 100) * (0.25 + 0.75 * (1 - d / r)) : 0
    if (self) dmg *= 0.35
    else if (ownerTeam === me.team) dmg = 0
    this.hurt(dmg, self ? '' : owner, cx * k, cy * k + 14 * fall, cz * k, Number(e.tool) | 0)
  }

  private hostRound() {
    let changed = false
    this.map.teams.forEach((t, i) => {
      if (this.cores[i] && this.world.coreLost(t.coreBrick)) {
        this.cores[i] = false
        changed = true
        this.announceCore(i)
      }
    })
    const st = this.teamStatus()
    const inPlay = st.map((s, i) => (s.players ? i : -1)).filter(i => i >= 0)
    const alive = inPlay.filter(i => st[i].alive)
    if (this.roundState === 'play' && this.teamChosen) {
      if ((inPlay.length >= 2 && alive.length <= 1) || (inPlay.length >= 1 && alive.length === 0)) {
        this.roundState = 'end'
        this.winner = inPlay.length >= 2 ? (alive[0] ?? -1) : -1
        this.endAt = this.time + 8
        changed = true
        this.onRoundEnd()
      }
    } else if (this.roundState === 'end' && this.time >= this.endAt) {
      const next = this.round + 1
      this.net.hostEvent({ k: 'reset', round: next })
      this.resetRound(next)
      changed = true
    }
    if (changed) this.net.hostEvent(this.roundMsg())
  }

  private roundMsg(): Json {
    return { k: 'round', round: this.round, state: this.roundState, winner: this.winner, cores: this.cores, left: Math.max(0, this.endAt - this.time) }
  }

  private applyRound(e: Json) {
    const wasPlay = this.roundState === 'play'
    const cores = e.cores as boolean[]
    if (Array.isArray(cores)) cores.forEach((c, i) => {
      if (this.cores[i] && !c) this.announceCore(i)
      this.cores[i] = !!c
    })
    this.roundState = e.state === 'end' ? 'end' : 'play'
    this.winner = Number(e.winner)
    this.endAt = this.time + (Number(e.left) || 0)
    if (wasPlay && this.roundState === 'end') this.onRoundEnd()
  }

  private announceCore(t: number) {
    this.hud.feed(`<span style="color:${teamCss(t)}">${TEAM_INFO[t].name}</span>'s core has fallen!`)
    this.audio.play('boom', undefined, 0.4)
  }

  private onRoundEnd() {
    if (this.winner === this.me.team && this.winner >= 0) this.audio.play('win')
  }

  private resetRound(round: number) {
    this.round = round
    this.roundState = 'play'
    this.winner = -1
    this.cores = [true, true, true, true]
    this.fx.clear()
    this.proj.clear()
    this.me.detach()
    this.world.reset()
    this.me.attach(this.world)
    this.moved.clear()
    this.removed.length = 0
    if (this.teamChosen) this.respawn()
  }

  private fullState(): Json {
    const w = this.world
    const removed: number[] = [], built: number[][] = [], rel: number[] = []
    for (let i = 0; i < w.cap; i++) {
      const f = w.flags[i]
      if (i < w.n && !(f & ALIVE)) removed.push(i)
      if (!(f & ALIVE)) continue
      if (f & BUILT) {
        const o = i * BOX_STRIDE, d = w.inst
        built.push([i, w.home[i * 3], w.home[i * 3 + 1], w.home[i * 3 + 2], w.half[i * 3] * 2, w.half[i * 3 + 1] * 2, w.half[i * 3 + 2] * 2, d[o + 10], d[o + 11], d[o + 12]])
      }
      if (f & RELEASED) rel.push(i)
    }
    return { ...this.roundMsg(), k: 'full', removed, built, snap: toB64(encodeBricks(rel, w.inst, BOX_STRIDE)), builtNext: w.builtNext }
  }

  private applyFull(e: Json) {
    this.resetRound(Number(e.round) || 1)
    const w = this.world
    const removed = e.removed as number[], built = e.built as number[][]
    if (Array.isArray(removed)) for (const i of removed) w.remove(i)
    if (Array.isArray(built)) for (const b of built) w.createBrick(b[0], b[1], b[2], b[3], b[4], b[5], b[6], [b[7], b[8], b[9]])
    w.builtNext = Number(e.builtNext) || 0
    if (typeof e.snap === 'string') decodeBricks(fromB64(e.snap), (i, x, y, z, qx, qy, qz, qw) => w.applyRemote(i, x, y, z, qx, qy, qz, qw))
    this.applyRound(e)
  }

  // ------------------------------------------------------------------ networking

  private wireProjectiles() {
    const pr = this.proj
    pr.onRocketImpact = (p, x, y, z) => {
      if (this.net.isHost) this.hostBoom(p, x, y, z, ROCKET.radius, ROCKET.power, ROCKET.damage)
    }
    pr.onBombFuse = p => {
      if (this.net.isHost) this.hostBoom(p, p.x, p.y, p.z, BOMB.radius, BOMB.power, BOMB.damage)
    }
    pr.onPelletPlayer = (p, target) => {
      if (p.owner !== this.net.selfId) return
      const l = Math.hypot(p.vx, p.vz) || 1
      this.net.event({ k: 'hit', to: target, dmg: PELLET.damage, kb: [(p.vx / l) * 8, 4, (p.vz / l) * 8], tool: TOOL.Sling }, target)
      this.hud.hitmarker()
    }
    pr.onPelletBrick = (p, brick) => {
      this.audio.play('pellet', p, 0.5)
      if (this.net.isHost) this.world.nudge(brick, p.vx * 0.03, p.vy * 0.03, p.vz * 0.03)
    }
  }

  private wireNet() {
    const n = this.net
    n.onHello = (p: PeerInfo, isNew: boolean) => {
      let r = this.remotes.get(p.id)
      if (!r) {
        r = new RemotePlayer(p.id)
        this.remotes.set(p.id, r)
      }
      r.name = p.name
      r.team = p.team
      if (isNew) {
        this.hud.chat('', `${p.name} joined.`, '', true)
        this.net.hello(p.id) // make sure they know us even if our first hello raced their join
      }
      if (n.isHost && isNew) n.full(this.fullState(), p.id)
    }
    n.onLeave = id => {
      const r = this.remotes.get(id)
      if (r) this.hud.chat('', `${r.name} left.`, '', true)
      this.remotes.delete(id)
      this.hud.dropTag(id)
    }
    n.onHostChange = (now, old) => {
      if (now === n.selfId) {
        this.world.promote()
        this.moved.clear()
        if (old !== n.selfId) this.hud.chat('', 'You are now hosting the bricks.', '', true)
        this.net.hostEvent(this.roundMsg())
      } else if (old === n.selfId) {
        this.world.demote()
      }
    }
    n.onState = (buf, from) => {
      const r = this.remotes.get(from)
      if (!r || buf.byteLength < 64) return
      const s = new Float32Array(buf.slice(0, 64))
      const wasAlive = r.alive
      r.push(s, performance.now())
      if (!wasAlive && (s[PS.FLAGS] & PF.Alive)) r.buf.length = 0, r.push(s, performance.now())
    }
    n.onEvent = (e, from) => this.onPeerEvent(e, from)
    n.onHostSnap = buf => decodeBricks(buf, (i, x, y, z, qx, qy, qz, qw) => this.world.applyRemote(i, x, y, z, qx, qy, qz, qw))
    n.onHostEvent = e => this.onHostEvent(e)
    n.onFull = e => this.applyFull(e)
  }

  private onPeerEvent(e: Json, from: string) {
    const r = this.remotes.get(from)
    switch (e.k) {
      case 'fire':
        this.spawnProjectile(e, from)
        break
      case 'hit':
        if (e.to !== this.net.selfId) break
        if (r && r.team === this.me.team) break
        {
          const kb = (e.kb as number[]) ?? [0, 0, 0]
          this.hurt(clamp(Number(e.dmg) || 0, 0, 100), from, kb[0] || 0, kb[1] || 0, kb[2] || 0, Number(e.tool) | 0)
        }
        break
      case 'died':
        if (r) {
          this.fx.shatter(avatarParts(this.remotePose(r)), r.vx, 5, r.vz)
          this.audio.play('death', r, 0.7)
          r.alive = false
          r.buf.length = 0
        }
        if (e.by === this.net.selfId && from !== this.net.selfId) {
          this.me.kills++
          this.hud.hitmarker()
        }
        this.killFeed(String(e.by ?? ''), from, Number(e.tool))
        break
      case 'chat':
        if (r) this.hud.chat(r.name, String(e.msg ?? '').slice(0, 120), teamCss(r.team))
        break
      case 'build':
        if (this.net.isHost) this.hostBuild(e)
        break
    }
  }

  private onHostEvent(e: Json) {
    const w = this.world
    switch (e.k) {
      case 'boom':
        this.applyBoom(e)
        break
      case 'rm':
        if (Array.isArray(e.ids)) for (const i of e.ids as number[]) w.remove(i)
        break
      case 'mk':
        if (Array.isArray(e.b)) for (const b of e.b as number[][]) w.createBrick(b[0], b[1], b[2], b[3], b[4], b[5], b[6], [b[7], b[8], b[9]])
        break
      case 'round':
        this.applyRound(e)
        break
      case 'reset':
        this.resetRound(Number(e.round) || this.round + 1)
        break
    }
  }

  private netTick(dt: number) {
    const n = this.net
    this.stateTimer -= dt
    if (this.stateTimer <= 0) {
      this.stateTimer = 1 / STATE_HZ
      const me = this.me, s = new Float32Array(16)
      s[PS.X] = me.x; s[PS.Y] = me.y; s[PS.Z] = me.z
      s[PS.VX] = me.vx; s[PS.VY] = me.vy; s[PS.VZ] = me.vz
      s[PS.YAW] = me.yaw; s[PS.PITCH] = me.pitch
      s[PS.HP] = me.hp; s[PS.TOOL] = me.tool
      s[PS.FLAGS] = (me.alive ? PF.Alive : 0) | (me.grounded ? PF.Grounded : 0) | (this.time < me.shieldUntil ? PF.Shield : 0)
      s[PS.TEAM] = me.team; s[PS.KILLS] = me.kills; s[PS.DEATHS] = me.deaths
      s[PS.SWING] = this.swingCount; s[PS.SEQ] = ++this.seq
      n.state(s.buffer)
    }
    if (!n.isHost) return
    this.snapTimer -= dt
    if (this.snapTimer <= 0) {
      this.snapTimer = 1 / SNAP_HZ
      if (this.moved.size) {
        const ids: number[] = []
        for (const i of this.moved) {
          if (ids.length >= 400) break
          this.moved.delete(i)
          if (this.world.flags[i] & ALIVE) ids.push(i)
        }
        if (ids.length) n.hostSnap(encodeBricks(ids, this.world.inst, BOX_STRIDE))
      }
      if (this.removed.length) {
        n.hostEvent({ k: 'rm', ids: this.removed.splice(0) })
      }
    }
  }

  // ------------------------------------------------------------------ input & UI

  private handleKeys() {
    const inp = this.input, me = this.me
    if (this.chatOpen || this.pickingTeam) return
    for (let i = 0; i < TOOLS.length; i++) if (inp.pressed.has(`Digit${i + 1}`)) this.selectTool(i)
    if (inp.wheel) this.zoom = clamp(this.zoom + inp.wheel * 2, 0, 32)
    if (inp.down('KeyI')) this.zoom = clamp(this.zoom - 0.5, 0, 32)
    if (inp.down('KeyO')) this.zoom = clamp(this.zoom + 0.5, 0, 32)
    if (inp.pressed.has('Enter') || inp.pressed.has('Slash')) this.openChat()
    if (inp.pressed.has('KeyT')) this.openTeamPick()
    if (inp.locked && !this.paused) {
      me.yaw -= inp.lookDX * inp.sensitivity
      me.pitch = clamp(me.pitch - inp.lookDY * inp.sensitivity, -1.45, 1.45)
    }
  }

  openChat() {
    this.chatOpen = true
    const chat = document.getElementById('chat')!, input = document.getElementById('chat-input') as HTMLInputElement
    chat.classList.add('open')
    this.input.unlock()
    input.value = ''
    setTimeout(() => input.focus(), 0)
    const done = (send: boolean) => {
      input.onkeydown = null
      input.onblur = null
      chat.classList.remove('open')
      const msg = input.value.trim()
      if (send && msg) {
        this.net.event({ k: 'chat', msg })
        this.hud.chat(this.name, msg, teamCss(this.me.team))
      }
      input.blur()
      this.chatOpen = false
      this.input.lock()
    }
    input.onkeydown = ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') done(true)
      else if (ev.key === 'Escape') done(false)
    }
    input.onblur = () => this.chatOpen && done(false)
  }

  openTeamPick() {
    this.pickingTeam = true
    this.input.unlock()
    const st = this.teamStatus()
    const list = document.getElementById('team-list')!
    list.innerHTML = ''
    TEAM_INFO.forEach((t, i) => {
      const b = document.createElement('button')
      b.style.background = teamCss(i, 0)
      b.style.color = i === 3 ? '#16181d' : '#fff'
      b.innerHTML = `<span>${t.name}${i === this.me.team ? ' (yours)' : ''}</span><span>${st[i].players} players${this.cores[i] ? '' : ' · core lost'}</span>`
      b.disabled = !this.cores[i]
      b.onclick = () => {
        this.setTeam(i)
        close()
      }
      list.appendChild(b)
    })
    const el = document.getElementById('team-pick')!
    el.classList.remove('hidden')
    const close = () => {
      el.classList.add('hidden')
      this.pickingTeam = false
      this.input.lock()
    }
    document.getElementById('team-cancel')!.onclick = close
  }

  private onLockChange() {
    const locked = document.pointerLockElement === this.stage
    if (!locked && !this.chatOpen && !this.pickingTeam && !this.input.touch) {
      this.paused = true
      this.onPause(true)
    } else if (locked && this.paused) {
      this.paused = false
      this.onPause(false)
    }
  }

  private bindTouch() {
    const inp = this.input
    const fire = document.getElementById('btn-fire')!, jump = document.getElementById('btn-jump')!, menu = document.getElementById('btn-menu')!
    inp.bindButton(fire, () => { inp.fire = true; inp.firePressed = true }, () => { inp.fire = false })
    inp.bindButton(jump, () => { inp.keys.add('Space') }, () => { inp.keys.delete('Space') })
    inp.bindButton(menu, () => {
      this.paused = !this.paused
      this.onPause(this.paused)
    })
  }

  teamStatus(): TeamStatus[] {
    const st: TeamStatus[] = [0, 1, 2, 3].map(i => ({ core: this.cores[i], players: 0, alive: this.cores[i] }))
    const add = (team: number, alive: boolean) => {
      const s = st[team]
      if (!s) return
      s.players++
      if (alive) s.alive = true
    }
    if (this.teamChosen) add(this.me.team, this.me.alive)
    for (const r of this.remotes.values()) add(r.team, r.alive)
    return st
  }

  private killFeed(by: string, victim: string, tool: number) {
    const nm = (id: string) => (id === this.net.selfId ? this.name : this.remotes.get(id)?.name ?? '???')
    const tm = (id: string) => (id === this.net.selfId ? this.me.team : this.remotes.get(id)?.team ?? -1)
    const v = `<span style="color:${teamCss(tm(victim))}">${esc(nm(victim))}</span>`
    if (by && by !== victim) {
      const t = TOOLS[tool]?.name ?? '💥'
      this.hud.feed(`<span style="color:${teamCss(tm(by))}">${esc(nm(by))}</span> [${t}] ${v}`)
    } else this.hud.feed(`${v} fell apart`)
  }

  // ------------------------------------------------------------------ camera & drawing

  private updateCamera() {
    const me = this.me, c = this.cam
    if (me.alive || !this.teamChosen) {
      if (me.alive) {
        me.camera(this.zoom, this.camPos, this.world, this.hit)
        c.yaw = me.yaw
        c.pitch = me.pitch
      } else {
        // pre-spawn flyover
        const a = this.time * 0.05
        this.camPos.x = Math.sin(a) * 120; this.camPos.y = 55; this.camPos.z = Math.cos(a) * 120
        c.yaw = a
        c.pitch = -0.38
      }
    } else {
      // dead: drift up and look around slowly
      this.camPos.y += 0.02
      c.yaw = me.yaw
      c.pitch = me.pitch
    }
    c.pos.x = this.camPos.x; c.pos.y = this.camPos.y; c.pos.z = this.camPos.z
    c.update()
    this.audio.listener = c.pos
  }

  myPose(): Pose {
    const me = this.me
    return {
      x: me.x, y: me.y, z: me.z, yaw: me.yaw, pitch: me.pitch, team: TEAM_INFO[me.team].color,
      walk: me.walk, speed: Math.min(1, Math.hypot(me.vx, me.vz) / P.speed), tool: me.tool, swing: me.lastAttack, alpha: 1,
    }
  }

  private remotePose(r: RemotePlayer): Pose {
    return {
      x: r.x, y: r.y, z: r.z, yaw: r.yaw, pitch: r.pitch, team: TEAM_INFO[r.team]?.color ?? [1, 1, 1],
      walk: r.walk, speed: r.speed, tool: r.tool, swing: (performance.now() - r.swingAt) / 1000, alpha: 1,
    }
  }

  private mat() {
    return this.matPool.pop() ?? new Float32Array(16)
  }

  private draw() {
    const f = this.frame
    // recycle matrices from the previous frame
    for (const m of f.meshes) this.matPool.push(m.m)
    for (const m of f.alphaMeshes) this.matPool.push(m.m)
    f.meshes.length = 0
    f.alphaMeshes.length = 0
    f.dyn.clear()
    f.dynAlpha.clear()
    f.time = this.time
    const pool = this.matPool

    for (const r of this.remotes.values()) {
      if (!r.alive || !r.buf.length) continue
      const pose = this.remotePose(r)
      drawAvatar(f.dyn, f.meshes, pose, false, pool)
      if (r.tool === TOOL.Sword && pose.swing < 0.05 && pose.swing >= 0) this.audio.play('swing', r, 0.8)
      this.shadow(r.x, r.y, r.z, r.yaw)
      if (r.shield) this.shieldBubble(r.x, r.y, r.z, r.team)
    }
    const me = this.me
    if (me.alive) {
      const close = Math.hypot(this.camPos.x - me.x, this.camPos.y - me.y - P.eye, this.camPos.z - me.z) < 2.5
      drawAvatar(f.dyn, f.meshes, this.myPose(), close, pool)
      if (!close) this.shadow(me.x, me.y, me.z, me.yaw)
      if (this.time < me.shieldUntil) this.shieldBubble(me.x, me.y, me.z, me.team)
    }
    this.proj.draw(f.meshes, f.dyn, pool, this.time)
    this.fx.draw(f.dyn, f.alphaMeshes, pool)

    // team banners and floating core crystals
    this.map.teams.forEach((t, i) => {
      const m = this.mat()
      qYaw(t.flag.yaw, this.q)
      mat4FromQPS(this.q, t.flag.x, t.flag.y, t.flag.z, 1.4, m)
      f.meshes.push({ mesh: 'flag', m, tint: t.color, alpha: 1 })
      if (!this.cores[i]) return
      const o = t.coreBrick * BOX_STRIDE, d = this.world.inst
      const m2 = this.mat()
      eulerYP(this.time * 1.2 + i, 0, this.q)
      mat4FromQPS(this.q, d[o], d[o + 1] + 2.6 + Math.sin(this.time * 2 + i) * 0.3, d[o + 2], 1.2, m2)
      f.meshes.push({ mesh: 'core', m: m2, tint: t.color, alpha: 1 })
    })

    f.brickDirtyMin = this.world.dirtyMin
    f.brickDirtyMax = this.world.dirtyMax
    this.renderer.render(f)
    this.world.clearDirty()
  }

  private shadow(x: number, y: number, z: number, yaw: number) {
    if (!this.world.raycast(x, y + 0.5, z, 0, -1, 0, 40, this.hit)) return
    const gy = y + 0.5 - this.hit.dist + 0.04
    const k = clamp(1 - (y - gy) / 30, 0.2, 1)
    qYaw(yaw, this.q)
    this.frame.dynAlpha.push(x, gy, z, this.q.x, this.q.y, this.q.z, this.q.w, 2.6 * k, 0.04, 1.6 * k, 0, 0, 0, Mat.Smooth, 0.3 * k, 0)
  }

  private shieldBubble(x: number, y: number, z: number, team: number) {
    const m = this.mat()
    this.q.x = this.q.y = this.q.z = 0; this.q.w = 1
    mat4FromQPS(this.q, x, y + 2.4, z, 3.3, m)
    this.frame.alphaMeshes.push({ mesh: 'sphere', m, tint: TEAM_INFO[team].color, alpha: 0.18 + 0.06 * Math.sin(this.time * 8) })
  }

  private hudTick(dt: number) {
    const me = this.me, hud = this.hud
    this.frames++
    this.fpsTimer += dt
    if (this.fpsTimer >= 1) {
      const fps = this.frames / this.fpsTimer
      this.fpsShown = Math.round(fps)
      this.frames = 0
      this.fpsTimer = 0
      if (this.settings.dynres && !document.hidden) {
        const old = this.dynScale
        if (fps < 45) this.dynScale = Math.max(0.45, this.dynScale * 0.85)
        else if (fps > 57 && this.dynScale < 1) this.dynScale = Math.min(1, this.dynScale * 1.1)
        if (old !== this.dynScale) this.resize()
      }
    }
    hud.health(me.alive ? me.hp : 0, P.maxHp)
    hud.tools(me.tool, me.cooldownUntil.map((t, i) => clamp((t - this.time) / TOOLS[i].cooldown, 0, 1)))
    hud.teams(this.teamStatus(), this.teamChosen ? me.team : -1)

    // banners
    if (!this.teamChosen) hud.banner('Finding players…', this.net.online ? 'Connecting peer-to-peer' : 'Offline')
    else if (this.roundState === 'end') {
      const left = Math.ceil(Math.max(0, this.endAt - this.time))
      hud.banner(this.winner >= 0 ? `${TEAM_INFO[this.winner].name} wins!` : 'Round over', `Next round in ${left}`)
    } else if (!me.alive) {
      if (!this.cores[me.team]) hud.banner('Your core has fallen', 'Spectating until the round ends (T to switch team)')
      else hud.banner('You fell apart!', `Respawning in ${Math.ceil(Math.max(0, me.respawnAt - this.time))}`)
    } else hud.banner('')

    const n = this.net
    const host = n.isHost ? 'you' : this.remotes.get(n.hostId)?.name ?? '…'
    const players = this.remotes.size + 1
    let txt = `Room ${n.roomId || '-'} · ${players} player${players > 1 ? 's' : ''} · host: ${host}`
    if (this.settings.fps) txt += `\n${this.renderer.label} · ${this.fpsShown} fps · ${Math.round(this.dynScale * 100)}% res`
    hud.net(txt)

    const rows: ScoreRow[] = [{ name: this.name, team: me.team, kills: me.kills, deaths: me.deaths, me: true, host: n.isHost }]
    for (const r of this.remotes.values()) rows.push({ name: r.name, team: r.team, kills: r.kills, deaths: r.deaths, me: false, host: n.hostId === r.id })
    hud.scoreboard(this.input.down('Tab'), rows, n.roomId)

    // name tags
    for (const r of this.remotes.values()) {
      let vis = r.alive && r.buf.length > 0
      if (vis) {
        vis = this.cam.project(r.x, r.y + 5.8, r.z, this.proj2) && this.proj2.d < 110
      }
      hud.nameTag(r.id, r.name, r.team, r.hp, this.proj2.x * innerWidth, this.proj2.y * innerHeight, vis)
    }
    hud.clickToPlay(!this.input.locked && !this.paused && !this.chatOpen && !this.pickingTeam)
  }
}
