/** Procedurally synthesised sound effects: no audio files to download. */
type Sfx = 'boom' | 'launch' | 'swing' | 'hit' | 'pellet' | 'build' | 'jump' | 'death' | 'click' | 'bombThrow' | 'win'

export class Audio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  volume = 0.6
  listener = { x: 0, y: 0, z: 0 }

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume()
      return
    }
    try {
      this.ctx = new AudioContext()
    } catch {
      return
    }
    this.master = this.ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.ctx.destination)
    const len = this.ctx.sampleRate
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  }

  setVolume(v: number) {
    this.volume = v
    if (this.master) this.master.gain.value = v
  }

  /** Play a sound, optionally positioned in the world (simple distance falloff). */
  play(s: Sfx, pos?: { x: number; y: number; z: number }, gain = 1) {
    const ctx = this.ctx, out = this.master
    if (!ctx || !out || !this.noise) return
    if (pos) {
      const d = Math.hypot(pos.x - this.listener.x, pos.y - this.listener.y, pos.z - this.listener.z)
      gain *= 1 / (1 + d * d * 0.0012)
      if (gain < 0.02) return
    }
    const t = ctx.currentTime
    const g = ctx.createGain()
    g.connect(out)
    const env = (a: number, peak: number, dec: number) => {
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(peak * gain, t + a)
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec)
    }
    const noise = (type: BiquadFilterType, f0: number, f1: number, dur: number) => {
      const src = ctx.createBufferSource()
      src.buffer = this.noise
      const f = ctx.createBiquadFilter()
      f.type = type
      f.frequency.setValueAtTime(f0, t)
      f.frequency.exponentialRampToValueAtTime(f1, t + dur)
      src.connect(f).connect(g)
      src.start(t, Math.random() * 0.5)
      src.stop(t + dur + 0.05)
    }
    const tone = (type: OscillatorType, f0: number, f1: number, dur: number) => {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.setValueAtTime(f0, t)
      o.frequency.exponentialRampToValueAtTime(f1, t + dur)
      o.connect(g)
      o.start(t)
      o.stop(t + dur + 0.05)
    }
    switch (s) {
      case 'boom': env(0.005, 1.0, 1.1); noise('lowpass', 1800, 60, 1.1); tone('sine', 90, 30, 0.6); break
      case 'launch': env(0.02, 0.35, 0.45); noise('bandpass', 600, 2400, 0.45); break
      case 'swing': env(0.01, 0.25, 0.16); noise('highpass', 1500, 5000, 0.16); break
      case 'hit': env(0.002, 0.35, 0.12); tone('square', 320, 120, 0.12); break
      case 'pellet': env(0.002, 0.2, 0.07); tone('triangle', 900, 300, 0.07); break
      case 'build': env(0.003, 0.3, 0.18); tone('square', 220, 440, 0.06); noise('bandpass', 2000, 800, 0.15); break
      case 'jump': env(0.005, 0.08, 0.1); tone('sine', 300, 520, 0.1); break
      case 'death': env(0.01, 0.35, 0.5); tone('sawtooth', 400, 70, 0.5); break
      case 'click': env(0.001, 0.12, 0.04); tone('square', 1200, 900, 0.03); break
      case 'bombThrow': env(0.01, 0.2, 0.2); noise('bandpass', 400, 900, 0.2); break
      case 'win': env(0.02, 0.3, 1.2); tone('triangle', 392, 784, 1.0); break
    }
  }
}
