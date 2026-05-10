import { describe, expect, it } from 'vitest';

import { fixed, fixedFromInt } from '../sim/fixed';
import { createInitialState } from '../sim/state';
import { stepGame } from '../sim/step';
import { angle } from '../sim/trig';
import { InputBits, type ProjectileState } from '../sim/types';
import { fastForwardProjectile, OwnerAuthoritySession } from './rollback';

describe('owner authority session', () => {
  it('steps local input immediately for player one', () => {
    const initialState = createInitialState(99);
    const session = new OwnerAuthoritySession(initialState, 0);

    session.step(InputBits.FirePrimary);

    expect(session.currentState.frame).toBe(1);
    expect(session.currentState.ships[0].custom.frogCharge).toBe(1);
  });

  it('routes local input as player two for joiners', () => {
    const initialState = createInitialState(99);
    const session = new OwnerAuthoritySession(initialState, 1);

    session.step(InputBits.FirePrimary);

    expect(session.currentState.frame).toBe(1);
    expect(session.currentState.projectiles.some((projectile) => projectile.ownerId === 1)).toBe(true);
    expect(session.currentState.ships[0].custom.frogCharge).toBe(0);
  });

  it('fast-forwards remote owner state when applied late', () => {
    const initialState = createInitialState(99);
    const session = new OwnerAuthoritySession(initialState, 1);
    session.step(0);
    session.step(0);

    session.applyOwnerShipState({ ...initialState.ships[0], vx: fixedFromInt(5), vy: fixedFromInt(0) }, 0);

    expect(session.currentState.ships[0].x).toBe(fixedFromInt(435));
  });

  it('does not predict remote Frog charge release projectiles from owner state', () => {
    const initialState = createInitialState(99, ['frog', 'cannonade']);
    const session = new OwnerAuthoritySession(initialState, 1);
    session.applyOwnerShipState(
      {
        ...initialState.ships[0],
        custom: { ...initialState.ships[0].custom, frogCharge: 3, frogChargeTime: 12 },
      },
      0,
    );

    session.step(0);

    expect(session.currentState.projectiles.filter((projectile) => projectile.ownerId === 0)).toHaveLength(0);
  });

  it('keeps explicit remote projectile spawns after later simulation steps', () => {
    const initialState = createInitialState(99, ['frog', 'cannonade']);
    const session = new OwnerAuthoritySession(initialState, 1);
    const projectile: ProjectileState = buildProjectile({ id: 1, ownerId: 0 });

    session.applyProjectileSpawn(projectile, 0);
    session.step(0);

    expect(session.currentState.projectiles.some((candidate) => candidate.id === projectile.id && candidate.ownerId === 0)).toBe(true);
  });

  it('applies tracking during projectile catch-up', () => {
    const initialState = createInitialState(99, ['cannonade', 'frog']);
    const projectile = buildProjectile({
      ownerId: 0,
      kind: 'cannonadeBall',
      x: fixed(0),
      y: fixed(0),
      vx: fixedFromInt(10),
      vy: fixed(0),
      ttl: 50,
      trackPct: fixed(0.1),
    });

    const caughtUp = fastForwardProjectile(projectile, 3, initialState);

    expect(caughtUp?.ttl).toBe(47);
    expect(caughtUp?.vy).not.toBe(projectile.vy);
    expect(caughtUp?.y).not.toBe(projectile.y);
  });

  it('uses Nurtip asteroid orbit motion during projectile catch-up', () => {
    const initialState = createInitialState(99, ['nurtip', 'frog']);
    const frozenOwnerState = {
      ...initialState,
      ships: [
        { ...initialState.ships[0], freezeFrames: 999 },
        initialState.ships[1],
      ],
    };
    const fired = stepGame(frozenOwnerState, [InputBits.FireSecondary, 0]);
    const spawned = fired.projectiles.find((projectile) => projectile.kind === 'nurtipAsteroid');
    expect(spawned).toBeDefined();
    if (!spawned) {
      return;
    }

    let expectedState = fired;
    for (let frame = 0; frame < 3; frame += 1) {
      expectedState = stepGame(expectedState, [0, 0]);
    }

    const expected = expectedState.projectiles.find((projectile) => projectile.id === spawned.id);
    const caughtUp = fastForwardProjectile(spawned, 3, expectedState);

    expect(caughtUp).toMatchObject({
      x: expected?.x,
      y: expected?.y,
      vx: expected?.vx,
      vy: expected?.vy,
      ttl: expected?.ttl,
      angle: expected?.angle,
    });
  });

  it('applies remote Frog charge weapon events for visual prediction', () => {
    const initialState = createInitialState(99, ['frog', 'cannonade']);
    const session = new OwnerAuthoritySession(initialState, 1);

    session.applyOwnerWeaponEvent({
      roundId: 0,
      eventId: '0:1:primary:frogChargeStart',
      frame: 1,
      ownerId: 0,
      weapon: 'primary',
      effectKind: 'frogChargeStart',
      x: initialState.ships[0].x,
      y: initialState.ships[0].y,
      vx: initialState.ships[0].vx,
      vy: initialState.ships[0].vy,
      angle: angle(0),
      strength: 2,
      durationFrames: 6,
    });

    expect(session.currentState.ships[0].custom.frogCharge).toBe(2);
  });

  it('applies remote Bolter charge and blossom weapon events for visual prediction', () => {
    const initialState = createInitialState(99, ['bolter', 'cannonade']);
    const session = new OwnerAuthoritySession(initialState, 1);

    session.applyOwnerWeaponEvent({
      roundId: 0,
      eventId: '0:1:primary:bolterChargeStart',
      frame: 1,
      ownerId: 0,
      weapon: 'primary',
      effectKind: 'bolterChargeStart',
      x: initialState.ships[0].x,
      y: initialState.ships[0].y,
      vx: initialState.ships[0].vx,
      vy: initialState.ships[0].vy,
      angle: angle(0),
      strength: 3,
      durationFrames: 12,
    });
    session.applyOwnerWeaponEvent({
      roundId: 0,
      eventId: '0:2:secondary:bolterBlossom',
      frame: 2,
      ownerId: 0,
      weapon: 'secondary',
      effectKind: 'bolterBlossom',
      x: initialState.ships[0].x,
      y: initialState.ships[0].y,
      vx: initialState.ships[0].vx,
      vy: initialState.ships[0].vy,
      angle: angle(0),
      durationFrames: 200,
    });

    expect(session.currentState.ships[0].custom.bolterCharge).toBe(0);
    expect(session.currentState.ships[0].custom.bolterBlossomActive).toBe(true);
  });
});

function buildProjectile(overrides: Partial<ProjectileState> = {}): ProjectileState {
  return {
    id: 1,
    ownerId: 0,
    kind: 'frogBubble',
    x: fixedFromInt(1000),
    y: fixedFromInt(1000),
    vx: fixed(0),
    vy: fixed(0),
    angle: angle(0),
    ttl: 50,
    damage: 1,
    radius: fixedFromInt(20),
    rotation: fixed(0),
    trackPct: fixed(0),
    variety: 0,
    active: true,
    ...overrides,
  };
}
