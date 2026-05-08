import { fixed, fixedFromInt } from './fixed';
import { rngSeed } from './rng';
import { getShipSpec, type ShipId } from './shipSpecs';
import { angle } from './trig';
import type { GameState, GameplaySettings, ShipCustomState, ShipState } from './types';

export const DEFAULT_GAMEPLAY_SETTINGS: GameplaySettings = {
  gravityDivisor: 1,
  speedMultiplier: 1,
};

export function createInitialState(
  seed = 0x5eed_2026,
  loadout: readonly [ShipId, ShipId] = ['frog', 'cannonade'],
  gameplay: GameplaySettings = DEFAULT_GAMEPLAY_SETTINGS,
): GameState {
  const arenaSize = fixedFromInt(2900);
  const actors = createInitialActors(loadout);

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
    ships: [
      createShip(0, loadout[0], fixedFromInt(425), fixedFromInt(425), angle(0)),
      createShip(1, loadout[1], fixedFromInt(-425), fixedFromInt(-425), angle(128)),
    ],
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

function createShip(id: number, shipId: ShipId, x: ShipState['x'], y: ShipState['y'], facing: ShipState['angle']): ShipState {
  const spec = getShipSpec(shipId);
  return {
    id,
    shipId,
    x,
    y,
    vx: fixed(0),
    vy: fixed(0),
    angle: facing,
    crew: spec.crew,
    maxCrew: spec.crew,
    battery: spec.battery,
    maxBattery: spec.battery,
    batteryChargeFrame: 0,
    primaryCooldown: 0,
    secondaryCooldown: 0,
    freezeFrames: 0,
    alive: true,
    custom: createCustomState(shipId, facing),
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
    default:
      return {};
  }
}

function createInitialActors(loadout: readonly [ShipId, ShipId]): GameState['actors'] {
  const actors: GameState['actors'][number][] = [];
  let nextActorId = 1;

  for (const [playerId, shipId] of loadout.entries()) {
    if (shipId !== 'gooj') {
      continue;
    }

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

  return actors;
}
