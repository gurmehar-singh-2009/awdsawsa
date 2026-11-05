// End-to-end protocol test with in-process peers over a fake Trystero bus:
// host election, full-state handshake, brick snapshot sync, host migration.
import RAPIER from '@dimforge/rapier3d-compat'
import { Net, encodeBricks, decodeBricks } from '../src/net/net.ts'
import { buildMap } from '../src/game/map.ts'
import { World } from '../src/game/world.ts'
import { BOX_STRIDE } from '../src/render/scene.ts'

type Handler = ((d: unknown, ctx: { peerId: string }) => void) | null
class FakeRoom {
  actions = new Map<string, { onMessage: Handler }>()
  onPeerJoin: ((id: string) => void) | null = null
  onPeerLeave: ((id: string) => void) | null = null
  constructor(public bus: FakeBus, public id: string) {}
  makeAction(name: string) {
    const a = {
      onMessage: null as Handler,
      send: async (data: unknown, o?: { target?: string }) => this.bus.deliver(this.id, name, data, o?.target),
    }
    this.actions.set(name, a)
    return a
  }
  leave() { this.bus.leave(this.id) }
}
class FakeBus {
  rooms = new Map<string, FakeRoom>()
  queue: (() => void)[] = []
  join(id: string) {
    const r = new FakeRoom(this, id)
    for (const other of this.rooms.values()) {
      this.queue.push(() => other.onPeerJoin?.(id))
      this.queue.push(() => r.onPeerJoin?.(other.id))
    }
    this.rooms.set(id, r)
    return r
  }
  leave(id: string) {
    this.rooms.delete(id)
    for (const r of this.rooms.values()) this.queue.push(() => r.onPeerLeave?.(id))
  }
  deliver(from: string, name: string, data: unknown, target?: string) {
    const copy = data instanceof ArrayBuffer ? data.slice(0) : JSON.parse(JSON.stringify(data))
    for (const r of this.rooms.values()) {
      if (r.id === from || (target && target !== r.id)) continue
      this.queue.push(() => r.actions.get(name)?.onMessage?.(copy, { peerId: from }))
    }
  }
  flush() { let n = 0; while (this.queue.length && n++ < 100000) this.queue.shift()!() }
}

let failures = 0
const check = (ok: boolean, msg: string) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if (!ok) failures++ }

await RAPIER.init()
const bus = new FakeBus()
const map = buildMap()
interface Peer { name: string; net: Net; world: World; fulls: number }
const peers: Peer[] = []
function addPeer(name: string, since: number, settleMs = 6000) {
  const net = new Net()
  net.settleMs = settleMs
  net.selfId = 'id-' + name
  net.since = since
  net.hostId = net.selfId
  const world = new World(map, true)
  const p: Peer = { name, net, world, fulls: 0 }
  net.me = () => ({ name, team: 0 })
  // mirror what Game does
  net.onHello = (_info, isNew) => {
    if (net.isHost && isNew) {
      const rel = world.released.filter(i => world.isAlive(i))
      net.full({ k: 'full', snap: [...new Uint8Array(encodeBricks(rel, world.inst, BOX_STRIDE))] }, _info.id)
    }
  }
  net.onHostChange = (now, old) => {
    if (now === net.selfId) world.promote()
    else if (old === net.selfId) world.demote()
  }
  net.onFull = e => {
    p.fulls++
    world.reset()
    decodeBricks(new Uint8Array(e.snap as number[]).buffer, (i, x, y, z, qx, qy, qz, qw) => world.applyRemote(i, x, y, z, qx, qy, qz, qw))
  }
  net.onHostSnap = buf => decodeBricks(buf, (i, x, y, z, qx, qy, qz, qw) => world.applyRemote(i, x, y, z, qx, qy, qz, qw))
  net.attach(bus.join(net.selfId) as never, 'test')
  peers.push(p)
  return p
}
const hostName = (p: Peer) => (p.net.isHost ? p.name : p.net.hostId.replace('id-', ''))

console.log('1. election')
const A = addPeer('A', 1000)
A.world.explode(84 + 5, 1, 0, 6, 40) // A plays alone for a bit: some bricks already loose
for (let s = 0; s < 120; s++) { A.world.phys.step(); A.world.syncFromPhysics([], []) }
const B = addPeer('B', 2000), C = addPeer('C', 3000)
B.world.isHost = false; C.world.isHost = false
bus.flush()
check(peers.every(p => hostName(p) === 'A'), 'all peers agree A (oldest) is host: ' + peers.map(hostName).join(','))
check(B.fulls === 1 && C.fulls === 1, `newcomers received full state (B=${B.fulls}, C=${C.fulls})`)
const relA = A.world.released.filter(i => A.world.isAlive(i)).length
check(B.world.released.length === relA, `B mirrors A's ${relA} loose bricks (has ${B.world.released.length})`)

for (const p of peers) { p.net.settleMs = 0; p.net.hello() } // time passes: everyone settles and re-announces
bus.flush()
console.log('2. snapshot sync')
A.world.explode(-84 - 5, 1, 0, 6, 40)
for (let s = 0; s < 240; s++) {
  A.world.phys.step()
  const moved: number[] = []
  A.world.syncFromPhysics(moved, [])
  if (s % 4 === 0 && moved.length) A.net.hostSnap(encodeBricks(moved, A.world.inst, BOX_STRIDE))
  B.world.phys.step(); B.world.smooth(1 / 60)
  bus.flush()
}
let maxErr = 0
for (const i of A.world.released) {
  const o = i * BOX_STRIDE
  maxErr = Math.max(maxErr, Math.abs(A.world.inst[o] - B.world.target[i * 7]) + Math.abs(A.world.inst[o + 1] - B.world.target[i * 7 + 1]))
}
check(maxErr < 0.1, `client brick targets match host (max error ${maxErr.toFixed(3)})`)

console.log('3. host migration')
A.net.leave()
bus.leave(A.net.selfId)
bus.flush()
check(B.net.isHost && hostName(C) === 'B', `B takes over (B host=${B.net.isHost}, C sees ${hostName(C)})`)
check(B.world.isHost, 'B promoted its world to simulate bricks')

console.log('4. newcomer with a skewed (older) clock does not take over')
const D = addPeer('D', 500)
D.world.isHost = false
bus.flush()
check(peers.filter(p => p !== A).every(p => hostName(p) === 'B'), 'everyone still follows B: ' + peers.filter(p => p !== A).map(hostName).join(','))
check(D.fulls === 1, `D got the room state from B (fulls=${D.fulls})`)

console.log('5. long-separated older group merges in (split brain heals)')
const E = addPeer('E', 400, 0)
bus.flush()
const live = peers.filter(p => p !== A)
check(live.every(p => hostName(p) === 'E'), 'everyone defers to E: ' + live.map(hostName).join(','))
check(!B.world.isHost && B.fulls === 2, `B demoted and resynced from E (fulls=${B.fulls})`)

console.log(failures ? `\n${failures} check(s) failed` : '\nall protocol checks passed')
process.exit(failures ? 1 : 0)
