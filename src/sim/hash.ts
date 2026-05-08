import type { ActorState, EffectState, GameState, ProjectileState, ShipState } from './types';

export function hashState(state: GameState): number {
  let hash = 0x811c_9dc5;
  hash = mix(hash, state.frame);
  hash = mix(hash, state.nextProjectileId);
  hash = mix(hash, state.nextEffectId);
  hash = mix(hash, state.rngSeed);
  hash = mix(hash, state.arena.width);
  hash = mix(hash, state.arena.height);
  hash = mix(hash, state.planet.x);
  hash = mix(hash, state.planet.y);
  hash = mix(hash, state.planet.radius);
  hash = mix(hash, state.gameplay.gravityDivisor);
  hash = mix(hash, Math.round(state.gameplay.speedMultiplier * 1000));
  hash = mix(hash, state.winnerId ?? 0xffff_ffff);

  for (const ship of state.ships) {
    hash = mixShip(hash, ship);
  }

  for (const actor of state.actors) {
    hash = mixActor(hash, actor);
  }

  for (const projectile of state.projectiles) {
    hash = mixProjectile(hash, projectile);
  }

  for (const effect of state.effects) {
    hash = mixEffect(hash, effect);
  }

  return hash >>> 0;
}

function mixShip(hash: number, ship: ShipState): number {
  let next = hash;
  next = mix(next, ship.id);
  next = mixString(next, ship.shipId);
  next = mix(next, ship.x);
  next = mix(next, ship.y);
  next = mix(next, ship.vx);
  next = mix(next, ship.vy);
  next = mix(next, ship.angle);
  next = mix(next, ship.crew);
  next = mix(next, ship.maxCrew);
  next = mix(next, ship.battery);
  next = mix(next, ship.maxBattery);
  next = mix(next, ship.batteryChargeFrame);
  next = mix(next, ship.primaryCooldown);
  next = mix(next, ship.secondaryCooldown);
  next = mix(next, ship.freezeFrames);
  next = mix(next, ship.alive ? 1 : 0);
  next = mix(next, ship.custom.frogCharge ?? 0);
  next = mix(next, ship.custom.frogChargeTime ?? 0);
  next = mix(next, ship.custom.frogShielded ? 1 : 0);
  next = mix(next, ship.custom.cannonAngle ?? 0);
  next = mix(next, ship.custom.cameraOverrideX ?? 0);
  next = mix(next, ship.custom.cameraOverrideY ?? 0);
  next = mix(next, ship.custom.krabLongRange ? 1 : 0);
  next = mix(next, ship.custom.pscoutBeamFrames ?? 0);
  next = mix(next, ship.custom.pscoutBeamStrength ?? 0);
  next = mix(next, ship.custom.voskumTeleportAge ?? 0);
  next = mix(next, ship.custom.voskumTeleportFromX ?? 0);
  next = mix(next, ship.custom.voskumTeleportFromY ?? 0);
  next = mix(next, ship.custom.voskumTeleportAngles?.length ?? 0);
  for (const angle of ship.custom.voskumTeleportAngles ?? []) {
    next = mix(next, angle);
  }
  return next;
}

function mixActor(hash: number, actor: ActorState): number {
  let next = hash;
  next = mix(next, actor.id);
  next = mixString(next, actor.kind);
  next = mix(next, actor.ownerId);
  next = mix(next, actor.attachedToShipId);
  next = mix(next, actor.slot);
  next = mix(next, actor.x);
  next = mix(next, actor.y);
  next = mix(next, actor.angle);
  next = mix(next, actor.radius);
  next = mix(next, actor.ttl ?? 0xffff_ffff);
  next = mix(next, actor.active ? 1 : 0);
  return next;
}

function mixProjectile(hash: number, projectile: ProjectileState): number {
  let next = hash;
  next = mix(next, projectile.id);
  next = mix(next, projectile.ownerId);
  next = mixString(next, projectile.kind);
  next = mix(next, projectile.x);
  next = mix(next, projectile.y);
  next = mix(next, projectile.vx);
  next = mix(next, projectile.vy);
  next = mix(next, projectile.angle);
  next = mix(next, projectile.ttl);
  next = mix(next, projectile.damage);
  next = mix(next, projectile.radius);
  next = mix(next, projectile.rotation);
  next = mix(next, projectile.trackPct);
  next = mix(next, projectile.variety);
  next = mix(next, projectile.active ? 1 : 0);
  return next;
}

function mixEffect(hash: number, effect: EffectState): number {
  let next = hash;
  next = mix(next, effect.id);
  next = mixString(next, effect.kind);
  next = mix(next, effect.ownerId);
  next = mix(next, effect.x);
  next = mix(next, effect.y);
  next = mix(next, effect.vx);
  next = mix(next, effect.vy);
  next = mix(next, effect.scale);
  next = mix(next, effect.life);
  next = mix(next, effect.maxLife);
  return next;
}

function mix(hash: number, value: number): number {
  let next = hash;
  let unsigned = value >>> 0;

  for (let i = 0; i < 4; i += 1) {
    next ^= unsigned & 0xff;
    next = Math.imul(next, 0x0100_0193);
    unsigned >>>= 8;
  }

  return next >>> 0;
}

function mixString(hash: number, value: string): number {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next = mix(next, value.charCodeAt(index));
  }
  return next;
}
