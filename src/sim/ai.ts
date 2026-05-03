import { fixedFromInt, fixedToNumber } from './fixed';
import { getShipSpec } from './shipSpecs';
import { ANGLE_STEPS, angle, type Angle } from './trig';
import { InputBits, type GameState, type ShipState } from './types';

export type AiMovementMode = 'pursuit' | 'back' | 'right' | 'left';

const SHOT_DISTANCE = fixedFromInt(550);
const CLOSE_SHOT_DISTANCE_RATIO = 0.9;
const SHOT_LEAD_FRAMES = 5;
const PURSUIT_LEAD_FRAMES = 50;
const ZIZLIK_FIRE_X_TOLERANCE = 50;
const FIRE_ANGLE_TOLERANCE_STEPS = Math.ceil((0.15 / (Math.PI * 2)) * ANGLE_STEPS);
const CANNONADE_FIRE_TOLERANCE_STEPS = Math.ceil((0.05 / (Math.PI * 2)) * ANGLE_STEPS);
const CANNONADE_SPECIAL_MAX_DISTANCE = 1100;
const KRON_SPECIAL_NEAR_RANGE = 400;
const KRON_SPECIAL_AIM_DOT = 0.5;
const KRON_SPECIAL_RECEDING_SPEED = 0.05;
const AI_PURSUIT_MIN_FRAMES = 3 * 60;
const AI_PURSUIT_FRAME_RANGE = 3 * 60;
const AI_EVADE_MIN_FRAMES = Math.round(0.5 * 60);
const AI_EVADE_FRAME_RANGE = 60;
const AI_EVADE_MODES = ['back', 'right', 'left'] as const satisfies readonly AiMovementMode[];
const PLANET_AVOIDANCE_PADDING = 220;
const PLANET_AVOIDANCE_LOOKAHEAD = 900;
const PLANET_INWARD_VELOCITY_THRESHOLD = 0.25;

interface AimSolution {
  readonly targetAngle: Angle;
  readonly distance: number;
  readonly dx: number;
  readonly dy: number;
}

export function getAiInput(state: GameState, playerId: number): number {
  const ship = state.ships[playerId];
  const enemy = state.ships.find((candidate) => candidate.id !== playerId && candidate.alive);
  if (!ship?.alive || !enemy) {
    return 0;
  }

  const directAim = getAimSolution(ship, enemy, state, 0);
  const shotDistance = getShotDistance(ship);
  const leadRatio = directAim.distance / shotDistance;
  const closeLeadFrames = getShotLeadFrames(ship);
  const pursuitLeadFrames = getPursuitLeadFrames(ship);
  const leadFrames = directAim.distance < shotDistance * CLOSE_SHOT_DISTANCE_RATIO ? closeLeadFrames : pursuitLeadFrames;
  const aim = getAimSolution(ship, enemy, state, leadRatio * leadFrames);
  const shotAim = getAimSolution(ship, enemy, state, leadRatio * closeLeadFrames);
  const cannonAngle = ship.custom.cannonAngle ?? ship.angle;
  const fireReferenceAngle = ship.shipId === 'cannonade' ? cannonAngle : ship.angle;
  const movementMode = getAiMovementMode(state, playerId);
  const movementAim = getMovementAim(aim, movementMode);
  const planetAvoidanceAim = getPlanetAvoidanceAim(ship, state, movementAim);
  const steeringAim = planetAvoidanceAim ?? movementAim.targetAngle;
  const turnReferenceAngle =
    ship.shipId === 'cannonade' && planetAvoidanceAim === null ? cannonAngle : ship.angle;

  let input = InputBits.Thrust;
  const turnDelta = getSignedAngleDelta(turnReferenceAngle, steeringAim);
  if (turnDelta > 0) {
    input |= InputBits.TurnRight;
  } else if (turnDelta < 0) {
    input |= InputBits.TurnLeft;
  }

  const shotTolerance = ship.shipId === 'cannonade' ? CANNONADE_FIRE_TOLERANCE_STEPS : FIRE_ANGLE_TOLERANCE_STEPS;
  const shotDelta = Math.abs(getSignedAngleDelta(fireReferenceAngle, shotAim.targetAngle));
  const canAffordPrimary = ship.battery >= getShipSpec(ship.shipId).primary.cost;
  const inFiringPosition = shotAim.distance < shotDistance && shotDelta <= shotTolerance;
  const shouldFirePrimary =
    ship.shipId === 'zizlik'
      ? shouldZizlikFire(ship, enemy, state)
      : ship.shipId === 'frog'
        ? shouldFrogHoldFire(ship, inFiringPosition)
        : inFiringPosition;
  if (shouldFirePrimary && canAffordPrimary) {
    input |= InputBits.FirePrimary;
  }

  if (shouldUseSpecial(ship, enemy, directAim.distance, state)) {
    input |= InputBits.FireSecondary;
  }

  return input;
}

export function getAiMovementMode(state: GameState, playerId: number): AiMovementMode {
  let frame = Math.max(0, state.frame);
  let cycle = 0;

  while (true) {
    const pursuitFrames = getModeDurationFrames(playerId, cycle, 'pursuit');
    if (frame < pursuitFrames) {
      return 'pursuit';
    }
    frame -= pursuitFrames;

    const evadeFrames = getModeDurationFrames(playerId, cycle, 'evade');
    if (frame < evadeFrames) {
      return getEvadeMode(playerId, cycle);
    }
    frame -= evadeFrames;
    cycle += 1;
  }
}

function getAimSolution(ship: ShipState, enemy: ShipState, state: GameState, leadFrames: number): AimSolution {
  const enemyX = fixedToNumber(enemy.x) + fixedToNumber(enemy.vx) * leadFrames;
  const enemyY = fixedToNumber(enemy.y) + fixedToNumber(enemy.vy) * leadFrames;
  const shipX = fixedToNumber(ship.x);
  const shipY = fixedToNumber(ship.y);
  const dx = getWrappedDelta(enemyX - shipX, fixedToNumber(state.arena.width));
  const dy = getWrappedDelta(enemyY - shipY, fixedToNumber(state.arena.height));

  return {
    targetAngle: angle(Math.round((Math.atan2(dy, dx) / (Math.PI * 2)) * ANGLE_STEPS)),
    distance: Math.hypot(dx, dy),
    dx,
    dy,
  };
}

function getMovementAim(aim: AimSolution, mode: AiMovementMode): AimSolution {
  return {
    ...aim,
    targetAngle: getMovementAngle(aim.targetAngle, mode),
  };
}

function getMovementAngle(pursuitAngle: Angle, mode: AiMovementMode): Angle {
  switch (mode) {
    case 'back':
      return angle(pursuitAngle + ANGLE_STEPS / 2);
    case 'right':
      return angle(pursuitAngle + ANGLE_STEPS / 4);
    case 'left':
      return angle(pursuitAngle - ANGLE_STEPS / 4);
    case 'pursuit':
      return pursuitAngle;
  }
}

function getModeDurationFrames(playerId: number, cycle: number, segment: 'pursuit' | 'evade'): number {
  if (segment === 'pursuit') {
    return AI_PURSUIT_MIN_FRAMES + Math.floor(unitHash(playerId, cycle, 0x9e37) * (AI_PURSUIT_FRAME_RANGE + 1));
  }

  return AI_EVADE_MIN_FRAMES + Math.floor(unitHash(playerId, cycle, 0x51ed) * (AI_EVADE_FRAME_RANGE + 1));
}

function getEvadeMode(playerId: number, cycle: number): AiMovementMode {
  return AI_EVADE_MODES[Math.floor(unitHash(playerId, cycle, 0xa11e) * AI_EVADE_MODES.length)] ?? 'back';
}

function unitHash(playerId: number, cycle: number, salt: number): number {
  let value = (salt ^ Math.imul(playerId + 1, 0x85eb_ca6b) ^ Math.imul(cycle + 1, 0xc2b2_ae35)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb_352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846c_a68b) >>> 0;
  value ^= value >>> 16;
  return value / 0x1_0000_0000;
}

function shouldZizlikFire(ship: ShipState, enemy: ShipState, state: GameState): boolean {
  const aim = getAimSolution(ship, enemy, state, getShotLeadFrames(ship));
  return Math.abs(aim.dx) < ZIZLIK_FIRE_X_TOLERANCE && aim.distance < getShotDistance(ship);
}

function shouldFrogHoldFire(ship: ShipState, inFiringPosition: boolean): boolean {
  const charge = ship.custom.frogCharge ?? 0;
  if (inFiringPosition && charge > 0) {
    return false;
  }
  return true;
}

function getPlanetAvoidanceAim(ship: ShipState, state: GameState, pursuitAim: AimSolution): Angle | null {
  const arenaWidth = fixedToNumber(state.arena.width);
  const arenaHeight = fixedToNumber(state.arena.height);
  const shipX = fixedToNumber(ship.x);
  const shipY = fixedToNumber(ship.y);
  const planetX = fixedToNumber(state.planet.x);
  const planetY = fixedToNumber(state.planet.y);
  const dx = getWrappedDelta(shipX - planetX, arenaWidth);
  const dy = getWrappedDelta(shipY - planetY, arenaHeight);
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return angle(0);
  }

  const dangerRadius = fixedToNumber(state.planet.radius) + fixedToNumber(getShipSpec(ship.shipId).radius) + PLANET_AVOIDANCE_PADDING;
  const outwardAngle = toAngleSteps(Math.atan2(dy, dx));
  const inwardVelocity = -((fixedToNumber(ship.vx) * dx + fixedToNumber(ship.vy) * dy) / distance);
  if (distance < dangerRadius || (distance < dangerRadius * 1.45 && inwardVelocity > PLANET_INWARD_VELOCITY_THRESHOLD)) {
    return outwardAngle;
  }

  const pursuitRadians = angleToRadians(pursuitAim.targetAngle);
  const headingX = Math.cos(pursuitRadians);
  const headingY = Math.sin(pursuitRadians);
  const projectionToPlanet = -dx * headingX - dy * headingY;
  if (projectionToPlanet <= 0 || projectionToPlanet > Math.min(PLANET_AVOIDANCE_LOOKAHEAD, pursuitAim.distance)) {
    return null;
  }

  const closestDistance = Math.hypot(-dx - projectionToPlanet * headingX, -dy - projectionToPlanet * headingY);
  if (closestDistance > dangerRadius) {
    return null;
  }

  return chooseCloserAngle(pursuitAim.targetAngle, angle(outwardAngle - ANGLE_STEPS / 4), angle(outwardAngle + ANGLE_STEPS / 4));
}

function getWrappedDelta(delta: number, arenaSize: number): number {
  const halfArena = arenaSize / 2;
  if (delta > halfArena) {
    return delta - arenaSize;
  }

  if (delta < -halfArena) {
    return delta + arenaSize;
  }

  return delta;
}

function getSignedAngleDelta(current: Angle, target: Angle): number {
  const rawDelta = (target - current) & (ANGLE_STEPS - 1);
  return rawDelta > ANGLE_STEPS / 2 ? rawDelta - ANGLE_STEPS : rawDelta;
}

function angleToRadians(current: Angle): number {
  return (current / ANGLE_STEPS) * Math.PI * 2;
}

function toAngleSteps(radians: number): Angle {
  return angle(Math.round((radians / (Math.PI * 2)) * ANGLE_STEPS));
}

function chooseCloserAngle(target: Angle, first: Angle, second: Angle): Angle {
  return Math.abs(getSignedAngleDelta(first, target)) < Math.abs(getSignedAngleDelta(second, target)) ? first : second;
}

function getShotDistance(ship: ShipState): number {
  switch (ship.shipId) {
    case 'frog':
      return 500 + 10 * (ship.custom.frogCharge ?? 0);
    case 'cannonade':
      return 1000;
    case 'zizlik':
      return 520;
    case 'voskum':
      return 360;
    case 'kron':
      return 340;
    case 'gooj':
      return 700;
    case 'krab':
      return ship.custom.krabLongRange ? 725 : 250;
    default:
      return fixedToNumber(SHOT_DISTANCE);
  }
}

function getShotLeadFrames(ship: ShipState): number {
  switch (ship.shipId) {
    case 'frog':
      return 12;
    case 'cannonade':
      return 40;
    case 'zizlik':
      return 15;
    case 'kron':
      return 0;
    case 'gooj':
      return 70;
    case 'krab':
      return 25;
    default:
      return SHOT_LEAD_FRAMES;
  }
}

function getPursuitLeadFrames(ship: ShipState): number {
  return ship.shipId === 'zizlik' ? 30 : PURSUIT_LEAD_FRAMES;
}

function shouldUseSpecial(ship: ShipState, enemy: ShipState, distance: number, state: GameState): boolean {
  const spec = getShipSpec(ship.shipId);
  if (ship.secondaryCooldown > 0 || ship.battery < spec.secondary.cost) {
    return false;
  }

  switch (ship.shipId) {
    case 'frog':
      return !ship.custom.frogShielded && ship.crew < ship.maxCrew;
    case 'cannonade':
      return distance < CANNONADE_SPECIAL_MAX_DISTANCE;
    case 'zizlik':
      return countActors(state, 'zizlikNode', ship.id) < 2;
    case 'voskum':
      return distance < 400 && ship.crew < enemy.crew;
    case 'kron':
      return shouldKronUseSpecial(ship, enemy, distance, state);
    case 'gooj':
      return distance < 500;
    case 'krab': {
      const isLongRange = ship.custom.krabLongRange ?? false;
      return (distance > 750 && !isLongRange) || (distance < 350 && isLongRange);
    }
    case 'pscout':
      return shouldPScoutUseSpecial(ship, enemy, state);
    default:
      return false;
  }
}

function shouldKronUseSpecial(ship: ShipState, enemy: ShipState, distance: number, state: GameState): boolean {
  if (enemy.freezeFrames > 0) {
    return false;
  }

  const dx = getWrappedDelta(fixedToNumber(enemy.x) - fixedToNumber(ship.x), fixedToNumber(state.arena.width));
  const dy = getWrappedDelta(fixedToNumber(enemy.y) - fixedToNumber(ship.y), fixedToNumber(state.arena.height));
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return false;
  }

  const dirX = dx / length;
  const dirY = dy / length;

  const closingSpeed = fixedToNumber(ship.vx) * dirX + fixedToNumber(ship.vy) * dirY;
  const movingAway = closingSpeed < -KRON_SPECIAL_RECEDING_SPEED;

  const facingRadians = angleToRadians(ship.angle);
  const aimDot = Math.cos(facingRadians) * dirX + Math.sin(facingRadians) * dirY;
  const wellAimed = aimDot >= KRON_SPECIAL_AIM_DOT;

  const inRange = distance < KRON_SPECIAL_NEAR_RANGE;

  if (!inRange && movingAway) {
    return false;
  }

  return inRange && wellAimed;
}

function shouldPScoutUseSpecial(ship: ShipState, enemy: ShipState, state: GameState): boolean {
  const beaconCount = countActors(state, 'pscoutBeacon', enemy.id);
  const beamDamage = beaconCount * beaconCount;

  return beamDamage >= enemy.crew || beamDamage > ship.crew;
}

function countActors(state: GameState, kind: GameState['actors'][number]['kind'], attachedToShipId: number): number {
  return state.actors.filter((actor) => actor.active && actor.kind === kind && actor.attachedToShipId === attachedToShipId).length;
}
