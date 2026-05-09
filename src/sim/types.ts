import type { Fixed } from './fixed';
import type { RngSeed } from './rng';
import type { ProjectileKind, ShipId } from './shipSpecs';
import type { Angle } from './trig';

export const PLAYER_COUNT = 2;

export enum InputBits {
  Thrust = 1 << 0,
  TurnLeft = 1 << 1,
  TurnRight = 1 << 2,
  FirePrimary = 1 << 3,
  FireSecondary = 1 << 4,
}

export interface ShipState {
  readonly id: number;
  readonly shipId: ShipId;
  readonly x: Fixed;
  readonly y: Fixed;
  readonly vx: Fixed;
  readonly vy: Fixed;
  readonly angle: Angle;
  readonly crew: number;
  readonly maxCrew: number;
  readonly battery: number;
  readonly maxBattery: number;
  readonly batteryChargeFrame: number;
  readonly primaryCooldown: number;
  readonly secondaryCooldown: number;
  readonly freezeFrames: number;
  readonly alive: boolean;
  readonly custom: ShipCustomState;
}

export interface ShipCustomState {
  readonly frogCharge?: number;
  readonly frogChargeTime?: number;
  readonly frogShielded?: boolean;
  readonly cannonAngle?: Angle;
  readonly cameraOverrideX?: Fixed;
  readonly cameraOverrideY?: Fixed;
  readonly krabLongRange?: boolean;
  readonly pscoutBeamFrames?: number;
  readonly pscoutBeamStrength?: number;
  readonly voskumTeleportAge?: number;
  readonly voskumTeleportFromX?: Fixed;
  readonly voskumTeleportFromY?: Fixed;
  readonly voskumTeleportAngles?: readonly Angle[];
  readonly turnAccumulator?: Fixed;
  readonly cannonTurnAccumulator?: Fixed;
  // True while a Nurtip primary missile is in flight; cleared on detonation or natural death.
  readonly nurtipPrimaryArmed?: boolean;
  readonly dukMissileCount?: number;
  readonly discfighterDiscState?: 'docked' | 'thrusting' | 'waiting';
  readonly discfighterDiscX?: Fixed;
  readonly discfighterDiscY?: Fixed;
  readonly discfighterDiscUpdateMissed?: number;
}

export type ActorKind = 'zizlikNode' | 'goojBackNode' | 'pscoutBeacon';

export interface ActorState {
  readonly id: number;
  readonly kind: ActorKind;
  readonly ownerId: number;
  readonly attachedToShipId: number;
  readonly slot: number;
  readonly x: Fixed;
  readonly y: Fixed;
  readonly angle: Angle;
  readonly radius: Fixed;
  readonly ttl: number | null;
  readonly active: boolean;
}

export type EffectKind = 'shipExplosion' | 'thrustDust' | 'nurtipExplosion';

export interface EffectState {
  readonly id: number;
  readonly kind: EffectKind;
  readonly ownerId: number;
  readonly x: Fixed;
  readonly y: Fixed;
  readonly vx: Fixed;
  readonly vy: Fixed;
  readonly scale: Fixed;
  readonly life: number;
  readonly maxLife: number;
}

export interface ProjectileState {
  readonly id: number;
  readonly ownerId: number;
  readonly kind: ProjectileKind;
  readonly x: Fixed;
  readonly y: Fixed;
  readonly vx: Fixed;
  readonly vy: Fixed;
  readonly angle: Angle;
  readonly ttl: number;
  readonly damage: number;
  readonly radius: Fixed;
  readonly rotation: Fixed;
  readonly trackPct: Fixed;
  readonly variety: number;
  readonly active: boolean;
}

export interface PlanetState {
  readonly x: Fixed;
  readonly y: Fixed;
  readonly radius: Fixed;
}

export interface ArenaState {
  readonly width: Fixed;
  readonly height: Fixed;
}

export interface GameplaySettings {
  readonly gravityDivisor: number;
  readonly speedMultiplier: number;
}

export interface GameState {
  readonly frame: number;
  readonly ships: readonly ShipState[];
  readonly actors: readonly ActorState[];
  readonly projectiles: readonly ProjectileState[];
  readonly effects: readonly EffectState[];
  readonly planet: PlanetState;
  readonly arena: ArenaState;
  readonly gameplay: GameplaySettings;
  readonly nextProjectileId: number;
  readonly nextActorId: number;
  readonly nextEffectId: number;
  readonly rngSeed: RngSeed;
  readonly winnerId: number | null;
}

export type FrameInputs = readonly [number, number];
