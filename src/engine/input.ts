/**
 * Keyboard / mouse (pointer lock) / touch input, flattened into one state object
 * the game polls each frame.
 */
export class Input {
  keys = new Set<string>()
  pressed = new Set<string>() // keys pressed this frame
  lookDX = 0
  lookDY = 0
  wheel = 0
  fire = false // held
  firePressed = false
  // touch
  touch = false
  moveX = 0
  moveY = 0
  touchJump = false
  enabled = true
  sensitivity = 0.0025
  private joyId = -1
  private joyOrigin = { x: 0, y: 0 }
  private lookId = -1
  private lookLast = { x: 0, y: 0 }
  private joyEl: HTMLElement | null = null
  private knobEl: HTMLElement | null = null

  constructor(private el: HTMLElement) {
    addEventListener('keydown', e => {
      if (!this.enabled) return
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault()
      if (!this.keys.has(e.code)) this.pressed.add(e.code)
      this.keys.add(e.code)
    })
    addEventListener('keyup', e => this.keys.delete(e.code))
    addEventListener('blur', () => {
      this.keys.clear()
      this.fire = false
    })
    el.addEventListener('mousedown', e => {
      if (!this.enabled) return
      if (document.pointerLockElement !== el) {
        this.lock()
        return
      }
      if (e.button === 0) {
        this.fire = true
        this.firePressed = true
      }
    })
    addEventListener('mouseup', e => {
      if (e.button === 0) this.fire = false
    })
    addEventListener('mousemove', e => {
      if (document.pointerLockElement === el) {
        this.lookDX += e.movementX
        this.lookDY += e.movementY
      }
    })
    el.addEventListener('wheel', e => {
      this.wheel += Math.sign(e.deltaY)
      e.preventDefault()
    }, { passive: false })
    el.addEventListener('contextmenu', e => e.preventDefault())
    this.setupTouch()
  }

  get locked() {
    return document.pointerLockElement === this.el || this.touch
  }

  lock() {
    if (this.touch) return
    const p = this.el.requestPointerLock?.() as unknown as Promise<void> | undefined
    p?.catch?.(() => {})
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock()
  }

  down(code: string) {
    return this.enabled && this.keys.has(code)
  }

  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear()
    this.lookDX = 0
    this.lookDY = 0
    this.wheel = 0
    this.firePressed = false
    this.touchJump = false
  }

  private setupTouch() {
    const start = () => {
      if (this.touch) return
      this.touch = true
      document.body.classList.add('touch')
      this.joyEl = document.getElementById('joy')
      this.knobEl = document.getElementById('joy-knob')
    }
    addEventListener('touchstart', start, { once: true, passive: true })
    const el = this.el
    el.addEventListener('touchstart', e => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < innerWidth * 0.4 && this.joyId < 0) {
          this.joyId = t.identifier
          this.joyOrigin = { x: t.clientX, y: t.clientY }
          if (this.joyEl) {
            this.joyEl.style.display = 'block'
            this.joyEl.style.left = t.clientX - 60 + 'px'
            this.joyEl.style.top = t.clientY - 60 + 'px'
          }
        } else if (this.lookId < 0) {
          this.lookId = t.identifier
          this.lookLast = { x: t.clientX, y: t.clientY }
        }
      }
      e.preventDefault()
    }, { passive: false })
    el.addEventListener('touchmove', e => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) {
          let dx = (t.clientX - this.joyOrigin.x) / 50, dy = (t.clientY - this.joyOrigin.y) / 50
          const l = Math.hypot(dx, dy)
          if (l > 1) { dx /= l; dy /= l }
          this.moveX = dx
          this.moveY = dy
          if (this.knobEl) this.knobEl.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`
        } else if (t.identifier === this.lookId) {
          this.lookDX += (t.clientX - this.lookLast.x) * 2.2
          this.lookDY += (t.clientY - this.lookLast.y) * 2.2
          this.lookLast = { x: t.clientX, y: t.clientY }
        }
      }
      e.preventDefault()
    }, { passive: false })
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) {
          this.joyId = -1
          this.moveX = this.moveY = 0
          if (this.joyEl) this.joyEl.style.display = 'none'
          if (this.knobEl) this.knobEl.style.transform = ''
        } else if (t.identifier === this.lookId) this.lookId = -1
      }
    }
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
  }

  /** Wire an on-screen button to a press/hold action. */
  bindButton(el: HTMLElement, onDown: () => void, onUp?: () => void) {
    el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); onDown() }, { passive: false })
    el.addEventListener('touchend', e => { e.preventDefault(); onUp?.() }, { passive: false })
  }
}
