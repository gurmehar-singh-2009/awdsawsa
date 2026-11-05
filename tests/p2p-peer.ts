// One headless peer for tests/p2p-check.ts. Usage: tsx p2p-peer.ts <room> <name> <delayMs>
import { RTCPeerConnection } from 'node-datachannel/polyfill'
import { Net, decodeBricks, encodeBricks } from '../src/net/net.ts'

const [room, name, delay] = process.argv.slice(2)
await new Promise(r => setTimeout(r, Number(delay)))
const net = new Net()
net.me = () => ({ name, team: name === 'A' ? 0 : 1 })
const log = (...a: unknown[]) => console.log(`[${name}]`, ...a)
net.onHello = (p, isNew) => isNew && log('hello from', p.name, 'host is', net.isHost ? 'me' : net.peers.get(net.hostId)?.name)
net.onHostChange = (now, old) => log('host change ->', now === net.selfId ? 'me' : net.peers.get(now)?.name, 'was', old === net.selfId ? 'me' : old)
net.onEvent = (e, from) => log('event', JSON.stringify(e), 'from', net.peers.get(from)?.name)
net.onHostSnap = buf => decodeBricks(buf, (id, x, y, z) => log('brick', id, x, y, z))
net.onFull = e => log('full state round', e.round)
net.join(room, RTCPeerConnection as never)
log('joined', room)
// once connected: B sends an event; host A sends a brick snapshot
const t = setInterval(() => {
  if (!net.peers.size) return
  clearInterval(t)
  if (net.isHost) {
    const inst = new Float32Array(32); inst[16] = 1.5; inst[17] = -2.25; inst[18] = 3; inst[22] = 1
    net.hostSnap(encodeBricks([1], inst, 16))
    net.full({ k: 'full', round: 7 }, [...net.peers.keys()][0])
  } else net.event({ k: 'chat', msg: 'hi from ' + name })
}, 300)
setTimeout(() => { net.leave(); process.exit(0) }, 25000)
