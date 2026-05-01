import {
  fixed,
  fixedAdd,
  fixedClamp,
  fixedDiv,
  fixedFromInt,
  fixedMul,
  fixedSqrt,
  fixedSquared,
  fixedSub,
  fixedToNumber,
  type Fixed,
} from './fixed';
import { randomUnit, type RngSeed } from './rng';
import { getShipSpec, type ProjectileKind, type ShipSpec, type WeaponSpec } from './shipSpecs';
import { angle, ANGLE_STEPS, cosFixed, sinFixed, turn, type Angle } from './trig';
import { InputBits, type ActorState, type FrameInputs, type GameState, type ProjectileState, type ShipState } from './types';

const TOP_SPEED_ALLOWANCE = fixedFromInt(2);
const CLOSE_PLANET_SPEED_BOOST = fixedFromInt(2000);
const GRAVITY_STRENGTH = fixedFromInt(1000);
const MIN_GRAVITY_DISTANCE = fixedFromInt(50);
const THRUST_CAP_MIN = fixed(0.06);
const THRUST_CAP_RANGE = fixed(0.94);
const THRUST_CAP_MAX = fixed(1.8);
const OVER_MAX_THRUST_DAMPING = fixed(0.98);
const GRAVITY_SPEED_PRESERVE_MULTIPLIER = fixed(1.8);
const PLANET_COLLISION_BOUNCE = fixed(-0.5);
const FROG_MAX_CHARGE = 8;
const FROG_CHARGE_INTERVAL = 50;
const KRON_SCAN_STEPS = 32;
const KRON_SCAN_SPACING = fixedFromInt(10);
const KRON_FREEZE_FRAMES = 150;
const VOSKUM_BLINK_DISTANCE = fixedFromInt(250);
const VOSKUM_TELEPORT_VISUAL_FRAMES = 24;
const VOSKUM_TELEPORT_IMPRINT_COUNT = 9;
const ZIZLIK_NODE_OFFSET = fixedFromInt(60);
const ZIZLIK_SHOT_UP = angle(64);
const ZIZLIK_SHOT_DOWN = angle(192);
const GOOJ_BACK_NODE_OFFSET = fixedFromInt(-40);
const GOOJ_JUNK_SHOT_VARIANCE_RADIANS = 0.1;
const GOOJ_JUNK_VARIETIES = 7;
const PSCOUT_BEAM_FRAMES = 200;
const PSCOUT_BEAM_DAMAGE_FRAME = 150;
const CANNONADE_SECONDARY_RELOAD_FRAMES = Math.round(0.25 * 60);
const CANNONADE_SECONDARY_ACTIVE_COOLDOWN = 1;

interface DamageEffect {
  readonly targetId: number;
  readonly sourceId: number;
  readonly damage: number;
  readonly piercing?: boolean;
}

interface FreezeEffect {
  readonly targetId: number;
  readonly frames: number;
}

interface ShipStepResult {
  readonly ship: ShipState;
  readonly actors: readonly ActorState[];
  readonly projectiles: readonly ProjectileState[];
  readonly damageEffects: readonly DamageEffect[];
  readonly freezeEffects: readonly FreezeEffect[];
  readonly clearEnemyBeacons?: number;
  readonly rngSeed: RngSeed;
  readonly nextProjectileId: number;
  readonly nextActorId: number;
}

export function stepGame(state: GameState, inputs: FrameInputs): GameState {
  if (state.winnerId !== null) {
    return {
      ...state,
      frame: state.frame + 1,
    };
  }

  let nextProjectileId = state.nextProjectileId;
  let nextActorId = state.nextActorId;
  let rngSeed = state.rngSeed;
  const spawned: ProjectileState[] = [];
  const spawnedActors: ActorState[] = [];
  const damageEffects: DamageEffect[] = [];
  const freezeEffects: FreezeEffect[] = [];
  const clearBeaconsFor = new Set<number>();

  const ships = state.ships.map((ship, index) => {
    const result = stepShip(ship, inputs[index] ?? 0, state, rngSeed, nextProjectileId, nextActorId);
    spawnedActors.push(...result.actors);
    spawned.push(...result.projectiles);
    damageEffects.push(...result.damageEffects);
    freezeEffects.push(...result.freezeEffects);
    if (result.clearEnemyBeacons !== undefined) {
      clearBeaconsFor.add(result.clearEnemyBeacons);
    }
    rngSeed = result.rngSeed;
    nextProjectileId = result.nextProjectileId;
    nextActorId = result.nextActorId;
    return result.ship;
  });

  let affectedShips = applyEffects(ships, damageEffects, freezeEffects, clearBeaconsFor);
  let actors = updateActors([...state.actors, ...spawnedActors], affectedShips, clearBeaconsFor);
  const projectilesBeforeResolution = [...state.projectiles, ...spawned];
  const movedProjectiles = projectilesBeforeResolution
    .map((projectile) => stepProjectile(projectile, { ...state, ships: affectedShips, actors }, rngSeed))
    .filter((projectile) => projectile.active);
  const hitResult = resolveProjectileHits(movedProjectiles, affectedShips, actors, nextActorId);
  affectedShips = hitResult.ships;
  affectedShips = updateCannonadeSecondaryCooldowns(affectedShips, projectilesBeforeResolution, hitResult.projectiles);
  actors = hitResult.actors;
  nextActorId = hitResult.nextActorId;

  return {
    ...state,
    frame: state.frame + 1,
    ships: affectedShips,
    actors,
    projectiles: hitResult.projectiles,
    nextProjectileId,
    nextActorId,
    rngSeed,
    winnerId: hitResult.winnerId,
  };
}

function stepShip(
  ship: ShipState,
  input: number,
  state: GameState,
  rngSeed: RngSeed,
  projectileId: number,
  actorId: number,
): ShipStepResult {
  if (!ship.alive) {
    return emptyShipResult(ship, rngSeed, projectileId, actorId);
  }

  const baseSpec = getShipSpec(ship.shipId);
  const activeSpec = getActiveSpec(ship, baseSpec);
  let shipAngle = ship.angle;
  let cannonAngle = ship.custom.cannonAngle ?? ship.angle;
  let vx = ship.vx;
  let vy = ship.vy;
  let x = ship.x;
  let y = ship.y;
  let battery = ship.battery;
  let batteryChargeFrame = ship.batteryChargeFrame + 1;
  let primaryCooldown = Math.max(0, ship.primaryCooldown - 1);
  let secondaryCooldown = Math.max(0, ship.secondaryCooldown - 1);
  let freezeFrames = Math.max(0, ship.freezeFrames - 1);
  let custom = { ...ship.custom };
  const projectiles: ProjectileState[] = [];
  const actors: ActorState[] = [];
  const damageEffects: DamageEffect[] = [];
  const freezeEffects: FreezeEffect[] = [];
  let clearEnemyBeacons: number | undefined;
  let nextProjectileId = projectileId;
  let nextActorId = actorId;

  if (batteryChargeFrame >= baseSpec.batteryChargeFrames) {
    battery = Math.min(baseSpec.battery, battery + 1);
    batteryChargeFrame = 0;
  }

  const beamFrames = custom.pscoutBeamFrames ?? 0;
  if (beamFrames > 0) {
    const beamStrength = custom.pscoutBeamStrength ?? 0;
    if (beamFrames === PSCOUT_BEAM_DAMAGE_FRAME && beamStrength > 0) {
      const enemy = findEnemy(state.ships, ship.id);
      if (enemy) {
        const beamDamage = beamStrength * beamStrength;
        damageEffects.push({ targetId: enemy.id, sourceId: ship.id, damage: beamDamage });
        if (Math.abs(fixedToNumber(wrappedDelta(ship.y, enemy.y, state.arena.height))) < 40 * beamStrength * baseSpec.renderScale) {
          damageEffects.push({ targetId: ship.id, sourceId: enemy.id, damage: beamDamage });
        }
      }
    }
    custom = { ...custom, pscoutBeamFrames: beamFrames - 1 };
  }

  ({ vx, vy } = applyPlanetGravity(vx, vy, x, y, state, input, activeSpec));

  if ((input & InputBits.TurnLeft) !== 0) {
    shipAngle = turn(shipAngle, -activeSpec.turnStep);
    cannonAngle = turn(cannonAngle, -activeSpec.turnStep);
  }

  if ((input & InputBits.TurnRight) !== 0) {
    shipAngle = turn(shipAngle, activeSpec.turnStep);
    cannonAngle = turn(cannonAngle, activeSpec.turnStep);
  }

  if ((input & InputBits.Thrust) !== 0) {
    const maxSpeed = getShipMaxSpeed(ship.x, ship.y, state, activeSpec);
    const thrustScale = getThrustScale(vx, vy, shipAngle, maxSpeed);
    const thrust = fixedMul(activeSpec.accel, thrustScale);
    vx = fixedAdd(vx, fixedMul(cosFixed(shipAngle), thrust));
    vy = fixedAdd(vy, fixedMul(sinFixed(shipAngle), thrust));
  }

  const speedLimit = getShipMaxSpeed(ship.x, ship.y, state, activeSpec);
  const speed = fixedSqrt(fixedAdd(fixedSquared(vx), fixedSquared(vy)));
  if (speed > speedLimit && (input & InputBits.Thrust) !== 0) {
    vx = fixedMul(vx, OVER_MAX_THRUST_DAMPING);
    vy = fixedMul(vy, OVER_MAX_THRUST_DAMPING);
  }

  ({ vx, vy } = clampVelocity(vx, vy, fixedAdd(speedLimit, TOP_SPEED_ALLOWANCE)));

  if (ship.freezeFrames === 0) {
    x = wrapSignedFixed(fixedAdd(ship.x, vx), state.arena.width);
    y = wrapSignedFixed(fixedAdd(ship.y, vy), state.arena.height);

    if (isShipCollidingWithPlanet(x, y, state, activeSpec)) {
      vx = fixedMul(vx, PLANET_COLLISION_BOUNCE);
      vy = fixedMul(vy, PLANET_COLLISION_BOUNCE);
      x = wrapSignedFixed(fixedAdd(ship.x, vx), state.arena.width);
      y = wrapSignedFixed(fixedAdd(ship.y, vy), state.arena.height);
    }
  }

  if ((input & InputBits.FirePrimary) !== 0) {
    const result = firePrimary(ship, activeSpec, state, {
      x,
      y,
      vx,
      vy,
      shipAngle,
      cannonAngle,
      battery,
      primaryCooldown,
      custom,
      rngSeed,
      nextProjectileId,
      nextActorId,
    });
    projectiles.push(...result.projectiles);
    actors.push(...result.actors);
    damageEffects.push(...result.damageEffects);
    battery = result.battery;
    primaryCooldown = result.primaryCooldown;
    custom = result.custom;
    rngSeed = result.rngSeed;
    nextProjectileId = result.nextProjectileId;
    nextActorId = result.nextActorId;
  } else if (ship.shipId === 'frog' && (custom.frogCharge ?? 0) > 0 && primaryCooldown === 0) {
    const charge = custom.frogCharge ?? 0;
    projectiles.push(
      createProjectile(
        nextProjectileId,
        ship.id,
        'frogBubble',
        x,
        y,
        shipAngle,
        activeSpec.primary.speed,
        52 + 6 * charge,
        charge,
        fixedFromInt(10 + 3 * charge),
      ),
    );
    nextProjectileId += 1;
    primaryCooldown = activeSpec.primary.framesPerShot;
    custom = { ...custom, frogCharge: 0, frogChargeTime: 0 };
  } else if (ship.shipId === 'frog') {
    custom = { ...custom, frogChargeTime: 0 };
  }

  if (ship.shipId === 'voskum') {
    custom = updateVoskumTeleportVisual(custom, x, y, shipAngle, state);
  }

  if ((input & InputBits.FireSecondary) !== 0) {
    const result = fireSecondary(ship, activeSpec, state, {
      x,
      y,
      vx,
      vy,
      shipAngle,
      battery,
      secondaryCooldown,
      custom,
      rngSeed,
      nextProjectileId,
      nextActorId,
    });
    projectiles.push(...result.projectiles);
    actors.push(...result.actors);
    damageEffects.push(...result.damageEffects);
    freezeEffects.push(...result.freezeEffects);
    battery = result.battery;
    secondaryCooldown = result.secondaryCooldown;
    x = result.x;
    y = result.y;
    custom = result.custom;
    rngSeed = result.rngSeed;
    nextProjectileId = result.nextProjectileId;
    nextActorId = result.nextActorId;
    clearEnemyBeacons = result.clearEnemyBeacons;
  }

  if (ship.shipId === 'cannonade') {
    custom = { ...custom, cannonAngle };
  }

  return {
    ship: {
      ...ship,
      x,
      y,
      vx,
      vy,
      angle: shipAngle,
      crew: Math.max(0, ship.crew),
      battery,
      batteryChargeFrame,
      primaryCooldown,
      secondaryCooldown,
      freezeFrames,
      custom,
    },
    actors,
    projectiles,
    damageEffects,
    freezeEffects,
    clearEnemyBeacons,
    rngSeed,
    nextProjectileId,
    nextActorId,
  };
}

function emptyShipResult(ship: ShipState, rngSeed: RngSeed, nextProjectileId: number, nextActorId: number): ShipStepResult {
  return {
    ship,
    actors: [],
    projectiles: [],
    damageEffects: [],
    freezeEffects: [],
    rngSeed,
    nextProjectileId,
    nextActorId,
  };
}

function updateVoskumTeleportVisual(
  custom: ShipState['custom'],
  x: Fixed,
  y: Fixed,
  shipAngle: Angle,
  state: GameState,
): ShipState['custom'] {
  const fromX = custom.voskumTeleportFromX;
  const fromY = custom.voskumTeleportFromY;
  const age = custom.voskumTeleportAge;
  if (fromX === undefined || fromY === undefined || age === undefined) {
    return custom;
  }

  const nextAge = age + 1;
  if (nextAge > VOSKUM_TELEPORT_VISUAL_FRAMES) {
    return clearVoskumTeleportVisual(custom);
  }

  const angles = updateVoskumTeleportAngles(custom.voskumTeleportAngles, shipAngle, nextAge);
  return {
    ...custom,
    cameraOverrideX: lerpWrappedFixed(fromX, x, state.arena.width, nextAge, VOSKUM_TELEPORT_VISUAL_FRAMES),
    cameraOverrideY: lerpWrappedFixed(fromY, y, state.arena.height, nextAge, VOSKUM_TELEPORT_VISUAL_FRAMES),
    voskumTeleportAge: nextAge,
    voskumTeleportAngles: angles,
  };
}

function startVoskumTeleportVisual(
  custom: ShipState['custom'],
  fromX: Fixed,
  fromY: Fixed,
  shipAngle: Angle,
): ShipState['custom'] {
  return {
    ...custom,
    cameraOverrideX: fromX,
    cameraOverrideY: fromY,
    voskumTeleportAge: 0,
    voskumTeleportFromX: fromX,
    voskumTeleportFromY: fromY,
    voskumTeleportAngles: Array.from({ length: VOSKUM_TELEPORT_IMPRINT_COUNT }, () => shipAngle),
  };
}

function updateVoskumTeleportAngles(
  angles: readonly Angle[] | undefined,
  shipAngle: Angle,
  age: number,
): readonly Angle[] {
  const next = Array.from({ length: VOSKUM_TELEPORT_IMPRINT_COUNT }, (_, index) => angles?.[index] ?? shipAngle);
  for (let index = 0; index < next.length; index += 1) {
    const imprintFrame = Math.round((index / Math.max(1, next.length - 1)) * VOSKUM_TELEPORT_VISUAL_FRAMES);
    if (age <= imprintFrame) {
      next[index] = shipAngle;
    }
  }
  return next;
}

function clearVoskumTeleportVisual(custom: ShipState['custom']): ShipState['custom'] {
  const {
    cameraOverrideX,
    cameraOverrideY,
    voskumTeleportAge,
    voskumTeleportFromX,
    voskumTeleportFromY,
    voskumTeleportAngles,
    ...rest
  } = custom;
  void cameraOverrideX;
  void cameraOverrideY;
  void voskumTeleportAge;
  void voskumTeleportFromX;
  void voskumTeleportFromY;
  void voskumTeleportAngles;
  return rest;
}

function lerpWrappedFixed(from: Fixed, to: Fixed, max: Fixed, step: number, totalSteps: number): Fixed {
  const delta = wrappedDelta(to, from, max);
  const t = fixed(step / totalSteps);
  return wrapSignedFixed(fixedAdd(from, fixedMul(delta, t)), max);
}

function getActiveSpec(ship: ShipState, baseSpec: ShipSpec): ShipSpec {
  if (ship.shipId !== 'krab' || !ship.custom.krabLongRange || !baseSpec.longRange) {
    return baseSpec;
  }

  return {
    ...baseSpec,
    turnStep: baseSpec.longRange.turnStep,
    maxSpeed: baseSpec.longRange.maxSpeed,
    accel: baseSpec.longRange.accel,
    primary: baseSpec.longRange.primary,
  };
}

function getThrustScale(vx: Fixed, vy: Fixed, shipAngle: ShipState['angle'], maxSpeed: Fixed): Fixed {
  const speed = fixedSqrt(fixedAdd(fixedSquared(vx), fixedSquared(vy)));
  if (speed === 0) {
    return fixedFromInt(1);
  }

  const headingX = cosFixed(shipAngle);
  const headingY = sinFixed(shipAngle);
  const normalizedVx = fixedDiv(vx, speed);
  const normalizedVy = fixedDiv(vy, speed);
  const headingDot = fixedAdd(fixedMul(normalizedVx, headingX), fixedMul(normalizedVy, headingY));
  const forwardSpeed = fixedMul(headingDot, speed);
  const availableForwardSpeed = fixedDiv(fixedSub(maxSpeed, forwardSpeed), maxSpeed);

  return fixedClamp(fixedAdd(THRUST_CAP_MIN, fixedMul(THRUST_CAP_RANGE, availableForwardSpeed)), THRUST_CAP_MIN, THRUST_CAP_MAX);
}

function getShipMaxSpeed(x: Fixed, y: Fixed, state: GameState, spec: ShipSpec): Fixed {
  const distance = getPlanetDistance(x, y, state);
  if (distance === 0) {
    return spec.maxSpeed;
  }

  return fixedAdd(spec.maxSpeed, fixedDiv(CLOSE_PLANET_SPEED_BOOST, distance));
}

function applyPlanetGravity(
  vx: Fixed,
  vy: Fixed,
  x: Fixed,
  y: Fixed,
  state: GameState,
  input: number,
  spec: ShipSpec,
): { readonly vx: Fixed; readonly vy: Fixed } {
  const relativeX = fixedSub(x, state.planet.x);
  const relativeY = fixedSub(y, state.planet.y);
  const rawDistanceSquared = fixedAdd(fixedSquared(relativeX), fixedSquared(relativeY));
  if (rawDistanceSquared === 0) {
    return { vx, vy };
  }

  const distanceSquared = Math.max(rawDistanceSquared, fixedSquared(MIN_GRAVITY_DISTANCE)) as Fixed;
  const distance = fixedSqrt(distanceSquared);
  const gravityMagnitude = fixedDiv(GRAVITY_STRENGTH, distanceSquared);
  const gravityX = fixedMul(fixedDiv(relativeX, distance), fixedMul(gravityMagnitude, fixed(-1)));
  const gravityY = fixedMul(fixedDiv(relativeY, distance), fixedMul(gravityMagnitude, fixed(-1)));
  const nextVx = fixedAdd(vx, gravityX);
  const nextVy = fixedAdd(vy, gravityY);

  const highSpeed = fixedMul(spec.maxSpeed, GRAVITY_SPEED_PRESERVE_MULTIPLIER);
  const currentSpeedSquared = fixedAdd(fixedSquared(vx), fixedSquared(vy));
  const nextSpeedSquared = fixedAdd(fixedSquared(nextVx), fixedSquared(nextVy));
  if (
    (input & InputBits.Thrust) === 0 &&
    currentSpeedSquared > fixedSquared(highSpeed) &&
    nextSpeedSquared < currentSpeedSquared
  ) {
    return { vx, vy };
  }

  return { vx: nextVx, vy: nextVy };
}

function getPlanetDistance(x: Fixed, y: Fixed, state: GameState): Fixed {
  const dx = fixedSub(x, state.planet.x);
  const dy = fixedSub(y, state.planet.y);
  return fixedSqrt(fixedAdd(fixedSquared(dx), fixedSquared(dy)));
}

function clampVelocity(vx: Fixed, vy: Fixed, maxSpeed: Fixed): { readonly vx: Fixed; readonly vy: Fixed } {
  const speed = fixedSqrt(fixedAdd(fixedSquared(vx), fixedSquared(vy)));
  if (speed <= maxSpeed || speed === 0) {
    return { vx, vy };
  }

  const scale = fixedDiv(maxSpeed, speed);
  return {
    vx: fixedMul(vx, scale),
    vy: fixedMul(vy, scale),
  };
}

function stepProjectile(projectile: ProjectileState, state: GameState, rngSeed: RngSeed): ProjectileState {
  const steered = projectile.trackPct > 0 ? steerProjectile(projectile, state, rngSeed) : projectile;
  const x = wrapSignedFixed(fixedAdd(steered.x, steered.vx), state.arena.width);
  const y = wrapSignedFixed(fixedAdd(steered.y, steered.vy), state.arena.height);
  const ttl = projectile.ttl - 1;

  return {
    ...steered,
    x,
    y,
    ttl,
    rotation: fixedAdd(steered.rotation, fixed(0.2)),
    active: ttl > 0 && !isInsidePlanet(x, y, state.planet.radius, state),
  };
}

function resolveProjectileHits(
  projectiles: readonly ProjectileState[],
  ships: readonly ShipState[],
  actors: readonly ActorState[],
  nextActorId: number,
): {
  readonly ships: readonly ShipState[];
  readonly actors: readonly ActorState[];
  readonly projectiles: readonly ProjectileState[];
  readonly nextActorId: number;
  readonly winnerId: number | null;
} {
  let nextShips = ships;
  let nextActors = actors;
  let nextId = nextActorId;
  const activeProjectiles: ProjectileState[] = [];

  for (const projectile of projectiles) {
    const hit = findProjectileHit(projectile, nextShips, nextActors);
    if (hit) {
      const result = resolveProjectileHit(projectile, hit, nextShips, nextActors, nextId);
      nextShips = result.ships;
      nextActors = result.actors;
      nextId = result.nextActorId;
      continue;
    }

    activeProjectiles.push(projectile);
  }

  return {
    ships: nextShips,
    actors: nextActors,
    projectiles: activeProjectiles,
    nextActorId: nextId,
    winnerId: getWinnerId(nextShips),
  };
}

function updateCannonadeSecondaryCooldowns(
  ships: readonly ShipState[],
  projectilesBeforeResolution: readonly ProjectileState[],
  activeProjectiles: readonly ProjectileState[],
): readonly ShipState[] {
  const previousOwners = getCannonadeSecondaryOwners(projectilesBeforeResolution);
  const activeOwners = getCannonadeSecondaryOwners(activeProjectiles);

  return ships.map((ship) => {
    if (ship.shipId !== 'cannonade') {
      return ship;
    }

    if (activeOwners.has(ship.id)) {
      return ship.secondaryCooldown > 0 ? ship : { ...ship, secondaryCooldown: CANNONADE_SECONDARY_ACTIVE_COOLDOWN };
    }

    return previousOwners.has(ship.id) ? { ...ship, secondaryCooldown: CANNONADE_SECONDARY_RELOAD_FRAMES } : ship;
  });
}

function getCannonadeSecondaryOwners(projectiles: readonly ProjectileState[]): ReadonlySet<number> {
  const owners = new Set<number>();
  for (const projectile of projectiles) {
    if (projectile.active && projectile.kind === 'cannonadeBoomerang') {
      owners.add(projectile.ownerId);
    }
  }
  return owners;
}

function createProjectile(
  id: number,
  ownerId: number,
  kind: ProjectileKind,
  x: Fixed,
  y: Fixed,
  shipAngle: ShipState['angle'],
  speed: Fixed,
  ttl: number,
  damage: number,
  radius: Fixed,
  trackPct: Fixed = fixed(0),
  variety = 0,
): ProjectileState {
  return {
    id,
    ownerId,
    kind,
    x: fixedAdd(x, fixedMul(fixed(0.5), fixedMul(cosFixed(shipAngle), speed))),
    y: fixedAdd(y, fixedMul(fixed(0.5), fixedMul(sinFixed(shipAngle), speed))),
    vx: fixedMul(cosFixed(shipAngle), speed),
    vy: fixedMul(sinFixed(shipAngle), speed),
    angle: shipAngle,
    ttl,
    damage,
    radius,
    rotation: fixed(0),
    trackPct,
    variety,
    active: true,
  };
}

function isShipCollidingWithPlanet(x: Fixed, y: Fixed, state: GameState, spec: ShipSpec): boolean {
  return isInsidePlanet(x, y, fixedAdd(state.planet.radius, spec.radius), state);
}

function isInsidePlanet(x: Fixed, y: Fixed, radius: Fixed, state: GameState): boolean {
  const dx = fixedSub(x, state.planet.x);
  const dy = fixedSub(y, state.planet.y);
  const distanceSquared = fixedAdd(fixedSquared(dx), fixedSquared(dy));
  const radiusSquared = fixedSquared(radius);
  return distanceSquared <= radiusSquared;
}

function isProjectileHittingCircle(projectile: ProjectileState, x: Fixed, y: Fixed, radius: Fixed): boolean {
  const dx = fixedSub(projectile.x, x);
  const dy = fixedSub(projectile.y, y);
  const distanceSquared = fixedAdd(fixedSquared(dx), fixedSquared(dy));
  return distanceSquared <= fixedSquared(fixedAdd(projectile.radius, radius));
}

function wrapSignedFixed(value: Fixed, max: Fixed): Fixed {
  const radius = (max / 2) as Fixed;

  if (value < -radius) {
    return fixedAdd(value, max);
  }

  if (value > radius) {
    return fixedSub(value, max);
  }

  return value;
}

function firePrimary(
  ship: ShipState,
  spec: ShipSpec,
  state: GameState,
  context: {
    readonly x: Fixed;
    readonly y: Fixed;
    readonly vx: Fixed;
    readonly vy: Fixed;
    readonly shipAngle: Angle;
    readonly cannonAngle: Angle;
    readonly battery: number;
    readonly primaryCooldown: number;
    readonly custom: ShipState['custom'];
    readonly rngSeed: RngSeed;
    readonly nextProjectileId: number;
    readonly nextActorId: number;
  },
): {
  readonly actors: readonly ActorState[];
  readonly projectiles: readonly ProjectileState[];
  readonly damageEffects: readonly DamageEffect[];
  readonly battery: number;
  readonly primaryCooldown: number;
  readonly custom: ShipState['custom'];
  readonly rngSeed: RngSeed;
  readonly nextProjectileId: number;
  readonly nextActorId: number;
} {
  let { battery, primaryCooldown, custom, rngSeed, nextProjectileId, nextActorId } = context;
  const actors: ActorState[] = [];
  const projectiles: ProjectileState[] = [];
  const damageEffects: DamageEffect[] = [];

  if (ship.shipId === 'frog') {
    let charge = custom.frogCharge ?? 0;
    let chargeTime = custom.frogChargeTime ?? 0;
    if (primaryCooldown === 0 && chargeTime % FROG_CHARGE_INTERVAL === 0 && battery > 0 && charge < FROG_MAX_CHARGE) {
      charge += 1;
      battery -= 1;
    }
    custom = { ...custom, frogCharge: charge, frogChargeTime: chargeTime + 1 };
    return { actors, projectiles, damageEffects, battery, primaryCooldown, custom, rngSeed, nextProjectileId, nextActorId };
  }

  if (primaryCooldown !== 0 || battery < spec.primary.cost) {
    return { actors, projectiles, damageEffects, battery, primaryCooldown, custom, rngSeed, nextProjectileId, nextActorId };
  }

  switch (ship.shipId) {
    case 'cannonade':
      projectiles.push(spawn(nextProjectileId, ship.id, spec.primary, context.x, context.y, context.cannonAngle));
      nextProjectileId += 1;
      break;
    case 'zizlik':
      for (const node of getZizlikFireOrigins(ship, context.x, context.y, state.actors)) {
        projectiles.push(spawn(nextProjectileId, ship.id, spec.primary, node.x, node.y, ZIZLIK_SHOT_UP));
        nextProjectileId += 1;
        projectiles.push(spawn(nextProjectileId, ship.id, spec.primary, node.x, node.y, ZIZLIK_SHOT_DOWN));
        nextProjectileId += 1;
      }
      break;
    case 'voskum': {
      const roll = nextRandomInt(rngSeed, 3);
      rngSeed = roll.seed;
      const offsetAngle = angle(context.shipAngle + [-64, 0, 64][roll.value]);
      const offsetX = fixedAdd(context.x, fixedMul(cosFixed(offsetAngle), fixedFromInt(10)));
      const offsetY = fixedAdd(context.y, fixedMul(sinFixed(offsetAngle), fixedFromInt(10)));
      projectiles.push(spawn(nextProjectileId, ship.id, spec.primary, offsetX, offsetY, context.shipAngle));
      nextProjectileId += 1;
      break;
    }
    case 'kron': {
      const enemy = findEnemy(state.ships, ship.id);
      if (enemy && isKronBeamHitting(context.x, context.y, context.shipAngle, enemy, state)) {
        damageEffects.push({ targetId: enemy.id, sourceId: ship.id, damage: spec.primary.damage });
      }
      break;
    }
    case 'gooj': {
      const roll = nextRandomInt(rngSeed, 3);
      rngSeed = roll.seed;
      const offsetAngle = angle(context.shipAngle + [-64, 0, 64][roll.value]);
      const offsetX = fixedAdd(context.x, fixedMul(cosFixed(offsetAngle), fixedFromInt(10)));
      const offsetY = fixedAdd(context.y, fixedMul(sinFixed(offsetAngle), fixedFromInt(10)));
      const velocityRoll = nextRandom(rngSeed);
      rngSeed = velocityRoll.seed;
      const shipVelocityScale = fixed(0.65 * (0.5 + velocityRoll.value * 0.5));
      const projectile = spawn(nextProjectileId, ship.id, spec.primary, offsetX, offsetY, context.shipAngle);
      projectiles.push({
        ...projectile,
        vx: fixedAdd(fixedMul(projectile.vx, fixed(0.66)), fixedMul(context.vx, shipVelocityScale)),
        vy: fixedAdd(fixedMul(projectile.vy, fixed(0.66)), fixedMul(context.vy, shipVelocityScale)),
      });
      nextProjectileId += 1;
      break;
    }
    case 'krab':
      if (custom.krabLongRange) {
        projectiles.push(spawn(nextProjectileId, ship.id, spec.primary, context.x, context.y, context.shipAngle));
        nextProjectileId += 1;
      } else {
        for (let index = 0; index < 4; index += 1) {
          const spread = nextRandom(rngSeed);
          rngSeed = spread.seed;
          const offset = radiansToAngleSteps(-0.5 + index * 0.333 + spread.value * 0.35);
          projectiles.push(spawn(nextProjectileId, ship.id, spec.primary, context.x, context.y, angle(context.shipAngle + offset)));
          nextProjectileId += 1;
        }
      }
      break;
    default:
      projectiles.push(spawn(nextProjectileId, ship.id, spec.primary, context.x, context.y, context.shipAngle));
      nextProjectileId += 1;
      break;
  }

  battery -= spec.primary.cost;
  primaryCooldown = spec.primary.framesPerShot;
  return { actors, projectiles, damageEffects, battery, primaryCooldown, custom, rngSeed, nextProjectileId, nextActorId };
}

function fireSecondary(
  ship: ShipState,
  spec: ShipSpec,
  state: GameState,
  context: {
    readonly x: Fixed;
    readonly y: Fixed;
    readonly vx: Fixed;
    readonly vy: Fixed;
    readonly shipAngle: Angle;
    readonly battery: number;
    readonly secondaryCooldown: number;
    readonly custom: ShipState['custom'];
    readonly rngSeed: RngSeed;
    readonly nextProjectileId: number;
    readonly nextActorId: number;
  },
): {
  readonly actors: readonly ActorState[];
  readonly projectiles: readonly ProjectileState[];
  readonly damageEffects: readonly DamageEffect[];
  readonly freezeEffects: readonly FreezeEffect[];
  readonly battery: number;
  readonly secondaryCooldown: number;
  readonly x: Fixed;
  readonly y: Fixed;
  readonly custom: ShipState['custom'];
  readonly rngSeed: RngSeed;
  readonly nextProjectileId: number;
  readonly nextActorId: number;
  readonly clearEnemyBeacons?: number;
} {
  let { battery, secondaryCooldown, custom, rngSeed, nextProjectileId, nextActorId } = context;
  let x = context.x;
  let y = context.y;
  const actors: ActorState[] = [];
  const projectiles: ProjectileState[] = [];
  const damageEffects: DamageEffect[] = [];
  const freezeEffects: FreezeEffect[] = [];
  let clearEnemyBeacons: number | undefined;

  if (secondaryCooldown !== 0 || battery < spec.secondary.cost) {
    return { actors, projectiles, damageEffects, freezeEffects, battery, secondaryCooldown, x, y, custom, rngSeed, nextProjectileId, nextActorId };
  }

  switch (ship.shipId) {
    case 'frog':
      if ((custom.frogShielded ?? false) || battery <= spec.secondary.cost) {
        return { actors, projectiles, damageEffects, freezeEffects, battery, secondaryCooldown, x, y, custom, rngSeed, nextProjectileId, nextActorId };
      }
      custom = { ...custom, frogShielded: true };
      break;
    case 'cannonade':
      if (hasCannonadeSecondaryProjectile(state.projectiles, ship.id)) {
        return { actors, projectiles, damageEffects, freezeEffects, battery, secondaryCooldown, x, y, custom, rngSeed, nextProjectileId, nextActorId };
      }
      projectiles.push(spawn(nextProjectileId, ship.id, spec.secondary, context.x, context.y, context.shipAngle));
      nextProjectileId += 1;
      break;
    case 'krab':
      custom = { ...custom, krabLongRange: !(custom.krabLongRange ?? false) };
      break;
    case 'voskum': {
      const roll = nextRandom(rngSeed);
      rngSeed = roll.seed;
      const blinkAngle = angle(Math.round(roll.value * ANGLE_STEPS));
      const fromX = context.x;
      const fromY = context.y;
      x = wrapSignedFixed(fixedAdd(context.x, fixedMul(cosFixed(blinkAngle), VOSKUM_BLINK_DISTANCE)), state.arena.width);
      y = wrapSignedFixed(fixedAdd(context.y, fixedMul(sinFixed(blinkAngle), VOSKUM_BLINK_DISTANCE)), state.arena.height);
      custom = startVoskumTeleportVisual(custom, fromX, fromY, context.shipAngle);
      break;
    }
    case 'kron': {
      const enemy = findEnemy(state.ships, ship.id);
      if (enemy) {
        freezeEffects.push({ targetId: enemy.id, frames: KRON_FREEZE_FRAMES });
      }
      break;
    }
    case 'zizlik':
      if (!hasActor(state.actors, ship.id, 'zizlikNode', 1)) {
        actors.push(createAttachedActor(nextActorId, 'zizlikNode', ship.id, 1, x, y, angle(0), spec.radius));
        nextActorId += 1;
      } else if (!hasActor(state.actors, ship.id, 'zizlikNode', -1)) {
        actors.push(createAttachedActor(nextActorId, 'zizlikNode', ship.id, -1, x, y, angle(0), spec.radius));
        nextActorId += 1;
      } else {
        return { actors, projectiles, damageEffects, freezeEffects, battery, secondaryCooldown, x, y, custom, rngSeed, nextProjectileId, nextActorId };
      }
      break;
    case 'gooj':
      for (let index = 0; index < 8; index += 1) {
        const lifeRoll = nextRandom(rngSeed);
        rngSeed = lifeRoll.seed;
        const speedRoll = nextRandom(rngSeed);
        rngSeed = speedRoll.seed;
        const velocityRoll = nextRandom(rngSeed);
        rngSeed = velocityRoll.seed;
        const angleRoll = nextRandom(rngSeed);
        rngSeed = angleRoll.seed;
        const varietyRoll = nextRandomInt(rngSeed, GOOJ_JUNK_VARIETIES);
        rngSeed = varietyRoll.seed;
        const junkAngle = angle(
          context.shipAngle + 128 + radiansToAngleSteps(GOOJ_JUNK_SHOT_VARIANCE_RADIANS * (1 - 2 * angleRoll.value)),
        );
        const junkX = fixedAdd(context.x, fixedMul(cosFixed(angle(context.shipAngle + 128)), fixedFromInt(40)));
        const junkY = fixedAdd(context.y, fixedMul(sinFixed(angle(context.shipAngle + 128)), fixedFromInt(40)));
        const junk = spawn(nextProjectileId, ship.id, spec.secondary, junkX, junkY, junkAngle, varietyRoll.value);
        const shotScale = fixed((50 + speedRoll.value * 100) / 150);
        const shipVelocityScale = fixed(0.65 * (0.5 + velocityRoll.value * 0.5));
        projectiles.push({
          ...junk,
          vx: fixedAdd(fixedMul(junk.vx, shotScale), fixedMul(context.vx, shipVelocityScale)),
          vy: fixedAdd(fixedMul(junk.vy, shotScale), fixedMul(context.vy, shipVelocityScale)),
          ttl: spec.secondary.ttl + Math.floor(lifeRoll.value * 720),
        });
        nextProjectileId += 1;
      }
      break;
    case 'pscout': {
      const enemy = findEnemy(state.ships, ship.id);
      const beaconCount = enemy ? countActors(state.actors, 'pscoutBeacon', enemy.id) : 0;
      if (!enemy || beaconCount <= 0) {
        return { actors, projectiles, damageEffects, freezeEffects, battery, secondaryCooldown, x, y, custom, rngSeed, nextProjectileId, nextActorId };
      }
      custom = { ...custom, pscoutBeamFrames: PSCOUT_BEAM_FRAMES, pscoutBeamStrength: beaconCount };
      clearEnemyBeacons = enemy.id;
      break;
    }
  }

  battery -= spec.secondary.cost;
  secondaryCooldown = spec.secondary.framesPerShot;
  return { actors, projectiles, damageEffects, freezeEffects, battery, secondaryCooldown, x, y, custom, rngSeed, nextProjectileId, nextActorId, clearEnemyBeacons };
}

function spawn(
  id: number,
  ownerId: number,
  weapon: WeaponSpec,
  x: Fixed,
  y: Fixed,
  facing: Angle,
  variety = 0,
): ProjectileState {
  return createProjectile(id, ownerId, weapon.kind, x, y, facing, weapon.speed, weapon.ttl, weapon.damage, weapon.radius, weapon.trackPct ?? fixed(0), variety);
}

function hasCannonadeSecondaryProjectile(projectiles: readonly ProjectileState[], ownerId: number): boolean {
  return projectiles.some((projectile) => projectile.active && projectile.ownerId === ownerId && projectile.kind === 'cannonadeBoomerang');
}

function applyEffects(
  ships: readonly ShipState[],
  damageEffects: readonly DamageEffect[],
  freezeEffects: readonly FreezeEffect[],
  _clearBeaconsFor: ReadonlySet<number>,
): readonly ShipState[] {
  let nextShips = ships;
  for (const freeze of freezeEffects) {
    nextShips = nextShips.map((ship) =>
      ship.id === freeze.targetId ? { ...ship, freezeFrames: Math.max(ship.freezeFrames, freeze.frames) } : ship,
    );
  }
  for (const effect of damageEffects) {
    nextShips = nextShips.map((ship) => (ship.id === effect.targetId ? damageShip(ship, effect.damage, effect.piercing) : ship));
  }
  return nextShips;
}

function updateActors(
  actors: readonly ActorState[],
  ships: readonly ShipState[],
  clearBeaconsFor: ReadonlySet<number>,
): readonly ActorState[] {
  return actors
    .filter((actor) => actor.active && !(actor.kind === 'pscoutBeacon' && clearBeaconsFor.has(actor.attachedToShipId)))
    .map((actor) => updateActor(actor, ships))
    .filter((actor) => actor.active && actor.ttl !== 0);
}

function updateActor(actor: ActorState, ships: readonly ShipState[]): ActorState {
  const ship = ships[actor.attachedToShipId];
  if (!ship?.alive) {
    return { ...actor, active: false };
  }

  const ttl = actor.ttl === null ? null : Math.max(0, actor.ttl - 1);
  switch (actor.kind) {
    case 'zizlikNode':
      return {
        ...actor,
        x: fixedAdd(ship.x, fixedMul(ZIZLIK_NODE_OFFSET, fixedFromInt(actor.slot))),
        y: ship.y,
        angle: ship.angle,
        ttl,
      };
    case 'goojBackNode':
      return {
        ...actor,
        x: fixedAdd(ship.x, fixedMul(cosFixed(ship.angle), GOOJ_BACK_NODE_OFFSET)),
        y: fixedAdd(ship.y, fixedMul(sinFixed(ship.angle), GOOJ_BACK_NODE_OFFSET)),
        angle: ship.angle,
        ttl,
      };
    case 'pscoutBeacon':
      return {
        ...actor,
        x: fixedAdd(ship.x, fixedMul(cosFixed(angle(ship.angle + actor.slot * 32)), fixedFromInt(24))),
        y: fixedAdd(ship.y, fixedMul(sinFixed(angle(ship.angle + actor.slot * 32)), fixedFromInt(24))),
        angle: ship.angle,
        ttl,
      };
  }
}

function resolveProjectileHit(
  projectile: ProjectileState,
  hit: ShipHit,
  ships: readonly ShipState[],
  actors: readonly ActorState[],
  nextActorId: number,
): { readonly ships: readonly ShipState[]; readonly actors: readonly ActorState[]; readonly nextActorId: number } {
  if (hit.actor?.kind === 'zizlikNode') {
    return {
      ships,
      actors: actors.filter((actor) => actor.id !== hit.actor?.id),
      nextActorId,
    };
  }

  if (projectile.kind === 'pscoutBeacon') {
    const slot = countActors(actors, 'pscoutBeacon', hit.ship.id);
    return {
      ships,
      actors: [
        ...actors,
        createAttachedActor(nextActorId, 'pscoutBeacon', projectile.ownerId, slot, hit.ship.x, hit.ship.y, hit.ship.angle, projectile.radius, hit.ship.id),
      ],
      nextActorId: nextActorId + 1,
    };
  }

  return {
    ships: ships.map((ship) => (ship.id === hit.ship.id ? damageShip(ship, projectile.damage) : ship)),
    actors,
    nextActorId,
  };
}

function damageShip(ship: ShipState, rawDamage: number, piercing = false): ShipState {
  let damage = rawDamage;
  let custom = ship.custom;
  if (!piercing && ship.shipId === 'frog' && custom.frogShielded) {
    damage -= 1;
    custom = { ...custom, frogShielded: false };
  }
  if (damage <= 0) {
    return { ...ship, custom };
  }

  const crew = Math.max(0, ship.crew - damage);
  return {
    ...ship,
    crew,
    alive: crew > 0,
    custom,
  };
}

interface ShipHit {
  readonly ship: ShipState;
  readonly actor?: ActorState;
}

function findProjectileHit(
  projectile: ProjectileState,
  ships: readonly ShipState[],
  actors: readonly ActorState[],
): ShipHit | null {
  for (const ship of ships) {
    if (!ship.alive || ship.id === projectile.ownerId) {
      continue;
    }

    const spec = getShipSpec(ship.shipId);
    if (isProjectileHittingCircle(projectile, ship.x, ship.y, spec.radius)) {
      return { ship };
    }
  }

  for (const actor of actors) {
    if (!actor.active || actor.ownerId === projectile.ownerId) {
      continue;
    }
    const ship = ships[actor.attachedToShipId];
    if (!ship?.alive || !isProjectileHittingCircle(projectile, actor.x, actor.y, actor.radius)) {
      continue;
    }
    return { ship, actor };
  }

  return null;
}

function getWinnerId(ships: readonly ShipState[]): number | null {
  const living = ships.filter((ship) => ship.alive);
  return living.length === 1 ? living[0].id : null;
}

function findEnemy(ships: readonly ShipState[], ownerId: number): ShipState | null {
  return ships.find((candidate) => candidate.id !== ownerId && candidate.alive) ?? null;
}

function steerProjectile(projectile: ProjectileState, state: GameState, rngSeed: RngSeed): ProjectileState {
  const enemy = findEnemy(state.ships, projectile.ownerId);
  if (!enemy) {
    return projectile;
  }

  const start = Math.atan2(fixedToNumber(projectile.vy), fixedToNumber(projectile.vx));
  const dx = fixedToNumber(wrappedDelta(enemy.x, projectile.x, state.arena.width));
  const dy = fixedToNumber(wrappedDelta(enemy.y, projectile.y, state.arena.height));
  const target = Math.atan2(dy + fixedToNumber(enemy.vy) * 12, dx + fixedToNumber(enemy.vx) * 12);
  const delta = clampRadians(target - start);
  const track = fixedToNumber(projectile.trackPct) * (1 + 1.75 * Math.sin(fixedToNumber(projectile.rotation)));
  const turnAmount = Math.min(Math.abs(delta), Math.abs(track)) * Math.sign(delta) * Math.sign(track || 1);
  const nextAngle = start + turnAmount;
  const speed = fixedSqrt(fixedAdd(fixedSquared(projectile.vx), fixedSquared(projectile.vy)));

  void rngSeed;
  return {
    ...projectile,
    vx: fixedMul(fixed(Math.cos(nextAngle)), speed),
    vy: fixedMul(fixed(Math.sin(nextAngle)), speed),
    angle: angle(Math.round((nextAngle / (Math.PI * 2)) * ANGLE_STEPS)),
  };
}

function isKronBeamHitting(x: Fixed, y: Fixed, facing: Angle, enemy: ShipState, state: GameState): boolean {
  const enemyRadius = getShipSpec(enemy.shipId).radius;
  for (let index = 0; index < KRON_SCAN_STEPS; index += 1) {
    const distance = fixedMul(KRON_SCAN_SPACING, fixedFromInt(index));
    const probeX = wrapSignedFixed(fixedAdd(x, fixedMul(cosFixed(facing), distance)), state.arena.width);
    const probeY = wrapSignedFixed(fixedAdd(y, fixedMul(sinFixed(facing), distance)), state.arena.height);
    const dx = wrappedDelta(enemy.x, probeX, state.arena.width);
    const dy = wrappedDelta(enemy.y, probeY, state.arena.height);
    const scanRadius = fixedAdd(fixedFromInt(Math.max(1, 45 - index)), enemyRadius);
    if (fixedAdd(fixedSquared(dx), fixedSquared(dy)) <= fixedSquared(scanRadius)) {
      return true;
    }
  }
  return false;
}

function getZizlikFireOrigins(
  ship: ShipState,
  x: Fixed,
  y: Fixed,
  actors: readonly ActorState[],
): readonly { readonly x: Fixed; readonly y: Fixed }[] {
  return [
    { x, y },
    ...actors
      .filter((actor) => actor.kind === 'zizlikNode' && actor.ownerId === ship.id)
      .map((actor) => ({ x: actor.x, y: actor.y })),
  ];
}

function createAttachedActor(
  id: number,
  kind: ActorState['kind'],
  ownerId: number,
  slot: number,
  x: Fixed,
  y: Fixed,
  facing: Angle,
  radius: Fixed,
  attachedToShipId = ownerId,
): ActorState {
  return {
    id,
    kind,
    ownerId,
    attachedToShipId,
    slot,
    x,
    y,
    angle: facing,
    radius,
    ttl: null,
    active: true,
  };
}

function hasActor(actors: readonly ActorState[], ownerId: number, kind: ActorState['kind'], slot: number): boolean {
  return actors.some((actor) => actor.active && actor.ownerId === ownerId && actor.kind === kind && actor.slot === slot);
}

function countActors(actors: readonly ActorState[], kind: ActorState['kind'], attachedToShipId: number): number {
  return actors.filter((actor) => actor.active && actor.kind === kind && actor.attachedToShipId === attachedToShipId).length;
}

function nextRandom(seed: RngSeed): { readonly seed: RngSeed; readonly value: number } {
  return randomUnit(seed);
}

function nextRandomInt(seed: RngSeed, maxExclusive: number): { readonly seed: RngSeed; readonly value: number } {
  const result = nextRandom(seed);
  return { seed: result.seed, value: Math.floor(result.value * maxExclusive) };
}

function radiansToAngleSteps(radians: number): number {
  return Math.round((radians / (Math.PI * 2)) * ANGLE_STEPS);
}

function wrappedDelta(a: Fixed, b: Fixed, max: Fixed): Fixed {
  let delta = fixedSub(a, b);
  const radius = (max / 2) as Fixed;
  if (delta > radius) {
    delta = fixedSub(delta, max);
  } else if (delta < -radius) {
    delta = fixedAdd(delta, max);
  }
  return delta;
}

function clampRadians(radians: number): number {
  let value = radians;
  while (value > Math.PI) {
    value -= Math.PI * 2;
  }
  while (value < -Math.PI) {
    value += Math.PI * 2;
  }
  return value;
}
