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
const DUK_SPECIAL_MAX_DISTANCE = 800;
const DUK_SPECIAL_LEAD_FRAMES = 60;
const KRON_SPECIAL_NEAR_RANGE = 400;
const KRON_SPECIAL_AIM_DOT = 0.5;
const KRON_SPECIAL_RECEDING_SPEED = 0.05;
const DOUBLESHIP_SPECIAL_NEAR_RANGE = 300;
const DOUBLESHIP_NEAR_FIRE_TOLERANCE_STEPS = FIRE_ANGLE_TOLERANCE_STEPS * 4;
const BOLTER_AI_MIN_CHARGE_FRAMES = 25;
const BOLTER_AI_RANGE_BUFFER = 1.1;
const BOLTER_AI_MUZZLE_SPEED_SCALE = 0.8;
const SHUGG_SHOT_DISTANCE = 600;
const SHUGG_PRIMARY_MIN_EFFECTIVE_DISTANCE = 400;
const SHUGG_SPECIAL_MAX_DISTANCE = 400;
const AI_PURSUIT_MIN_FRAMES = 3 * 60;
const AI_PURSUIT_FRAME_RANGE = 3 * 60;
const AI_EVADE_MIN_FRAMES = Math.round(0.5 * 60);
const AI_EVADE_FRAME_RANGE = 60;
const AI_LEAD_MIN_FRAMES = Math.round(0.5 * 60);
const AI_LEAD_FRAME_RANGE = Math.round(1.5 * 60);
const AI_LEAD_SCALE_MIN = 0.5;
const AI_LEAD_SCALE_RANGE = 1.5;
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
  const leadScale = getAiLeadScale(state.frame, playerId);
  const aim = getAimSolution(ship, enemy, state, leadRatio * leadFrames * leadScale);
  const shotAim = getAimSolution(ship, enemy, state, getShotAimLeadFrames(ship, directAim.distance, leadRatio, closeLeadFrames, leadScale));
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
      ? shouldZizlikFire(ship, enemy, state, leadScale)
      : ship.shipId === 'frog'
        ? shouldFrogHoldFire(ship, inFiringPosition)
        : ship.shipId === 'nurtip'
          ? shouldNurtipFire(ship, enemy, state, inFiringPosition)
          : ship.shipId === 'bolter'
            ? shouldBolterHoldFire(ship, shotAim, inFiringPosition)
            : ship.shipId === 'shugg'
              ? shouldShuggFire(shotAim, shotDelta, shotTolerance)
              : inFiringPosition;
  // Nurtip can hold the fire bit even with depleted battery: holding is free, only launch costs.
  const isNurtipHolding = ship.shipId === 'nurtip' && Boolean(ship.custom.nurtipPrimaryArmed);
  const isBolterHolding = ship.shipId === 'bolter' && (ship.custom.bolterCharge ?? 0) > 0;
  if (shouldFirePrimary && (canAffordPrimary || isNurtipHolding || isBolterHolding)) {
    input |= InputBits.FirePrimary;
  }

  if (shouldUseSpecial(ship, enemy, directAim.distance, state, leadScale, shotAim)) {
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
  const inheritedVx = ship.freezeFrames === 0 ? fixedToNumber(ship.vx) : 0;
  const inheritedVy = ship.freezeFrames === 0 ? fixedToNumber(ship.vy) : 0;
  const enemyX = fixedToNumber(enemy.x) + (fixedToNumber(enemy.vx) - inheritedVx) * leadFrames;
  const enemyY = fixedToNumber(enemy.y) + (fixedToNumber(enemy.vy) - inheritedVy) * leadFrames;
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

function getAiLeadScale(frame: number, playerId: number): number {
  const segment = getAiLeadSegment(frame, playerId);
  return AI_LEAD_SCALE_MIN + unitHash(playerId, segment, 0x1ead) * AI_LEAD_SCALE_RANGE;
}

function getAiLeadSegment(frame: number, playerId: number): number {
  let remainingFrames = Math.max(0, frame);
  let segment = 0;

  while (true) {
    const segmentFrames = AI_LEAD_MIN_FRAMES + Math.floor(unitHash(playerId, segment, 0x5ca1e) * (AI_LEAD_FRAME_RANGE + 1));
    if (remainingFrames < segmentFrames) {
      return segment;
    }

    remainingFrames -= segmentFrames;
    segment += 1;
  }
}

function unitHash(playerId: number, cycle: number, salt: number): number {
  let value = (salt ^ Math.imul(playerId + 1, 0x85eb_ca6b) ^ Math.imul(cycle + 1, 0xc2b2_ae35)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb_352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846c_a68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

function shouldZizlikFire(ship: ShipState, enemy: ShipState, state: GameState, leadScale: number): boolean {
  const aim = getAimSolution(ship, enemy, state, getShotLeadFrames(ship) * leadScale);
  return Math.abs(aim.dx) < ZIZLIK_FIRE_X_TOLERANCE && aim.distance < getShotDistance(ship);
}

function shouldFrogHoldFire(ship: ShipState, inFiringPosition: boolean): boolean {
  const charge = ship.custom.frogCharge ?? 0;
  if (inFiringPosition && charge > 0) {
    return false;
  }
  return true;
}

function shouldBolterHoldFire(ship: ShipState, shotAim: AimSolution, inFiringPosition: boolean): boolean {
  const charge = ship.custom.bolterCharge ?? 0;
  const chargeTime = ship.custom.bolterChargeTime ?? 0;
  const expectedTravel = getBolterExpectedTravel(charge);
  if (
    inFiringPosition &&
    charge > 0 &&
    chargeTime >= BOLTER_AI_MIN_CHARGE_FRAMES &&
    expectedTravel >= shotAim.distance * BOLTER_AI_RANGE_BUFFER
  ) {
    return false;
  }
  return true;
}

function shouldShuggFire(shotAim: AimSolution, shotDelta: number, shotTolerance: number): boolean {
  return (
    shotAim.distance >= SHUGG_PRIMARY_MIN_EFFECTIVE_DISTANCE &&
    shotAim.distance < SHUGG_SHOT_DISTANCE &&
    shotDelta <= shotTolerance
  );
}

// Nurtip primary is a remote-detonate torpedo: tap to launch, hold while it cruises, release for AOE.
// We launch when in firing position (no missile out), hold while the missile isn't yet on top of the
// enemy, and release once it's inside its 150-radius detonation envelope.
const NURTIP_AI_RELEASE_RADIUS = 130;

function shouldNurtipFire(ship: ShipState, enemy: ShipState, state: GameState, inFiringPosition: boolean): boolean {
  if (!ship.custom.nurtipPrimaryArmed) {
    return inFiringPosition;
  }

  const missile = state.projectiles.find(
    (projectile) => projectile.active && projectile.kind === 'nurtipMissile' && projectile.ownerId === ship.id,
  );
  if (!missile) {
    // Custom flag and projectile pool desynced for one frame — keep holding so the next stepShip clears it.
    return true;
  }

  const arenaWidth = fixedToNumber(state.arena.width);
  const arenaHeight = fixedToNumber(state.arena.height);
  const dx = getWrappedDelta(fixedToNumber(enemy.x) - fixedToNumber(missile.x), arenaWidth);
  const dy = getWrappedDelta(fixedToNumber(enemy.y) - fixedToNumber(missile.y), arenaHeight);
  return Math.hypot(dx, dy) > NURTIP_AI_RELEASE_RADIUS;
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

function clampRadians(value: number): number {
  let result = value;
  while (result > Math.PI) {
    result -= Math.PI * 2;
  }
  while (result < -Math.PI) {
    result += Math.PI * 2;
  }
  return result;
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
    case 'nurtip':
      return 850;
    case 'duk':
      return 800;
    case 'discfighter':
      return 900;
    case 'doubleship':
      return 340;
    case 'bolter':
      return getBolterExpectedTravel(ship.custom.bolterCharge ?? 0) / BOLTER_AI_RANGE_BUFFER;
    case 'shugg':
      return SHUGG_SHOT_DISTANCE;
    default:
      return fixedToNumber(SHOT_DISTANCE);
  }
}

function getBolterExpectedTravel(charge: number): number {
  return (5 + 0.2 * charge) * (32 + 3 * charge);
}

function getBolterShotSpeed(charge: number): number {
  return (5 + 0.2 * charge) * BOLTER_AI_MUZZLE_SPEED_SCALE;
}

function getShotAimLeadFrames(
  ship: ShipState,
  distance: number,
  leadRatio: number,
  closeLeadFrames: number,
  leadScale: number,
): number {
  if (ship.shipId === 'bolter') {
    const speed = getBolterShotSpeed(ship.custom.bolterCharge ?? 0);
    return speed > 0 ? (distance / speed) * leadScale : 0;
  }

  return leadRatio * closeLeadFrames * leadScale;
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
    case 'nurtip':
      return 100;
    case 'duk':
      return 90;
    case 'discfighter':
      return 18;
    case 'bolter':
      return 12;
    case 'shugg':
      return 10;
    default:
      return SHOT_LEAD_FRAMES;
  }
}

function getPursuitLeadFrames(ship: ShipState): number {
  return ship.shipId === 'zizlik' ? 30 : PURSUIT_LEAD_FRAMES;
}

function shouldUseSpecial(
  ship: ShipState,
  enemy: ShipState,
  distance: number,
  state: GameState,
  leadScale: number,
  shotAim: AimSolution,
): boolean {
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
      return ship.battery >= spec.secondary.cost * 2 && shouldKronUseSpecial(ship, enemy, distance, state);
    case 'gooj':
      return distance < 500;
    case 'krab': {
      const isLongRange = ship.custom.krabLongRange ?? false;
      return (distance > 750 && !isLongRange) || (distance < 350 && isLongRange);
    }
    case 'pscout':
      return shouldPScoutUseSpecial(ship, enemy, state);
    case 'nurtip':
      // Reference Nurtip::TryUseSpecial pops a rock at random with low odds (~1/1000 frames).
      return distance < 600;
    case 'duk':
      return shouldDukUseSpecial(ship, enemy, distance, state, leadScale);
    case 'discfighter':
      return shouldDiscfighterUseSpecial(ship, enemy, state);
    case 'doubleship':
      return shouldDoubleShipUseSpecial(ship, distance, shotAim);
    case 'bolter':
      return !ship.custom.bolterBlossomActive && ship.battery > 4 && distance < 150;
    case 'shugg':
      return shouldShuggUseSpecial(ship, distance, shotAim);
    default:
      return false;
  }
}

function shouldShuggUseSpecial(ship: ShipState, distance: number, shotAim: AimSolution): boolean {
  if (distance >= SHUGG_SPECIAL_MAX_DISTANCE) {
    return false;
  }

  return Math.abs(getSignedAngleDelta(ship.angle, shotAim.targetAngle)) <= FIRE_ANGLE_TOLERANCE_STEPS;
}

function shouldDoubleShipUseSpecial(ship: ShipState, distance: number, shotAim: AimSolution): boolean {
  if (distance >= DOUBLESHIP_SPECIAL_NEAR_RANGE) {
    return false;
  }

  const shotDelta = Math.abs(getSignedAngleDelta(ship.angle, shotAim.targetAngle));
  const nearFiringSolution = shotAim.distance < getShotDistance(ship) && shotDelta <= DOUBLESHIP_NEAR_FIRE_TOLERANCE_STEPS;
  return !nearFiringSolution;
}

function shouldDiscfighterUseSpecial(ship: ShipState, enemy: ShipState, state: GameState): boolean {
  if (ship.custom.discfighterDiscState === 'docked') {
    return false;
  }

  const discX = ship.custom.discfighterDiscX;
  const discY = ship.custom.discfighterDiscY;
  if (discX === undefined || discY === undefined) {
    return false;
  }

  const shipX = fixedToNumber(ship.x);
  const shipY = fixedToNumber(ship.y);
  const enemyDx = getWrappedDelta(fixedToNumber(enemy.x) - shipX, fixedToNumber(state.arena.width));
  const enemyDy = getWrappedDelta(fixedToNumber(enemy.y) - shipY, fixedToNumber(state.arena.height));
  const discDx = getWrappedDelta(fixedToNumber(discX) - shipX, fixedToNumber(state.arena.width));
  const discDy = getWrappedDelta(fixedToNumber(discY) - shipY, fixedToNumber(state.arena.height));
  const enemyDist = Math.hypot(enemyDx, enemyDy);
  const discDist = Math.hypot(discDx, discDy);
  if (enemyDist <= 0 || discDist < enemyDist) {
    return false;
  }

  const enemyAngle = Math.atan2(enemyDy, enemyDx);
  const discAngle = Math.atan2(discDy, discDx);
  return Math.abs(clampRadians(discAngle - enemyAngle)) <= 0.15;
}

function shouldDukUseSpecial(ship: ShipState, enemy: ShipState, distance: number, state: GameState, leadScale: number): boolean {
  if ((ship.custom.dukMissileCount ?? 0) <= 0 || distance >= DUK_SPECIAL_MAX_DISTANCE) {
    return false;
  }

  const leadRatio = distance / DUK_SPECIAL_MAX_DISTANCE;
  const aim = getAimSolution(ship, enemy, state, leadRatio * DUK_SPECIAL_LEAD_FRAMES * leadScale);
  return Math.abs(getSignedAngleDelta(ship.angle, aim.targetAngle)) <= FIRE_ANGLE_TOLERANCE_STEPS;
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
