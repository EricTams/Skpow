import { fixed, fixedFromInt, fixedMul, type Fixed } from './fixed';

export type ShipId =
  | 'frog'
  | 'cannonade'
  | 'zizlik'
  | 'voskum'
  | 'pscout'
  | 'kron'
  | 'gooj'
  | 'krab'
  | 'nurtip'
  | 'duk'
  | 'discfighter';

export type ProjectileKind =
  | 'generic'
  | 'frogBubble'
  | 'cannonadeBall'
  | 'cannonadeBoomerang'
  | 'zizlikShot'
  | 'voskumShot'
  | 'pscoutBeacon'
  | 'kronPulse'
  | 'goojTorp'
  | 'goojJunk'
  | 'krabLong'
  | 'krabShort'
  | 'nurtipMissile'
  | 'nurtipAsteroid'
  | 'dukStunner'
  | 'dukMissile'
  | 'discfighterDisc';

export interface WeaponSpec {
  readonly speed: Fixed;
  readonly framesPerShot: number;
  readonly cost: number;
  readonly ttl: number;
  readonly damage: number;
  readonly radius: Fixed;
  readonly kind: ProjectileKind;
  readonly trackPct?: Fixed;
}

export interface ShipSpec {
  readonly id: ShipId;
  readonly crew: number;
  readonly battery: number;
  readonly batteryChargeFrames: number;
  readonly turnStep: Fixed;
  readonly maxSpeed: Fixed;
  readonly accel: Fixed;
  readonly brake: Fixed;
  readonly radius: Fixed;
  readonly renderScale: number;
  readonly primary: WeaponSpec;
  readonly secondary: WeaponSpec;
  readonly cannonTurnStep?: Fixed;
  readonly longRange?: {
    readonly turnStep: Fixed;
    readonly maxSpeed: Fixed;
    readonly accel: Fixed;
    readonly primary: WeaponSpec;
  };
}

const DEFAULT_SECONDARY: WeaponSpec = {
  speed: fixed(2.5),
  framesPerShot: 100,
  cost: 4,
  ttl: 90,
  damage: 1,
  radius: fixedFromInt(10),
  kind: 'generic',
};

export const SHIP_SPECS: Record<ShipId, ShipSpec> = {
  frog: {
    id: 'frog',
    crew: 30,
    battery: 30,
    batteryChargeFrames: 75,
    turnStep: legacyTurnStep(0.012),
    maxSpeed: legacyMaxSpeed(1.39),
    accel: legacyAccel(0.018),
    brake: fixed(0.98),
    radius: legacyHitRadius(55, 0.4),
    renderScale: 0.4,
    primary: {
      speed: fixed(10),
      framesPerShot: 18,
      cost: 1,
      ttl: 52,
      damage: 1,
      radius: fixedFromInt(10),
      kind: 'frogBubble',
    },
    secondary: {
      ...DEFAULT_SECONDARY,
      framesPerShot: 100,
      cost: 2,
    },
  },
  cannonade: {
    id: 'cannonade',
    crew: 24,
    battery: 24,
    batteryChargeFrames: 80,
    turnStep: legacyTurnStep(0.005),
    cannonTurnStep: literalTurnStep(0.016),
    maxSpeed: legacyMaxSpeed(0.75),
    accel: legacyAccel(0.02),
    brake: fixed(0.99),
    radius: legacyHitRadius(160, 0.15),
    renderScale: 0.15,
    primary: {
      speed: fixed(12),
      framesPerShot: 75,
      cost: 6,
      ttl: 155,
      damage: 7,
      radius: fixedFromInt(16),
      kind: 'cannonadeBall',
    },
    secondary: {
      speed: fixed(4),
      framesPerShot: 75,
      cost: 4,
      ttl: 700,
      damage: 4,
      radius: fixedFromInt(26),
      kind: 'cannonadeBoomerang',
      trackPct: fixed(0.0085),
    },
  },
  zizlik: {
    id: 'zizlik',
    crew: 10,
    battery: 12,
    batteryChargeFrames: 33,
    turnStep: legacyTurnStep(0.03),
    maxSpeed: legacyMaxSpeed(2.4),
    accel: legacyAccel(0.15),
    brake: fixed(0.99),
    radius: legacyHitRadius(55, 0.4),
    renderScale: 0.4,
    primary: {
      speed: fixed(12),
      framesPerShot: 6,
      cost: 2,
      ttl: 50,
      damage: 1,
      radius: fixedFromInt(10),
      kind: 'zizlikShot',
    },
    secondary: {
      ...DEFAULT_SECONDARY,
      framesPerShot: 100,
      cost: 12,
    },
  },
  voskum: {
    id: 'voskum',
    crew: 20,
    battery: 20,
    batteryChargeFrames: 40,
    turnStep: legacyTurnStep(0.015),
    maxSpeed: legacyMaxSpeed(2.25),
    accel: legacyAccel(0.02),
    brake: fixed(0.99),
    radius: legacyHitRadius(35, 0.6),
    renderScale: 0.6,
    primary: {
      speed: fixed(12),
      framesPerShot: 8,
      cost: 1,
      ttl: 50,
      damage: 1,
      radius: fixedFromInt(10),
      kind: 'voskumShot',
    },
    secondary: {
      ...DEFAULT_SECONDARY,
      framesPerShot: 150,
      cost: 4,
    },
  },
  pscout: {
    id: 'pscout',
    crew: 8,
    battery: 4,
    batteryChargeFrames: 100,
    turnStep: legacyTurnStep(0.025),
    maxSpeed: legacyMaxSpeed(2.5),
    accel: legacyAccel(0.06),
    brake: fixed(0.99),
    radius: legacyHitRadius(25, 0.6),
    renderScale: 0.6,
    primary: {
      speed: fixed(12),
      framesPerShot: 100,
      cost: 2,
      ttl: 60,
      damage: 0,
      radius: fixedFromInt(10),
      kind: 'pscoutBeacon',
    },
    secondary: {
      ...DEFAULT_SECONDARY,
      framesPerShot: 100,
      cost: 2,
    },
  },
  kron: {
    id: 'kron',
    crew: 20,
    battery: 20,
    batteryChargeFrames: 40,
    turnStep: legacyTurnStep(0.015),
    maxSpeed: legacyMaxSpeed(2.25),
    accel: legacyAccel(0.02),
    brake: fixed(0.99),
    radius: legacyHitRadius(85, 0.33),
    renderScale: 0.33,
    primary: {
      speed: fixed(0),
      framesPerShot: 10,
      cost: 1,
      ttl: 8,
      damage: 1,
      radius: fixedFromInt(45),
      kind: 'kronPulse',
    },
    secondary: {
      ...DEFAULT_SECONDARY,
      framesPerShot: 100,
      cost: 8,
    },
  },
  gooj: {
    id: 'gooj',
    crew: 26,
    battery: 10,
    batteryChargeFrames: 50,
    turnStep: legacyTurnStep(0.0085),
    maxSpeed: legacyMaxSpeed(3.25),
    accel: legacyAccel(0.0075),
    brake: fixed(0.99),
    radius: legacyHitRadius(600, 0.04),
    renderScale: 0.04,
    primary: {
      speed: fixed(7),
      framesPerShot: 80,
      cost: 4,
      ttl: 280,
      damage: 2,
      radius: fixedFromInt(12),
      kind: 'goojTorp',
      trackPct: fixed(0.0085),
    },
    secondary: {
      speed: fixed(1.25),
      framesPerShot: 50,
      cost: 4,
      ttl: 1080,
      damage: 1,
      radius: fixedFromInt(16),
      kind: 'goojJunk',
    },
  },
  nurtip: {
    id: 'nurtip',
    crew: 36,
    battery: 36,
    batteryChargeFrames: 40,
    turnStep: legacyTurnStep(0.012),
    maxSpeed: legacyMaxSpeed(1.39),
    accel: legacyAccel(0.018),
    brake: fixed(0.99),
    radius: legacyHitRadius(75, 0.6),
    renderScale: 0.6,
    primary: {
      // Legacy ShootMainWeapon: speed 6, life 600, mDamage 6, mBatt -= 6, no real frame cooldown.
      // framesPerShot=1 is just a same-frame double-launch guard; nurtipPrimaryArmed gates re-launch.
      speed: fixed(6),
      framesPerShot: 1,
      cost: 6,
      ttl: 600,
      damage: 6,
      radius: fixedFromInt(15),
      kind: 'nurtipMissile',
    },
    secondary: {
      // Legacy ShootSpecialWeapon: speed 5, life 4000, dmg 6, mFramesPerShot 32, mBatt -= 6.
      // We tighten ttl down because our orbital model just has the rocks ride around; 4000f felt forever.
      speed: fixed(2.25),
      framesPerShot: 32,
      cost: 6,
      ttl: 600,
      damage: 4,
      radius: fixedFromInt(20),
      kind: 'nurtipAsteroid',
    },
  },
  duk: {
    id: 'duk',
    crew: 18,
    battery: 16,
    batteryChargeFrames: 70,
    turnStep: legacyTurnStep(0.012),
    maxSpeed: legacyMaxSpeed(1.39),
    accel: legacyAccel(0.018),
    brake: fixed(0.99),
    radius: legacyHitRadius(75, 0.6),
    renderScale: 0.6,
    primary: {
      speed: fixed(9),
      framesPerShot: 60,
      cost: 2,
      ttl: 1000,
      damage: 1,
      radius: fixedFromInt(10),
      kind: 'dukStunner',
    },
    secondary: {
      speed: fixed(10),
      framesPerShot: 300,
      cost: 2,
      ttl: 300,
      damage: 10,
      radius: fixedFromInt(20),
      kind: 'dukMissile',
    },
  },
  discfighter: {
    id: 'discfighter',
    crew: 30,
    battery: 30,
    batteryChargeFrames: 75,
    turnStep: legacyTurnStep(0.012),
    maxSpeed: legacyMaxSpeed(1.39),
    accel: legacyAccel(0.018),
    brake: fixed(0.98),
    radius: legacyHitRadius(130, 0.2),
    renderScale: 0.2,
    primary: {
      speed: fixed(10),
      framesPerShot: 25,
      cost: 2,
      ttl: 6_000_000,
      damage: 4,
      radius: fixedFromInt(18),
      kind: 'discfighterDisc',
    },
    secondary: {
      speed: fixed(2.5),
      framesPerShot: 50,
      cost: 2,
      ttl: 1,
      damage: 2,
      radius: fixedFromInt(60),
      kind: 'generic',
    },
  },
  krab: {
    id: 'krab',
    crew: 20,
    battery: 20,
    batteryChargeFrames: 40,
    turnStep: legacyTurnStep(0.02),
    maxSpeed: legacyMaxSpeed(1.45),
    accel: legacyAccel(0.01),
    brake: fixed(0.99),
    radius: legacyHitRadius(65, 0.5),
    renderScale: 0.5,
    primary: {
      speed: fixed(3.5),
      framesPerShot: 10,
      cost: 1,
      ttl: 100,
      damage: 1,
      radius: fixedFromInt(10),
      kind: 'krabShort',
    },
    secondary: {
      ...DEFAULT_SECONDARY,
      framesPerShot: 32,
      cost: 5,
    },
    longRange: {
      turnStep: legacyTurnStep(0.006),
      maxSpeed: legacyMaxSpeed(2.85),
      accel: legacyAccel(0.02),
      primary: {
        speed: fixed(12),
        framesPerShot: 15,
        cost: 1,
        ttl: 100,
        damage: 1,
        radius: fixedFromInt(10),
        kind: 'krabLong',
      },
    },
  },
};

export const DEFAULT_SHIP_ID: ShipId = 'frog';

export function getShipSpec(id: ShipId): ShipSpec {
  return SHIP_SPECS[id];
}

function legacyTurnStep(turnSpeedRadians: number): Fixed {
  return fixed(((turnSpeedRadians * 1.6) / (Math.PI * 2)) * 256);
}

function literalTurnStep(turnSpeedRadians: number): Fixed {
  return fixed((turnSpeedRadians / (Math.PI * 2)) * 256);
}

function legacyMaxSpeed(maxSpeed: number): Fixed {
  return fixed(maxSpeed * 1.55);
}

function legacyAccel(accel: number): Fixed {
  return fixed(accel * 1.35);
}

function legacyHitRadius(radius: number, scale: number): Fixed {
  return fixedMul(fixedFromInt(radius), fixed(scale));
}
