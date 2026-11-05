import { TOOLS } from '../game/constants'
import { TEAM_INFO } from '../game/map'

const $ = (id: string) => document.getElementById(id)!

export interface TeamStatus { core: boolean; players: number; alive: boolean }
export interface ScoreRow { name: string; team: number; kills: number; deaths: number; me: boolean; host: boolean }

/** DOM HUD. Updates are diffed so the layout is only touched when something changes. */
export class Hud {
  private slots: HTMLElement[] = []
  private cds: HTMLElement[] = []
  private last: Record<string, string> = {}
  private names = new Map<string, HTMLElement>()
  private hitTimer = 0
  onToolClick: (i: number) => void = () => {}

  constructor() {
    const bar = $('toolbar')
    TOOLS.forEach((t, i) => {
      const el = document.createElement('div')
      el.className = 'slot'
      el.innerHTML = `<b>${i + 1}</b>${t.name}<div class="cd"></div>`
      el.title = t.hint
      el.addEventListener('pointerdown', e => {
        e.stopPropagation()
        this.onToolClick(i)
      })
      bar.appendChild(el)
      this.slots.push(el)
      this.cds.push(el.querySelector('.cd') as HTMLElement)
    })
  }

  private set(id: string, html: string) {
    if (this.last[id] === html) return
    this.last[id] = html
    $(id).innerHTML = html
  }

  show(on: boolean) {
    $('hud').classList.toggle('hidden', !on)
  }

  health(hp: number, max: number) {
    const k = Math.max(0, hp / max)
    const key = Math.ceil(hp) + ''
    if (this.last.hp === key) return
    this.last.hp = key
    ;($('health-fill') as HTMLElement).style.transform = `scaleX(${k})`
    $('health-text').textContent = key
  }

  tools(active: number, cooldowns: number[]) {
    this.slots.forEach((s, i) => s.classList.toggle('on', i === active))
    this.cds.forEach((c, i) => (c.style.width = `${Math.round(cooldowns[i] * 100)}%`))
  }

  teams(status: TeamStatus[], myTeam: number) {
    const html = status.map((s, i) => {
      const c = TEAM_INFO[i]
      const cls = ['team-chip', s.core ? '' : 'lost', s.players && !s.alive ? 'out' : '', i === myTeam ? 'me' : ''].join(' ')
      const bg = `rgb(${c.color.map(v => Math.round(v * 255)).join(',')})`
      return `<div class="${cls}" style="background:${bg}"><div class="core"></div>${c.name} ${s.players}</div>`
    }).join('')
    this.set('teams', html)
  }

  banner(text: string, sub = '') {
    this.set('banner', esc(text))
    this.set('sub-banner', esc(sub))
  }

  net(text: string) {
    this.set('net', esc(text))
  }

  feed(html: string) {
    const el = document.createElement('div')
    el.innerHTML = html
    const f = $('feed')
    f.appendChild(el)
    while (f.children.length > 6) f.firstChild!.remove()
    setTimeout(() => el.remove(), 6500)
  }

  chat(from: string, msg: string, color = '#fff', sys = false) {
    const el = document.createElement('div')
    if (sys) el.className = 'sys'
    el.innerHTML = sys ? esc(msg) : `<span style="color:${color}">${esc(from)}:</span> ${esc(msg)}`
    const log = $('chat-log')
    log.appendChild(el)
    while (log.children.length > 10) log.firstChild!.remove()
  }

  hitmarker() {
    const c = $('crosshair')
    c.classList.add('hit')
    clearTimeout(this.hitTimer)
    this.hitTimer = window.setTimeout(() => c.classList.remove('hit'), 160)
  }

  scoreboard(show: boolean, rows: ScoreRow[], room: string) {
    $('scoreboard').classList.toggle('hidden', !show)
    if (!show) return
    rows.sort((a, b) => a.team - b.team || b.kills - a.kills)
    const html = `<div style="margin-bottom:6px;font-weight:900">Room: ${esc(room)}</div><table><tr><th>Player</th><th>Kills</th><th>Deaths</th></tr>` +
      rows.map(r => `<tr style="color:${teamCss(r.team)}"><td>${r.me ? '▶ ' : ''}${esc(r.name)}${r.host ? ' ★' : ''}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('') +
      '</table><div style="font-size:12px;margin-top:6px;opacity:.7">★ = host (simulates bricks)</div>'
    this.set('scoreboard', html)
  }

  /** Floating name + health tags over other players. */
  nameTag(id: string, name: string, team: number, hp: number, sx: number, sy: number, visible: boolean) {
    let el = this.names.get(id)
    if (!el) {
      el = document.createElement('div')
      $('names').appendChild(el)
      this.names.set(id, el)
    }
    if (!visible) {
      el.style.display = 'none'
      return
    }
    el.style.display = ''
    el.style.left = `${sx}px`
    el.style.top = `${sy}px`
    const key = `${name}|${team}|${Math.ceil(hp)}`
    if (el.dataset.k !== key) {
      el.dataset.k = key
      el.style.color = teamCss(team)
      el.innerHTML = `${esc(name)}<i><b style="width:${Math.max(0, hp)}%"></b></i>`
    }
  }

  dropTag(id: string) {
    this.names.get(id)?.remove()
    this.names.delete(id)
  }

  clickToPlay(show: boolean) {
    $('click-to-play').classList.toggle('hidden', !show)
  }
}

export function teamCss(t: number, lighten = 0.25) {
  const c = TEAM_INFO[t]?.color ?? [1, 1, 1]
  return `rgb(${c.map(v => Math.round((v + (1 - v) * lighten) * 255)).join(',')})`
}

export function esc(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
