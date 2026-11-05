import './style.css'
import type { Game, Settings } from './game/game'

// The game (physics, renderer, networking) is a separate chunk: the menu appears
// instantly and the heavy code downloads in the background while you pick a room.
const loadGame = () => Promise.all([import('./game/game'), import('./physics')])
const gameModule = loadGame()

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const DEFAULTS: Settings = { renderer: 'auto', quality: 'medium', dynres: true, fps: false, volume: 0.6, sens: 0.0025 }

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('bf.settings') || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Guess a sensible default quality: weak or mobile devices start on Low. */
function guessQuality(): Settings['quality'] {
  const cores = navigator.hardwareConcurrency || 2
  const mem = (navigator as { deviceMemory?: number }).deviceMemory || 4
  const mobile = matchMedia('(pointer: coarse)').matches
  if (cores <= 2 || mem <= 2) return 'low'
  if (mobile || cores <= 4) return 'medium'
  return 'high'
}

const settings = loadSettings()
if (!localStorage.getItem('bf.settings')) settings.quality = guessQuality()
const save = () => localStorage.setItem('bf.settings', JSON.stringify(settings))

let game: Game | null = null

// ---------------------------------------------------------------- menu wiring
const nameEl = $<HTMLInputElement>('name')
const roomEl = $<HTMLInputElement>('room')
nameEl.value = localStorage.getItem('bf.name') || `Builder${Math.floor(Math.random() * 9000 + 1000)}`
const hashRoom = new URLSearchParams(location.hash.slice(1)).get('room')
if (hashRoom) {
  roomEl.value = hashRoom
  $('join').classList.add('big')
}

const opt = {
  renderer: $<HTMLSelectElement>('opt-renderer'),
  quality: $<HTMLSelectElement>('opt-quality'),
  dynres: $<HTMLInputElement>('opt-dynres'),
  fps: $<HTMLInputElement>('opt-fps'),
  volume: $<HTMLInputElement>('opt-volume'),
  sens: $<HTMLInputElement>('opt-sens'),
}
opt.renderer.value = settings.renderer
opt.quality.value = settings.quality
opt.dynres.checked = settings.dynres
opt.fps.checked = settings.fps
opt.volume.value = String(settings.volume)
opt.sens.value = String(settings.sens)

for (const [key, el] of Object.entries(opt)) {
  el.addEventListener('change', () => {
    const s = settings as unknown as Record<string, unknown>
    if (el instanceof HTMLInputElement && el.type === 'checkbox') s[key] = el.checked
    else if (el instanceof HTMLInputElement && el.type === 'range') s[key] = Number(el.value)
    else s[key] = el.value
    save()
    if (!game) return
    if (key === 'renderer') game.makeRenderer()
    game.applySettings()
  })
}

$('menu-foot').textContent = `v1 · ${navigator.hardwareConcurrency || '?'} CPU threads · default quality: ${settings.quality}`

function randomCode() {
  const words = ['brick', 'stud', 'tower', 'spire', 'castle', 'blast', 'rocket', 'cloud', 'sky', 'fort']
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 9000 + 1000)}`
}

async function play(room: string) {
  const name = nameEl.value.trim().slice(0, 16) || 'Player'
  localStorage.setItem('bf.name', name)
  room = room.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 24) || 'public-1'
  history.replaceState(null, '', `#room=${encodeURIComponent(room)}`)
  $('menu').classList.add('hidden')
  $('loading').classList.remove('hidden')
  $('loading-text').textContent = 'Loading physics…'
  const [{ Game }, { initPhysics }] = await gameModule
  await initPhysics()
  $('loading-text').textContent = 'Building Skyhold…'
  await new Promise(r => setTimeout(r, 30))
  game = new Game(settings, $('stage'))
  game.onPause = paused => {
    $('pause').classList.toggle('hidden', !paused)
    if (paused) {
      $('pause-room').textContent = `Room: ${room}`
      $('pause-settings').appendChild($('settings-block'))
    }
  }
  $('loading').classList.add('hidden')
  game.start(room, name)
  game.input.lock()
  ;(window as unknown as { game: Game }).game = game
}

$('quick').onclick = () => play('public-1')
$('join').onclick = () => play(roomEl.value || 'public-1')
$('create').onclick = () => play(randomCode())
roomEl.addEventListener('keydown', e => e.key === 'Enter' && play(roomEl.value))

// ---------------------------------------------------------------- pause menu
$('resume').onclick = () => {
  $('pause').classList.add('hidden')
  if (!game) return
  game.paused = false
  game.input.lock()
}
$('copy-link').onclick = async () => {
  const url = location.href
  try {
    await navigator.clipboard.writeText(url)
    $('copy-link').textContent = 'Copied!'
  } catch {
    prompt('Share this link:', url)
  }
  setTimeout(() => ($('copy-link').textContent = 'Copy invite link'), 1500)
}
$('team-btn').onclick = () => {
  $('pause').classList.add('hidden')
  if (!game) return
  game.paused = false
  game.openTeamPick()
}
$('leave').onclick = () => {
  game?.stop()
  location.hash = ''
  location.reload()
}
