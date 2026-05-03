import type { Fixed } from '../sim/fixed';
import { fixedAdd, fixedMul, fixedSub, fixed, fixedSquared, fixedSqrt, fixedToNumber } from '../sim/fixed';
import { getShipSpec } from '../sim/shipSpecs';
import { stepGame } from '../sim/step';
import { ANGLE_STEPS, angle } from '../sim/trig';
import type { ActorState, ArenaState, GameState, ProjectileState, ShipState } from '../sim/types';
import type { OwnerWeaponEventPacket } from './protocol';

export type PlayerIndex = 0 | 1;

export interface OwnerAuthorityStepResult {
  readonly state: GameState;
  readonly frame: number;
}

export class OwnerAuthoritySession {
  private state: GameState;

  public constructor(
    initialState: GameState,
    private readonly localPlayerIndex: PlayerIndex = 0,
  ) {
    this.state = initialState;
  }

  public get currentState(): GameState {
    return this.state;
  }

  public replaceState(state: GameState): void {
    this.state = state;
  }

  public applyOwnerShipState(ship: ShipState, frame: number): boolean {
    const existing = this.state.ships[ship.id];
    if (!existing || existing.id !== ship.id) {
      return false;
    }

    const fastForwardedShip = fastForwardShip(ship, Math.max(0, this.state.frame - frame), this.state.arena);
    this.state = {
      ...this.state,
      ships: this.state.ships.map((candidate) => (candidate.id === ship.id ? fastForwardedShip : candidate)),
      winnerId: getWinnerId(this.state.ships.map((candidate) => (candidate.id === ship.id ? fastForwardedShip : candidate))),
    };
    return true;
  }

  public applyProjectileSpawn(projectile: ProjectileState, frame: number): boolean {
    const fastForwardedProjectile = fastForwardProjectile(projectile, Math.max(0, this.state.frame - frame), this.state);
    if (!fastForwardedProjectile) {
      return false;
    }

    const projectiles = [
      ...this.state.projectiles.filter((candidate) => candidate.id !== fastForwardedProjectile.id),
      fastForwardedProjectile,
    ].sort((left, right) => left.id - right.id);

    this.state = {
      ...this.state,
      projectiles,
      nextProjectileId: Math.max(this.state.nextProjectileId, fastForwardedProjectile.id + 1),
    };
    return true;
  }

  public applyDefenderHit(defenderId: number, projectileId: number, crew: number, alive: boolean): boolean {
    const defender = this.state.ships[defenderId];
    if (!defender) {
      return false;
    }

    const ships = this.state.ships.map((ship) => (ship.id === defenderId ? { ...ship, crew, alive } : ship));
    this.state = {
      ...this.state,
      ships,
      projectiles: this.state.projectiles.filter((projectile) => projectile.id !== projectileId),
      winnerId: getWinnerId(ships),
    };
    return true;
  }

  public applyOwnerWeaponEvent(packet: OwnerWeaponEventPacket): boolean {
    const ship = this.state.ships[packet.ownerId];
    if (!ship) {
      return false;
    }

    const baseShip = fastForwardShip(
      {
        ...ship,
        x: packet.x as Fixed,
        y: packet.y as Fixed,
        vx: packet.vx as Fixed,
        vy: packet.vy as Fixed,
        angle: packet.angle as ShipState['angle'],
      },
      Math.max(0, this.state.frame - packet.frame),
      this.state.arena,
    );

    let nextShip = baseShip;
    if (packet.effectKind === 'frogChargeStart' || packet.effectKind === 'frogChargeUpdate' || packet.effectKind === 'frogCharge') {
      nextShip = {
        ...baseShip,
        custom: {
          ...baseShip.custom,
          frogCharge: packet.strength ?? baseShip.custom.frogCharge ?? 1,
          frogChargeTime: packet.durationFrames ?? baseShip.custom.frogChargeTime ?? 0,
        },
      };
    } else if (packet.effectKind === 'frogChargeRelease') {
      nextShip = {
        ...baseShip,
        custom: {
          ...baseShip.custom,
          frogCharge: 0,
          frogChargeTime: 0,
        },
      };
    } else if (packet.effectKind === 'kronBeam') {
      nextShip = {
        ...baseShip,
        primaryCooldown: Math.max(baseShip.primaryCooldown, packet.durationFrames ?? 10),
      };
    }

    // Some secondary effects spawn attached actors (e.g. Zizlik clones). The receiver
    // needs to mirror that spawn locally because the remote ship's input bits aren't
    // replayed through stepGame, so the secondary fire branch never runs here.
    const spawnedActors: ActorState[] = [];
    let nextActorId = this.state.nextActorId;
    if (packet.effectKind === 'zizlikNode') {
      const node = createZizlikNodeActor(this.state.actors, nextShip, packet.ownerId, nextActorId);
      if (node) {
        spawnedActors.push(node);
        nextActorId += 1;
      }
    }

    this.state = {
      ...this.state,
      ships: this.state.ships.map((candidate) => (candidate.id === packet.ownerId ? nextShip : candidate)),
      actors: spawnedActors.length > 0 ? [...this.state.actors, ...spawnedActors] : this.state.actors,
      nextActorId,
    };
    return true;
  }

  public step(localInput: number, remoteInput = 0): OwnerAuthorityStepResult {
    this.state = this.stepOwnerOnly(this.state, localInput, remoteInput);
    return {
      state: this.state,
      frame: this.state.frame,
    };
  }

  private stepOwnerOnly(state: GameState, localInput: number, remoteInput: number): GameState {
    const remoteShip = state.ships[otherPlayerIndex(this.localPlayerIndex)];
    // The remote ship's authoritative state is replaced via fastForwardShip below, so
    // the only persistent effect of `remoteInput` here is on visual-only state such as
    // dust particles in `state.effects`. Callers are expected to supply only the bits
    // that the remote owner reported (e.g. Thrust) so visuals match the owner's intent.
    const next = stepGame(state, this.localPlayerIndex === 0 ? [localInput, remoteInput] : [remoteInput, localInput]);
    const previousProjectileIds = new Set(state.projectiles.map((projectile) => projectile.id));
    const projectiles = next.projectiles
      .filter((projectile) => projectile.ownerId === this.localPlayerIndex || previousProjectileIds.has(projectile.id))
      .filter((projectile) => projectile.ownerId === this.localPlayerIndex || projectile.active);
    const ships = remoteShip ? next.ships.map((ship) => (ship.id === remoteShip.id ? fastForwardShip(remoteShip, 1, state.arena) : ship)) : next.ships;

    const nextState = {
      ...next,
      ships,
      projectiles,
      nextProjectileId: projectiles.reduce((highest, projectile) => Math.max(highest, projectile.id + 1), state.nextProjectileId),
    };

    return { ...nextState, winnerId: getWinnerId(nextState.ships) };
  }
}

export { OwnerAuthoritySession as RollbackSession };
export type { OwnerAuthorityStepResult as RollbackStepResult };

export function fastForwardShip(ship: ShipState, frames: number, arena: ArenaState): ShipState {
  if (frames <= 0) {
    return ship;
  }

  return {
    ...ship,
    x: advanceWrapped(ship.x, ship.vx, frames, arena.width),
    y: advanceWrapped(ship.y, ship.vy, frames, arena.height),
    primaryCooldown: Math.max(0, ship.primaryCooldown - frames),
    secondaryCooldown: Math.max(0, ship.secondaryCooldown - frames),
    freezeFrames: Math.max(0, ship.freezeFrames - frames),
    custom: {
      ...ship.custom,
      pscoutBeamFrames:
        ship.custom.pscoutBeamFrames === undefined ? undefined : Math.max(0, ship.custom.pscoutBeamFrames - frames),
      voskumTeleportAge:
        ship.custom.voskumTeleportAge === undefined ? undefined : Math.max(0, ship.custom.voskumTeleportAge - frames),
    },
  };
}

export function fastForwardProjectile(projectile: ProjectileState, frames: number, state: GameState): ProjectileState | null {
  if (frames <= 0) {
    return projectile.active && projectile.ttl > 0 ? projectile : null;
  }

  if (projectile.trackPct <= 0) {
    const ttl = projectile.ttl - frames;
    if (ttl <= 0 || !projectile.active) {
      return null;
    }

    return {
      ...projectile,
      x: advanceWrapped(projectile.x, projectile.vx, frames, state.arena.width),
      y: advanceWrapped(projectile.y, projectile.vy, frames, state.arena.height),
      ttl,
      rotation: fixedAdd(projectile.rotation, fixed(0.2 * frames)),
    };
  }

  let next: ProjectileState | null = projectile;
  for (let frame = 0; frame < frames && next; frame += 1) {
    next = stepTrackingProjectile(next, state);
  }
  return next;
}

function advanceWrapped(position: Fixed, velocity: Fixed, frames: number, max: Fixed): Fixed {
  return wrapSignedFixed(fixedAdd(position, fixedMul(velocity, fixed(frames))), max);
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

function stepTrackingProjectile(projectile: ProjectileState, state: GameState): ProjectileState | null {
  if (!projectile.active || projectile.ttl <= 0) {
    return null;
  }

  const steered = steerProjectile(projectile, state);
  const ttl = steered.ttl - 1;
  if (ttl <= 0) {
    return null;
  }

  return {
    ...steered,
    x: advanceWrapped(steered.x, steered.vx, 1, state.arena.width),
    y: advanceWrapped(steered.y, steered.vy, 1, state.arena.height),
    ttl,
    rotation: fixedAdd(steered.rotation, fixed(0.2)),
  };
}

function steerProjectile(projectile: ProjectileState, state: GameState): ProjectileState {
  const enemy = state.ships.find((candidate) => candidate.id !== projectile.ownerId && candidate.alive);
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

  return {
    ...projectile,
    vx: fixedMul(fixed(Math.cos(nextAngle)), speed),
    vy: fixedMul(fixed(Math.sin(nextAngle)), speed),
    angle: angle(Math.round((nextAngle / (Math.PI * 2)) * ANGLE_STEPS)),
  };
}

function wrappedDelta(to: Fixed, from: Fixed, max: Fixed): Fixed {
  const radius = (max / 2) as Fixed;
  let delta = fixedSub(to, from);
  if (delta > radius) {
    delta = fixedSub(delta, max);
  } else if (delta < -radius) {
    delta = fixedAdd(delta, max);
  }
  return delta;
}

function clampRadians(value: number): number {
  let next = value;
  while (next > Math.PI) {
    next -= Math.PI * 2;
  }
  while (next < -Math.PI) {
    next += Math.PI * 2;
  }
  return next;
}

function otherPlayerIndex(playerIndex: PlayerIndex): PlayerIndex {
  return playerIndex === 0 ? 1 : 0;
}

function createZizlikNodeActor(
  actors: readonly ActorState[],
  ship: ShipState,
  ownerId: number,
  nextActorId: number,
): ActorState | null {
  const occupied = new Set(
    actors
      .filter((actor) => actor.active && actor.kind === 'zizlikNode' && actor.ownerId === ownerId)
      .map((actor) => actor.slot),
  );
  const slot = !occupied.has(1) ? 1 : !occupied.has(-1) ? -1 : null;
  if (slot === null) {
    return null;
  }

  return {
    id: nextActorId,
    kind: 'zizlikNode',
    ownerId,
    attachedToShipId: ownerId,
    slot,
    x: ship.x,
    y: ship.y,
    angle: angle(0),
    radius: getShipSpec(ship.shipId).radius,
    ttl: null,
    active: true,
  };
}

function getWinnerId(ships: readonly GameState['ships'][number][]): number | null {
  const living = ships.filter((ship) => ship.alive);
  return living.length === 1 ? living[0].id : null;
}
