import { joinRoom, selfId, type Room } from 'trystero'

/*
 * Fully serverless networking.
 *
 * Peers discover each other through public Nostr relays (Trystero) and then talk
 * directly over WebRTC data channels in a full mesh. Nothing needs to be hosted.
 *
 * One peer acts as the "host" for brick physics and round state. The host is simply
 * the peer that joined the room first (smallest join timestamp, ties broken by id),
 * so every peer computes the same answer locally with no negotiation. When the host
 * leaves, the next oldest peer takes over with the world state it already mirrors.
 */

export const APP_ID = 'brickfall-skyhold-v1'

/**
 * Well-known public Nostr relays used only to exchange WebRTC offers/answers.
 * Trystero's default picks a pseudo-random subset of a long list, which can land on
 * dead relays; a fixed list of reliable ones connects faster. Add your own with
 * ?relay=wss://... in the page URL.
 */
export const RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://offchain.pub',
]

/** Optional overrides from the page URL: ?relay=wss://a,wss://b&turn=turn:host:3478&turnUser=u&turnPass=p */
export function netOptions(search: string) {
  const q = new URLSearchParams(search)
  const relays = (q.get('relay') || '').split(',').filter(u => /^wss:\/\//.test(u))
  const turnUrl = q.get('turn')
  const turn = turnUrl ? [{ urls: turnUrl, username: q.get('turnUser') || undefined, credential: q.get('turnPass') || undefined }] : undefined
  return { relays: relays.length ? [...relays, ...RELAYS] : RELAYS, turn }
}
export const PROTOCOL = 1
export const MAX_PEERS = 12

export interface PeerInfo {
  id: string
  name: string
  team: number
  since: number
  ver: number
  fresh: boolean
}

type Json = Record<string, unknown>
/** Trystero actions, typed loosely: payloads are plain JSON objects or ArrayBuffers. */
interface Act<T> {
  send: (data: T, options?: { target?: string }) => Promise<void>
  onMessage: ((data: T, ctx: { peerId: string }) => void) | null
}

export class Net {
  selfId = selfId
  since = Date.now()
  /** For this long after joining, we defer to anyone already in the room (clock-skew guard). */
  settleMs = 6000
  private joinedAt = 0
  room: Room | null = null
  roomId = ''
  peers = new Map<string, PeerInfo>()
  hostId = selfId
  online = false

  onHello: (p: PeerInfo, isNew: boolean) => void = () => {}
  onLeave: (id: string) => void = () => {}
  onHostChange: (newHost: string, oldHost: string) => void = () => {}
  onState: (buf: ArrayBuffer, from: string) => void = () => {}
  onEvent: (e: Json, from: string) => void = () => {}
  onHostSnap: (buf: ArrayBuffer, from: string) => void = () => {}
  onHostEvent: (e: Json, from: string) => void = () => {}
  onFull: (e: Json, from: string) => void = () => {}

  private sendHi: ((d: Json, o?: { target?: string }) => Promise<void>) | null = null
  private sendPs: ((d: ArrayBuffer) => Promise<void>) | null = null
  private sendEv: ((d: Json, o?: { target?: string }) => Promise<void>) | null = null
  private sendHs: ((d: ArrayBuffer) => Promise<void>) | null = null
  private sendHe: ((d: Json) => Promise<void>) | null = null
  private sendFl: ((d: Json, o?: { target?: string }) => Promise<void>) | null = null

  get isHost() {
    return this.hostId === this.selfId
  }

  /** Our own hello payload; set by the game. */
  me: () => { name: string; team: number } = () => ({ name: 'Player', team: 0 })

  join(roomId: string, opts: { rtcPolyfill?: typeof RTCPeerConnection; relays?: string[]; turn?: RTCIceServer[] } = {}) {
    let room: Room
    try {
      room = joinRoom({
        appId: APP_ID,
        rtcPolyfill: opts.rtcPolyfill,
        turnConfig: opts.turn as never,
        relayConfig: { urls: opts.relays ?? RELAYS, warnOnRelayFailure: false } as never,
      }, roomId)
    } catch (e) {
      console.warn('P2P unavailable, playing offline', e)
      this.room = null
      return false
    }
    this.attach(room, roomId)
    return true
  }

  /** Wire up a room (a real Trystero room, or a fake one in tests). */
  attach(room: Room, roomId: string) {
    this.roomId = roomId
    this.room = room
    this.online = true
    this.joinedAt = performance.now()
    // re-announce once settled so others start counting us in host elections
    setTimeout(() => this.hello(), this.settleMs + 100)
    const hi = room.makeAction('hi') as unknown as Act<Json>
    const ps = room.makeAction('ps') as unknown as Act<ArrayBuffer>
    const ev = room.makeAction('ev') as unknown as Act<Json>
    const hs = room.makeAction('hs') as unknown as Act<ArrayBuffer>
    const he = room.makeAction('he') as unknown as Act<Json>
    const fl = room.makeAction('full') as unknown as Act<Json>
    this.sendHi = (d, o) => hi.send(d, o)
    this.sendPs = d => ps.send(d)
    this.sendEv = (d, o) => ev.send(d, o)
    this.sendHs = d => hs.send(d)
    this.sendHe = d => he.send(d)
    this.sendFl = (d, o) => fl.send(d, o)

    hi.onMessage = (d, { peerId }) => {
      if (typeof d !== 'object' || !d) return
      const isNew = !this.peers.has(peerId)
      const info: PeerInfo = {
        id: peerId,
        name: String(d.name ?? 'Player').slice(0, 20),
        team: Number(d.team) | 0,
        since: Number(d.since) || Date.now(),
        ver: Number(d.ver) | 0,
        fresh: !!d.fresh,
      }
      this.peers.set(peerId, info)
      // A newcomer must never take over an existing room just because its clock is
      // behind: while we're new, move our timestamp to just after everyone we meet.
      if (this.fresh && !info.fresh && this.since <= info.since) {
        this.since = info.since + 1
        this.hello()
      }
      this.elect()
      this.onHello(info, isNew)
    }
    ps.onMessage = (d, { peerId }) => { if (this.peers.has(peerId)) this.onState(d, peerId) }
    ev.onMessage = (d, { peerId }) => { if (this.peers.has(peerId) && d && typeof d === 'object') this.onEvent(d, peerId) }
    hs.onMessage = (d, { peerId }) => { if (peerId === this.hostId) this.onHostSnap(d, peerId) }
    he.onMessage = (d, { peerId }) => { if (peerId === this.hostId && d && typeof d === 'object') this.onHostEvent(d, peerId) }
    fl.onMessage = (d, { peerId }) => { if (peerId === this.hostId && d && typeof d === 'object') this.onFull(d, peerId) }

    room.onPeerJoin = id => this.hello(id)
    room.onPeerLeave = id => {
      this.peers.delete(id)
      this.onLeave(id)
      this.elect()
    }
  }

  hello(target?: string) {
    const m = this.me()
    this.sendHi?.({ name: m.name, team: m.team, since: this.since, ver: PROTOCOL, fresh: this.fresh }, target ? { target } : undefined)
  }

  get fresh() {
    return performance.now() - this.joinedAt < this.settleMs
  }

  private elect() {
    let best = this.selfId, bestSince = this.since
    for (const p of this.peers.values()) {
      // settled peers ignore newcomers until they settle (prevents clock-skew takeovers)
      if (p.fresh && !this.fresh) continue
      if (p.since < bestSince || (p.since === bestSince && p.id < best)) {
        best = p.id
        bestSince = p.since
      }
    }
    if (best !== this.hostId) {
      const old = this.hostId
      this.hostId = best
      this.onHostChange(best, old)
    }
  }

  state(buf: ArrayBuffer) { if (this.peers.size) this.sendPs?.(buf) }
  event(e: Json, target?: string) { if (this.peers.size) this.sendEv?.(e, target ? { target } : undefined) }
  hostSnap(buf: ArrayBuffer) { if (this.peers.size) this.sendHs?.(buf) }
  hostEvent(e: Json) { if (this.peers.size) this.sendHe?.(e) }
  full(e: Json, target: string) { this.sendFl?.(e, { target }) }

  leave() {
    this.room?.leave()
    this.room = null
    this.online = false
    this.peers.clear()
    this.hostId = this.selfId
  }
}

// ------------------------------------------------------------------ binary codecs

/** Brick transforms: u16 id, 3x i16 position (1/50 stud), 4x i16 quaternion. 16 bytes each. */
export function encodeBricks(ids: number[], inst: Float32Array, stride: number): ArrayBuffer {
  const buf = new ArrayBuffer(4 + ids.length * 16)
  const v = new DataView(buf)
  v.setUint8(0, 1)
  v.setUint16(2, ids.length, true)
  let o = 4
  for (const i of ids) {
    const b = i * stride
    v.setUint16(o, i, true)
    v.setInt16(o + 2, clampI16(inst[b] * 50), true)
    v.setInt16(o + 4, clampI16(inst[b + 1] * 50), true)
    v.setInt16(o + 6, clampI16(inst[b + 2] * 50), true)
    v.setInt16(o + 8, clampI16(inst[b + 3] * 32767), true)
    v.setInt16(o + 10, clampI16(inst[b + 4] * 32767), true)
    v.setInt16(o + 12, clampI16(inst[b + 5] * 32767), true)
    v.setInt16(o + 14, clampI16(inst[b + 6] * 32767), true)
    o += 16
  }
  return buf
}

export function decodeBricks(
  buf: ArrayBuffer,
  fn: (id: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number) => void,
) {
  if (buf.byteLength < 4) return
  const v = new DataView(buf)
  const n = v.getUint16(2, true)
  if (buf.byteLength < 4 + n * 16) return
  let o = 4
  for (let k = 0; k < n; k++, o += 16) {
    let qx = v.getInt16(o + 8, true) / 32767, qy = v.getInt16(o + 10, true) / 32767
    let qz = v.getInt16(o + 12, true) / 32767, qw = v.getInt16(o + 14, true) / 32767
    const l = Math.hypot(qx, qy, qz, qw) || 1
    qx /= l; qy /= l; qz /= l; qw /= l
    fn(v.getUint16(o, true), v.getInt16(o + 2, true) / 50, v.getInt16(o + 4, true) / 50, v.getInt16(o + 6, true) / 50, qx, qy, qz, qw)
  }
}

function clampI16(x: number) {
  return x > 32767 ? 32767 : x < -32768 ? -32768 : Math.round(x)
}

export function toB64(buf: ArrayBuffer) {
  const u = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromB64(s: string): ArrayBuffer {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u.buffer
}

/** Player state: 16 float32s. */
export const PS = {
  X: 0, Y: 1, Z: 2, VX: 3, VY: 4, VZ: 5, YAW: 6, PITCH: 7,
  HP: 8, TOOL: 9, FLAGS: 10, TEAM: 11, KILLS: 12, DEATHS: 13, SWING: 14, SEQ: 15,
} as const
export const PF = { Alive: 1, Grounded: 2, Shield: 4 } as const
