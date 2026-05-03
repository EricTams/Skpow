import { describe, expect, it } from 'vitest';

import { fixed, fixedFromInt, fixedToNumber, type Fixed } from './fixed';
import { hashState } from './hash';
import { runReplay } from './replay';
import { getShipSpec } from './shipSpecs';
import { createInitialState } from './state';
import { getThrustPipCount, stepGame } from './step';
import { angle } from './trig';
import { InputBits, type GameState, type ProjectileState, type ShipState } from './types';

describe('sudden-death match loop', () => {
  it('ends the match when a projectile hits the opposing ship', () => {
    const state = withProjectileAtShip(createInitialState(123), 0, 1);

    const next = stepGame(state, [0, 0]);

    expect(next.winnerId).toBe(0);
    expect(next.ships[1].alive).toBe(false);
    expect(next.ships[0].alive).toBe(true);
    expect(next.projectiles).toHaveLength(0);
  });

  it('keeps the match active when a projectile misses', () => {
    const state = {
      ...createInitialState(123),
      projectiles: [buildProjectile({ ownerId: 0, x: fixedFromInt(1000), y: fixedFromInt(1000) })],
    };

    const next = stepGame(state, [0, 0]);

    expect(next.winnerId).toBeNull();
    expect(next.ships.every((ship) => ship.alive)).toBe(true);
    expect(next.projectiles).toHaveLength(1);
  });

  it('does not let a projectile hit its owner', () => {
    const state = withProjectileAtShip(createInitialState(123), 1, 1);

    const next = stepGame(state, [0, 0]);

    expect(next.winnerId).toBeNull();
    expect(next.ships[1].alive).toBe(true);
  });

  it('freezes movement, firing, and winner changes after the decisive hit', () => {
    const ended = stepGame(withProjectileAtShip(createInitialState(123), 0, 1), [0, 0]);
    const afterEnd = stepGame(ended, [InputBits.Thrust | InputBits.FirePrimary, InputBits.Thrust | InputBits.FirePrimary]);

    expect(afterEnd.winnerId).toBe(0);
    expect(afterEnd.ships).toEqual(ended.ships);
    expect(afterEnd.projectiles).toEqual(ended.projectiles);
    expect(afterEnd.frame).toBe(ended.frame + 1);
  });

  it('keeps sudden-death results deterministic under replay', () => {
    const state = withProjectileAtShip(createInitialState(123), 0, 1);
    const first = runReplay(state, [[0, 0], [InputBits.Thrust, InputBits.FirePrimary]], hashState);
    const second = runReplay(state, [[0, 0], [InputBits.Thrust, InputBits.FirePrimary]], hashState);

    expect(first.frameHashes).toEqual(second.frameHashes);
    expect(first.finalState.winnerId).toBe(0);
    expect(second.finalState.winnerId).toBe(0);
  });
});

describe('death explosion effect', () => {
  it('spawns three ship explosions clustered around the dying ship', () => {
    const next = stepGame(withProjectileAtShip(createInitialState(123), 0, 1), [0, 0]);
    const target = next.ships[1];
    const explosions = next.effects.filter((effect) => effect.kind === 'shipExplosion');

    expect(explosions).toHaveLength(3);
    expect(new Set(explosions.map((effect) => effect.life))).toEqual(new Set([80, 110, 140]));
    expect(explosions.every((effect) => effect.life === effect.maxLife)).toBe(true);
    for (const effect of explosions) {
      expect(Math.abs(fixedToNumber(effect.x) - fixedToNumber(target.x))).toBeLessThanOrEqual(50);
      expect(Math.abs(fixedToNumber(effect.y) - fixedToNumber(target.y))).toBeLessThanOrEqual(50);
    }
  });

  it('decrements explosion life each frame and clears them when the longest one expires', () => {
    let state = stepGame(withProjectileAtShip(createInitialState(123), 0, 1), [0, 0]);
    const longestLife = Math.max(...state.effects.map((effect) => effect.life));

    for (let frame = 0; frame < longestLife - 1; frame += 1) {
      state = stepGame(state, [0, 0]);
    }

    expect(state.effects).toHaveLength(1);
    expect(state.effects[0].life).toBe(1);

    state = stepGame(state, [0, 0]);
    expect(state.effects).toHaveLength(0);
  });

  it('keeps the explosion lifecycle deterministic under replay', () => {
    const initial = withProjectileAtShip(createInitialState(123), 0, 1);
    const inputs = Array.from({ length: 50 }, () => [0, 0] as const);
    const first = runReplay(initial, inputs, hashState);
    const second = runReplay(initial, inputs, hashState);

    expect(first.frameHashes).toEqual(second.frameHashes);
    expect(first.finalState.effects).toEqual(second.finalState.effects);
  });
});

describe('thrust dust effect', () => {
  it('does not spawn dust when thrust is not held', () => {
    let state = createInitialState(123);
    for (let frame = 0; frame < 30; frame += 1) {
      state = stepGame(state, [0, 0]);
    }

    expect(state.effects.filter((effect) => effect.kind === 'thrustDust')).toHaveLength(0);
  });

  it('spawns thrust dust behind the ship while thrust is held', () => {
    const state = createInitialState(123, ['frog', 'cannonade']);
    const next = stepGame(state, [InputBits.Thrust, 0]);
    const dust = next.effects.filter((effect) => effect.kind === 'thrustDust' && effect.ownerId === 0);

    expect(dust.length).toBeGreaterThan(0);
    expect(dust.every((effect) => effect.life === effect.maxLife)).toBe(true);
    // Each particle should sit behind the ship: dot(particle - ship, facing) <= 0.
    const ship = next.ships[0];
    const facingX = Math.cos((ship.angle / 256) * Math.PI * 2);
    const facingY = Math.sin((ship.angle / 256) * Math.PI * 2);
    for (const effect of dust) {
      const dx = fixedToNumber(effect.x) - fixedToNumber(ship.x);
      const dy = fixedToNumber(effect.y) - fixedToNumber(ship.y);
      expect(dx * facingX + dy * facingY).toBeLessThanOrEqual(0.5);
    }
  });

  it('uses more pips for ships with higher accel * area force', () => {
    const frogPips = getThrustPipCount(getShipSpec('frog'));
    const zizlikPips = getThrustPipCount(getShipSpec('zizlik'));
    const goojPips = getThrustPipCount(getShipSpec('gooj'));

    expect(frogPips).toBeGreaterThanOrEqual(1);
    expect(goojPips).toBeGreaterThanOrEqual(1);
    expect(zizlikPips).toBeGreaterThan(frogPips);
  });

  it('emits a fresh batch of dust on each spawn interval', () => {
    let state = createInitialState(123, ['zizlik', 'cannonade']);
    const seenIds = new Set<number>();
    let spawnedBatches = 0;
    for (let frame = 0; frame < 25; frame += 1) {
      state = stepGame(state, [InputBits.Thrust, 0]);
      const myDust = state.effects.filter((effect) => effect.kind === 'thrustDust' && effect.ownerId === 0);
      const fresh = myDust.filter((effect) => effect.life === effect.maxLife && !seenIds.has(effect.id));
      if (fresh.length > 0) {
        spawnedBatches += 1;
        for (const effect of fresh) {
          seenIds.add(effect.id);
        }
      }
    }

    expect(spawnedBatches).toBeGreaterThanOrEqual(2);
  });

  it('expires thrust dust after its life span when thrust stops', () => {
    let state = createInitialState(123);
    state = stepGame(state, [InputBits.Thrust, 0]);
    const initialDust = state.effects.filter((effect) => effect.kind === 'thrustDust');
    expect(initialDust.length).toBeGreaterThan(0);
    const longestLife = Math.max(...initialDust.map((effect) => effect.life));

    for (let frame = 0; frame < longestLife; frame += 1) {
      state = stepGame(state, [0, 0]);
    }

    expect(state.effects.filter((effect) => effect.kind === 'thrustDust')).toHaveLength(0);
  });

  it('keeps thrust dust deterministic under replay', () => {
    const initial = createInitialState(123);
    const inputs = Array.from({ length: 30 }, () => [InputBits.Thrust, 0] as const);
    const first = runReplay(initial, inputs, hashState);
    const second = runReplay(initial, inputs, hashState);

    expect(first.frameHashes).toEqual(second.frameHashes);
    expect(first.finalState.effects).toEqual(second.finalState.effects);
  });
});

describe('ship physics', () => {
  it('starts in the signed legacy-sized wrapped arena', () => {
    const state = createInitialState(123);

    expect(state.arena.width).toBe(fixedFromInt(2900));
    expect(state.arena.height).toBe(fixedFromInt(2900));
    expect(state.planet.x).toBe(fixedFromInt(0));
    expect(state.planet.y).toBe(fixedFromInt(0));
    expect(state.planet.radius).toBe(fixedFromInt(80));
    expect(state.ships[0].x).toBe(fixedFromInt(425));
    expect(state.ships[0].y).toBe(fixedFromInt(425));
    expect(state.ships[1].x).toBe(fixedFromInt(-425));
    expect(state.ships[1].y).toBe(fixedFromInt(-425));
  });

  it('wraps ship positions through signed legacy bounds', () => {
    const state = withShip(createInitialState(123), { x: fixedFromInt(1449), y: fixedFromInt(-1449), vx: fixed(3), vy: fixed(-3) });

    const next = stepGame(state, [0, 0]).ships[0];

    expect(next.x).toBeLessThan(fixedFromInt(-1440));
    expect(next.y).toBeGreaterThan(fixedFromInt(1440));
  });

  it('turns in responsive fine-grained angle steps', () => {
    const state = createInitialState(123);
    const oneFrame = stepGame(state, [InputBits.TurnRight, 0]);
    const twoFrames = stepGame(oneFrame, [InputBits.TurnRight, 0]);

    expect(oneFrame.ships[0].angle).toBe(angle(0));
    expect(twoFrames.ships[0].angle).toBe(angle(1));
  });

  it('sweeps the cannonade barrel ahead of its hull while turning', () => {
    let state = createInitialState(123, ['cannonade', 'frog']);
    for (let frame = 0; frame < 20; frame += 1) {
      state = stepGame(state, [InputBits.TurnRight, 0]);
    }

    const cannonade = state.ships[0];
    const cannon = cannonade.custom.cannonAngle ?? cannonade.angle;
    const cannonOffset = (cannon - cannonade.angle) & 255;
    expect(cannonOffset).toBeGreaterThan(0);
    expect(cannonOffset).toBeLessThanOrEqual(128);
  });

  it('preserves the reference krab turn-rate ratio between short and long range forms', () => {
    const seeded = createInitialState(123, ['krab', 'frog']);
    const krabShortRange: GameState = {
      ...seeded,
      ships: seeded.ships.map((ship) =>
        ship.id === 0
          ? { ...ship, custom: { ...ship.custom, krabLongRange: false }, angle: angle(0) }
          : ship,
      ),
    };
    const krabLongRange: GameState = {
      ...seeded,
      ships: seeded.ships.map((ship) =>
        ship.id === 0
          ? { ...ship, custom: { ...ship.custom, krabLongRange: true }, angle: angle(0) }
          : ship,
      ),
    };

    const stepsToRotateOnce = (initial: GameState): number => {
      let state = initial;
      let frames = 0;
      while (state.ships[0].angle === angle(0)) {
        state = stepGame(state, [InputBits.TurnRight, 0]);
        frames += 1;
        if (frames > 1000) {
          throw new Error('ship never advanced an angle step');
        }
      }
      return frames;
    };

    const shortFrames = stepsToRotateOnce(krabShortRange);
    const longFrames = stepsToRotateOnce(krabLongRange);

    expect(longFrames).toBeGreaterThan(shortFrames * 2);
  });

  it('uses stronger planet gravity near the planet than farther away', () => {
    const state = createInitialState(123);
    const near = stepGame(withShip(state, { x: fixedFromInt(200), y: state.planet.y }), [0, 0]).ships[0];
    const far = stepGame(withShip(state, { x: fixedFromInt(400), y: state.planet.y }), [0, 0]).ships[0];

    expect(near.vx).toBeLessThan(0);
    expect(far.vx).toBeLessThan(0);
    expect(Math.abs(fixedToNumber(near.vx))).toBeGreaterThan(Math.abs(fixedToNumber(far.vx)) * 3);
  });

  it('lets a ship thrust away from the planet well', () => {
    let state = withShip(createInitialState(123, ['zizlik', 'cannonade']), { x: fixedFromInt(120), y: fixedFromInt(0), angle: angle(0) });

    for (let frame = 0; frame < 60; frame += 1) {
      state = stepGame(state, [InputBits.Thrust, 0]);
    }

    expect(state.ships[0].x).toBeGreaterThan(fixedFromInt(120));
  });
});

describe('reference-backed ship abilities', () => {
  it('initializes selected ships with their reference crew and battery', () => {
    const state = createInitialState(123, ['zizlik', 'pscout']);

    expect(state.ships[0]).toMatchObject({ shipId: 'zizlik', crew: 10, maxCrew: 10, battery: 12, maxBattery: 12 });
    expect(state.ships[1]).toMatchObject({ shipId: 'pscout', crew: 8, maxCrew: 8, battery: 4, maxBattery: 4 });
  });

  it('charges and releases Frog bubbles using battery', () => {
    const charging = stepGame(createInitialState(123, ['frog', 'cannonade']), [InputBits.FirePrimary, 0]);
    const released = stepGame(charging, [0, 0]);

    expect(charging.ships[0].battery).toBe(29);
    expect(charging.ships[0].custom.frogCharge).toBe(1);
    expect(released.projectiles).toHaveLength(1);
    expect(released.projectiles[0]).toMatchObject({ kind: 'frogBubble', damage: 1, ttl: 57 });
  });

  it('lets the Frog shield absorb one incoming damage then clear', () => {
    const shielded = stepGame(createInitialState(123, ['frog', 'cannonade']), [InputBits.FireSecondary, 0]);
    const hit = stepGame(withProjectileAtShip(shielded, 1, 0, 1), [0, 0]);

    expect(shielded.ships[0].battery).toBe(28);
    expect(shielded.ships[0].custom.frogShielded).toBe(true);
    expect(hit.ships[0].crew).toBe(30);
    expect(hit.ships[0].custom.frogShielded).toBe(false);
  });

  it('fires Cannonade primary shots with real cost and damage', () => {
    const state = createInitialState(123, ['cannonade', 'frog']);
    const next = stepGame(state, [InputBits.FirePrimary, 0]);

    expect(next.ships[0].battery).toBe(18);
    expect(next.ships[0].primaryCooldown).toBe(75);
    expect(next.projectiles[0]).toMatchObject({ kind: 'cannonadeBall', damage: 7, ttl: 154 });
  });

  it('fires straight shots along the aiming angle', () => {
    const state = withShip(createInitialState(123, ['cannonade', 'frog']), {
      x: fixedFromInt(500),
      y: fixedFromInt(0),
      angle: angle(0),
      custom: { cannonAngle: angle(0) },
    });

    const next = stepGame(state, [InputBits.FirePrimary, 0]);

    expect(next.projectiles[0].vx).toBeGreaterThan(0);
    expect(Math.abs(next.projectiles[0].vy)).toBeLessThan(fixed(0.001));
  });

  it('turns tracking projectiles toward their target', () => {
    const state = {
      ...createInitialState(123, ['cannonade', 'frog']),
      ships: [
        { ...createInitialState(123, ['cannonade', 'frog']).ships[0], x: fixedFromInt(500), y: fixedFromInt(0) },
        { ...createInitialState(123, ['cannonade', 'frog']).ships[1], x: fixedFromInt(500), y: fixedFromInt(400) },
      ],
      projectiles: [
        buildProjectile({
          ownerId: 0,
          x: fixedFromInt(500),
          y: fixedFromInt(0),
          kind: 'cannonadeBoomerang',
          vx: fixedFromInt(4),
          vy: fixed(0),
          trackPct: fixed(0.0085),
        }),
      ],
    };

    const next = stepGame(state, [0, 0]);

    expect(next.projectiles[0].vy).toBeGreaterThan(0);
    expect(next.projectiles[0].vx).toBeGreaterThan(0);
  });

  it('only allows one Cannonade secondary projectile at a time', () => {
    const state = {
      ...createInitialState(123, ['cannonade', 'frog']),
      projectiles: [
        buildProjectile({
          ownerId: 0,
          x: fixedFromInt(1000),
          y: fixedFromInt(1000),
          kind: 'cannonadeBoomerang',
          ttl: 100,
        }),
      ],
      nextProjectileId: 100,
    };

    const next = stepGame(state, [InputBits.FireSecondary, 0]);

    expect(next.projectiles.filter((projectile) => projectile.kind === 'cannonadeBoomerang' && projectile.ownerId === 0)).toHaveLength(1);
    expect(next.ships[0].battery).toBe(24);
    expect(next.ships[0].secondaryCooldown).toBeGreaterThan(0);
  });

  it('reloads Cannonade secondary 0.25 seconds after its projectile dies', () => {
    const initial = createInitialState(123, ['cannonade', 'frog']);
    let state: GameState = {
      ...initial,
      ships: [{ ...initial.ships[0], secondaryCooldown: 1 }, initial.ships[1]],
      projectiles: [
        buildProjectile({
          ownerId: 0,
          x: fixedFromInt(1000),
          y: fixedFromInt(1000),
          kind: 'cannonadeBoomerang',
          ttl: 1,
        }),
      ],
      nextProjectileId: 100,
    };

    state = stepGame(state, [InputBits.FireSecondary, 0]);

    expect(state.projectiles.filter((projectile) => projectile.kind === 'cannonadeBoomerang' && projectile.ownerId === 0)).toHaveLength(0);
    expect(state.ships[0].secondaryCooldown).toBe(15);

    for (let frame = 0; frame < 14; frame += 1) {
      state = stepGame(state, [InputBits.FireSecondary, 0]);
      expect(state.projectiles.filter((projectile) => projectile.kind === 'cannonadeBoomerang' && projectile.ownerId === 0)).toHaveLength(0);
    }

    const refired = stepGame(state, [InputBits.FireSecondary, 0]);

    expect(refired.projectiles.filter((projectile) => projectile.kind === 'cannonadeBoomerang' && projectile.ownerId === 0)).toHaveLength(1);
    expect(refired.ships[0].battery).toBe(20);
  });

  it('toggles Krab form and fires the active primary profile', () => {
    const toggled = stepGame(createInitialState(123, ['krab', 'frog']), [InputBits.FireSecondary, 0]);
    const fired = stepGame(toggled, [InputBits.FirePrimary, 0]);

    expect(toggled.ships[0].custom.krabLongRange).toBe(true);
    expect(toggled.ships[0].battery).toBe(15);
    expect(fired.projectiles[0].kind).toBe('krabLong');
  });

  it('blinks Voskum deterministically with seeded RNG', () => {
    const state = createInitialState(123, ['voskum', 'frog']);
    const first = stepGame(state, [InputBits.FireSecondary, 0]);
    const second = stepGame(state, [InputBits.FireSecondary, 0]);

    expect(first.ships[0].battery).toBe(16);
    expect(first.ships[0].secondaryCooldown).toBe(150);
    expect(first.ships[0].x).not.toBe(state.ships[0].x);
    expect(first.ships[0].x).toBe(second.ships[0].x);
    expect(first.ships[0].y).toBe(second.ships[0].y);
    expect(first.ships[0].custom.cameraOverrideX).toBe(first.ships[0].custom.voskumTeleportFromX);
    expect(first.ships[0].custom.cameraOverrideY).toBe(first.ships[0].custom.voskumTeleportFromY);
    expect(first.ships[0].custom.voskumTeleportAge).toBe(0);
    expect(first.ships[0].custom.voskumTeleportAngles).toHaveLength(9);
  });

  it('advances Voskum teleport camera and freezes imprint rotations over time', () => {
    const blinked = stepGame(createInitialState(123, ['voskum', 'frog']), [InputBits.FireSecondary, 0]);
    const turned = stepGame(blinked, [InputBits.TurnRight, 0]);
    const angles = turned.ships[0].custom.voskumTeleportAngles ?? [];

    expect(turned.ships[0].custom.voskumTeleportAge).toBe(1);
    expect(turned.ships[0].custom.cameraOverrideX).not.toBe(blinked.ships[0].custom.cameraOverrideX);
    expect(angles[0]).toBe(blinked.ships[0].angle);
    expect(angles[angles.length - 1]).toBe(turned.ships[0].angle);

    let expired = blinked;
    for (let frame = 0; frame < 25; frame += 1) {
      expired = stepGame(expired, [0, 0]);
    }

    expect(expired.ships[0].custom.cameraOverrideX).toBeUndefined();
    expect(expired.ships[0].custom.voskumTeleportAge).toBeUndefined();
  });

  it('freezes Kron targets with its special', () => {
    const next = stepGame(createInitialState(123, ['kron', 'frog']), [InputBits.FireSecondary, 0]);

    expect(next.ships[0].battery).toBe(12);
    expect(next.ships[1].freezeFrames).toBe(150);
  });

  it('spawns Zizlik mirror nodes and shoots from them', () => {
    const withNode = stepGame(createInitialState(123, ['zizlik', 'frog']), [InputBits.FireSecondary, 0]);
    const recharged = withShip(withNode, { battery: 2 });
    const fired = stepGame(recharged, [InputBits.FirePrimary, 0]);

    expect(withNode.actors.filter((actor) => actor.kind === 'zizlikNode' && actor.ownerId === 0)).toHaveLength(1);
    expect(withNode.ships[0].battery).toBe(0);
    expect(fired.projectiles).toHaveLength(4);
    expect(fired.projectiles.every((projectile) => Math.abs(fixedToNumber(projectile.vx)) < 0.001)).toBe(true);
    expect(fired.projectiles.filter((projectile) => projectile.vy > 0)).toHaveLength(2);
    expect(fired.projectiles.filter((projectile) => projectile.vy < 0)).toHaveLength(2);
  });

  it('spawns Gooj junk bursts', () => {
    const state = withShip(createInitialState(123, ['gooj', 'frog']), {
      x: fixedFromInt(500),
      y: fixedFromInt(0),
      vx: fixed(0),
      vy: fixed(0),
      angle: angle(0),
    });
    const next = stepGame(state, [InputBits.FireSecondary, 0]);

    expect(next.ships[0].battery).toBe(6);
    expect(next.projectiles).toHaveLength(8);
    expect(next.projectiles.every((projectile) => projectile.kind === 'goojJunk')).toBe(true);
    expect(next.projectiles.every((projectile) => projectile.variety >= 0 && projectile.variety < 7)).toBe(true);
    expect(new Set(next.projectiles.map((projectile) => projectile.variety)).size).toBeGreaterThan(1);
    expect(next.projectiles.every((projectile) => projectile.vx < 0)).toBe(true);
    expect(next.projectiles.every((projectile) => fixedToNumber(next.ships[0].x) - fixedToNumber(projectile.x) > 30)).toBe(true);
  });

  it('does not let a ship damage itself by shooting an enemy actor riding on its hull', () => {
    const seeded = createInitialState(123, ['pscout', 'zizlik']);
    const target = seeded.ships[1];
    const beacon = {
      id: 200,
      kind: 'pscoutBeacon' as const,
      ownerId: 0,
      attachedToShipId: 1,
      slot: 0,
      x: target.x,
      y: target.y,
      angle: target.angle,
      radius: fixedFromInt(10),
      ttl: null,
      active: true,
    };
    const state: GameState = {
      ...seeded,
      actors: [...seeded.actors, beacon],
      projectiles: [
        buildProjectile({ ownerId: 1, x: target.x, y: target.y, damage: 1, kind: 'zizlikShot' }),
      ],
      nextProjectileId: 300,
    };

    const next = stepGame(state, [0, 0]);

    expect(next.ships[1].crew).toBe(target.crew);
    expect(next.actors.filter((actor) => actor.kind === 'pscoutBeacon')).toHaveLength(1);
  });

  it('attaches pScout beacons and spends them with the beam special', () => {
    const beaconHit = stepGame(withProjectileAtShip(createInitialState(123, ['pscout', 'frog']), 0, 1, 0, 'pscoutBeacon'), [0, 0]);
    const withBeacons = withShip(beaconHit, { custom: { ...beaconHit.ships[0].custom } });
    const readyToBeam = {
      ...withBeacons,
      actors: [
        ...withBeacons.actors,
        {
          ...withBeacons.actors[0],
          id: 101,
          slot: 1,
        },
      ],
    };
    let beamed = stepGame(readyToBeam, [InputBits.FireSecondary, 0]);
    expect(beamed.ships[0].battery).toBe(2);

    for (let frame = 0; frame < 151; frame += 1) {
      beamed = stepGame(beamed, [0, 0]);
    }

    expect(beaconHit.actors.filter((actor) => actor.kind === 'pscoutBeacon' && actor.attachedToShipId === 1)).toHaveLength(1);
    expect(beamed.ships[1].crew).toBe(26);
    expect(beamed.actors.filter((actor) => actor.kind === 'pscoutBeacon' && actor.attachedToShipId === 1)).toHaveLength(0);
  });
});

function withProjectileAtShip(
  state: GameState,
  ownerId: number,
  targetShipId: number,
  damage = 99,
  kind: ProjectileState['kind'] = 'generic',
): GameState {
  const target = state.ships[targetShipId];
  return {
    ...state,
    projectiles: [buildProjectile({ ownerId, x: target.x, y: target.y, damage, kind })],
    nextProjectileId: 100,
  };
}

function withShip(state: GameState, ship: Partial<ShipState>): GameState {
  return {
    ...state,
    ships: [{ ...state.ships[0], ...ship }, state.ships[1]],
  };
}

function buildProjectile(options: {
  readonly ownerId: number;
  readonly x: Fixed;
  readonly y: Fixed;
  readonly damage?: number;
  readonly kind?: ProjectileState['kind'];
  readonly vx?: Fixed;
  readonly vy?: Fixed;
  readonly trackPct?: Fixed;
  readonly ttl?: number;
}): ProjectileState {
  return {
    id: 99,
    ownerId: options.ownerId,
    kind: options.kind ?? 'generic',
    x: options.x,
    y: options.y,
    vx: options.vx ?? fixed(0),
    vy: options.vy ?? fixed(0),
    angle: angle(0),
    ttl: options.ttl ?? 10,
    damage: options.damage ?? 99,
    radius: fixedFromInt(10),
    rotation: fixed(0),
    trackPct: options.trackPct ?? fixed(0),
    variety: 0,
    active: true,
  };
}
