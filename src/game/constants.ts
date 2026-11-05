export const TOOL = { Sword: 0, Rocket: 1, Bomb: 2, Sling: 3, Build: 4 } as const

export const TOOLS = [
  { name: 'Sword', mesh: 'sword', cooldown: 0.5, hint: 'Slash nearby enemies' },
  { name: 'Rocket', mesh: 'launcher', cooldown: 2.6, hint: 'Explodes on impact' },
  { name: 'Bomb', mesh: 'bomb', cooldown: 5.5, hint: 'Big blast after a fuse' },
  { name: 'Slingshot', mesh: 'slingshot', cooldown: 0.3, hint: 'Fast bouncing pellets' },
  { name: 'Builder', mesh: 'trowel', cooldown: 2.4, hint: 'Raise a brick wall' },
]

export const P = {
  radius: 0.9,
  halfHeight: 1.5, // capsule: total height 2*(halfHeight+radius) = 4.8
  speed: 16,
  accelGround: 140,
  accelAir: 35,
  jump: 28,
  gravity: 80,
  maxHp: 100,
  regenDelay: 5,
  regen: 4,
  respawn: 5,
  shield: 3,
  eye: 4.4,
}

export const ROCKET = { speed: 72, radius: 7, power: 34, damage: 100, life: 4 }
export const BOMB = { speed: 20, up: 9, fuse: 3.2, radius: 11, power: 46, damage: 100 }
export const PELLET = { speed: 115, gravity: 30, damage: 14, life: 1.8 }
export const SWORD = { range: 6.5, damage: 34, knock: 26 }
export const BUILD = { range: 45 }
export const VOID_Y = -60
