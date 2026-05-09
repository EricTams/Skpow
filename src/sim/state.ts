import { fixed, fixedFromInt, type Fixed } from './fixed';
import { rngSeed } from './rng';
import { getShipSpec, type ShipId } from './shipSpecs';
import { angle } from './trig';
import type { GameState, GameplaySettings, ShipCustomState, ShipState } from './types';

export const DEFAULT_GAMEPLAY_SETTINGS: GameplaySettings = {
  gravityDivisor: 1,
  speedMultiplier: 1,
};

export interface RoundStartShipOverride {
  readonly crew?: number;
  readonly battery?: number;
  readonly custom?: ShipCustomState;
  readonly zizlikNodeSlots?: readonly number[];
  readonly pscoutBeaconSlots?: readonly number[];
}

export function createInitialState(
  seed = 0x5eed_2026,
  loadout: readonly [ShipId, ShipId] = ['frog', 'cannonade'],
  gameplay: GameplaySettings = DEFAULT_GAMEPLAY_SETTINGS,
  shipOverrides: readonly [RoundStartShipOverride | undefined, RoundStartShipOverride | undefined] = [undefined, undefined],
): GameState {
  const arenaSize = fixedFromInt(2900);
  const ships = [
    createShip(0, loadout[0], fixedFromInt(425), fixedFromInt(425), angle(0), shipOverrides[0]),
    createShip(1, loadout[1], fixedFromInt(-425), fixedFromInt(-425), angle(128), shipOverrides[1]),
  ] as const;
  const actors = createInitialActors(loadout, ships, shipOverrides);

  return {
    frame: 0,
    arena: {
      width: arenaSize,
      height: arenaSize,
    },
    planet: {
      x: fixedFromInt(0),
      y: fixedFromInt(0),
      radius: fixedFromInt(80),
    },
    ships,
    nextProjectileId: 1,
    nextActorId: actors.length + 1,
    nextEffectId: 1,
    actors,
    projectiles: [],
    effects: [],
    gameplay,
    rngSeed: rngSeed(seed),
    winnerId: null,
  };
}

function createShip(
  id: number,
  shipId: ShipId,
  x: ShipState['x'],
  y: ShipState['y'],
  facing: ShipState['angle'],
  override?: RoundStartShipOverride,
): ShipState {
  const spec = getShipSpec(shipId);
  const custom = sanitizeRoundStartCustom(shipId, facing, override?.custom);
  const crew = Math.max(0, Math.min(spec.crew, override?.crew ?? spec.crew));
  const battery = Math.max(0, Math.min(spec.battery, override?.battery ?? spec.battery));
  return {
    id,
    shipId,
    x,
    y,
    vx: fixed(0),
    vy: fixed(0),
    angle: facing,
    crew,
    maxCrew: spec.crew,
    battery,
    maxBattery: spec.battery,
    batteryChargeFrame: 0,
    primaryCooldown: 0,
    secondaryCooldown: 0,
    freezeFrames: 0,
    alive: crew > 0,
    custom,
  };
}

function createCustomState(shipId: ShipId, facing: ShipState['angle']): ShipCustomState {
  switch (shipId) {
    case 'frog':
      return { frogCharge: 0, frogChargeTime: 0, frogShielded: false };
    case 'cannonade':
      return { cannonAngle: facing };
    case 'krab':
      return { krabLongRange: false };
    case 'pscout':
      return { pscoutBeamFrames: 0, pscoutBeamStrength: 0 };
    case 'duk':
      return { dukMissileCount: 4 };
    default:
      return {};
  }
}

function sanitizeRoundStartCustom(shipId: ShipId, facing: ShipState['angle'], custom?: ShipCustomState): ShipCustomState {
  const base = createCustomState(shipId, facing);
  switch (shipId) {
    case 'cannonade':
      return { cannonAngle: facing };
    case 'krab':
      return { krabLongRange: custom?.krabLongRange ?? base.krabLongRange };
    case 'duk':
      return { dukMissileCount: custom?.dukMissileCount ?? base.dukMissileCount };
    case 'pscout':
      return { pscoutBeamFrames: 0, pscoutBeamStrength: 0 };
    default:
      return base;
  }
}

function createInitialActors(
  loadout: readonly [ShipId, ShipId],
  ships: readonly [ShipState, ShipState],
  shipOverrides: readonly [RoundStartShipOverride | undefined, RoundStartShipOverride | undefined],
): GameState['actors'] {
  const actors: GameState['actors'][number][] = [];
  let nextActorId = 1;

  for (const [playerId, shipId] of loadout.entries()) {
    if (shipId === 'gooj') {
      actors.push({
        id: nextActorId,
        kind: 'goojBackNode',
        ownerId: playerId,
        attachedToShipId: playerId,
        slot: 0,
        x: fixedFromInt(0),
        y: fixedFromInt(0),
        angle: angle(0),
        radius: getShipSpec('gooj').radius,
        ttl: null,
        active: true,
      });
      nextActorId += 1;
    }

    const override = shipOverrides[playerId];
    if (!override || !ships[playerId]?.alive) {
      continue;
    }

    for (const slot of override.zizlikNodeSlots ?? []) {
      actors.push(createInitialActor(nextActorId, 'zizlikNode', playerId, playerId, slot, ships[playerId].x, ships[playerId].y, getShipSpec('zizlik').radius));
      nextActorId += 1;
    }

    const targetId = playerId === 0 ? 1 : 0;
    for (const slot of override.pscoutBeaconSlots ?? []) {
      actors.push(createInitialActor(nextActorId, 'pscoutBeacon', playerId, targetId, slot, ships[targetId].x, ships[targetId].y, getShipSpec('pscout').primary.radius));
      nextActorId += 1;
    }
  }

  return actors;
}

function createInitialActor(
  id: number,
  kind: GameState['actors'][number]['kind'],
  ownerId: number,
  attachedToShipId: number,
  slot: number,
  x: ShipState['x'],
  y: ShipState['y'],
  radius: Fixed,
): GameState['actors'][number] {
  return {
    id,
    kind,
    ownerId,
    attachedToShipId,
    slot,
    x,
    y,
    angle: angle(0),
    radius,
    ttl: null,
    active: true,
  };
}
