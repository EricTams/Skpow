import { describe, expect, it } from 'vitest';

import { fixed, fixedFromInt } from './fixed';
import { getAiInput } from './ai';
import { createInitialState } from './state';
import { angle } from './trig';
import { InputBits, type ActorState, type GameState, type ShipState } from './types';

describe('reference-style AI input', () => {
  it('always thrusts while the AI ship is alive', () => {
    const input = getAiInput(createInitialState(123), 1);

    expect(input & InputBits.Thrust).toBe(InputBits.Thrust);
  });

  it('turns toward the led opponent position', () => {
    const state = withShips(createInitialState(123), [
      { id: 0, x: fixedFromInt(-500), y: fixedFromInt(700), angle: angle(128) },
      { id: 1, x: fixedFromInt(-900), y: fixedFromInt(700), angle: angle(0) },
    ]);
    const input = getAiInput(state, 1);

    expect(input & InputBits.TurnRight).toBe(InputBits.TurnRight);
    expect(input & InputBits.TurnLeft).toBe(0);
  });

  it('fires when the opponent is close and aligned', () => {
    const state = withShips(createInitialState(123), [
      { id: 0, x: fixedFromInt(400), y: fixedFromInt(0), angle: angle(128) },
      { id: 1, x: fixedFromInt(0), y: fixedFromInt(0), angle: angle(0), custom: { cannonAngle: angle(0) } },
    ]);

    const input = getAiInput(state, 1);

    expect(input & InputBits.FirePrimary).toBe(InputBits.FirePrimary);
  });

  it('does not fire when the opponent is out of range', () => {
    const state = withShips(createInitialState(123), [
      { id: 0, x: fixedFromInt(700), y: fixedFromInt(0), angle: angle(128) },
      { id: 1, x: fixedFromInt(0), y: fixedFromInt(0), angle: angle(0) },
    ]);

    const input = getAiInput(state, 1);

    expect(input & InputBits.FirePrimary).toBe(0);
  });

  it('fires Zizlik when the led opponent is in its vertical shot corridor', () => {
    const state = withShips(createInitialState(123, ['frog', 'zizlik']), [
      { id: 0, x: fixedFromInt(30), y: fixedFromInt(400), angle: angle(128) },
      { id: 1, x: fixedFromInt(0), y: fixedFromInt(0), angle: angle(128) },
    ]);

    const input = getAiInput(state, 1);

    expect(input & InputBits.FirePrimary).toBe(InputBits.FirePrimary);
  });

  it('does not fire Zizlik outside its vertical shot corridor', () => {
    const state = withShips(createInitialState(123, ['frog', 'zizlik']), [
      { id: 0, x: fixedFromInt(80), y: fixedFromInt(400), angle: angle(128) },
      { id: 1, x: fixedFromInt(0), y: fixedFromInt(0), angle: angle(64) },
    ]);

    const input = getAiInput(state, 1);

    expect(input & InputBits.FirePrimary).toBe(0);
  });

  it('fires Cannonade secondary at medium range without needing alignment', () => {
    const state = withShips(createInitialState(123, ['frog', 'cannonade']), [
      { id: 0, x: fixedFromInt(1000), y: fixedFromInt(0), angle: angle(0) },
      { id: 1, x: fixedFromInt(0), y: fixedFromInt(0), angle: angle(64) },
    ]);

    const input = getAiInput(state, 1);

    expect(input & InputBits.FireSecondary).toBe(InputBits.FireSecondary);
  });

  it('holds Cannonade secondary when too far away', () => {
    const state = withShips(createInitialState(123, ['frog', 'cannonade']), [
      { id: 0, x: fixedFromInt(1300), y: fixedFromInt(0), angle: angle(0) },
      { id: 1, x: fixedFromInt(0), y: fixedFromInt(0), angle: angle(128) },
    ]);

    const input = getAiInput(state, 1);

    expect(input & InputBits.FireSecondary).toBe(0);
  });

  it('steers around pursuit paths that cross the planet', () => {
    const state = withShips(createInitialState(123), [
      { id: 0, x: fixedFromInt(500), y: fixedFromInt(0), angle: angle(128) },
      { id: 1, x: fixedFromInt(-500), y: fixedFromInt(0), angle: angle(0) },
    ]);

    const input = getAiInput(state, 1);

    expect(input & InputBits.Thrust).toBe(InputBits.Thrust);
    expect((input & (InputBits.TurnLeft | InputBits.TurnRight)) !== 0).toBe(true);
  });

  it('steers outward when drifting into the planet well', () => {
    const state = withShips(createInitialState(123), [
      { id: 0, x: fixedFromInt(700), y: fixedFromInt(0), angle: angle(128) },
      { id: 1, x: fixedFromInt(260), y: fixedFromInt(0), vx: fixed(-1), angle: angle(128) },
    ]);

    const input = getAiInput(state, 1);

    expect(input & InputBits.TurnRight).toBe(InputBits.TurnRight);
  });

  it('returns no input for dead or missing AI ships', () => {
    const deadState = withShips(createInitialState(123), [{ id: 1, alive: false }]);

    expect(getAiInput(deadState, 1)).toBe(0);
    expect(getAiInput(createInitialState(123), 99)).toBe(0);
  });

  it('fires PScout secondary when beacon damage would kill the opponent', () => {
    const state = withActors(
      withShips(createInitialState(123, ['frog', 'pscout']), [
        { id: 0, crew: 4 },
        { id: 1, battery: 4 },
      ]),
      pScoutBeacons(2, 0),
    );

    const input = getAiInput(state, 1);

    expect(input & InputBits.FireSecondary).toBe(InputBits.FireSecondary);
  });

  it('fires PScout secondary when beacon damage is greater than its crew', () => {
    const state = withActors(
      withShips(createInitialState(123, ['frog', 'pscout']), [
        { id: 0, crew: 8 },
        { id: 1, crew: 3, battery: 4 },
      ]),
      pScoutBeacons(2, 0),
    );

    const input = getAiInput(state, 1);

    expect(input & InputBits.FireSecondary).toBe(InputBits.FireSecondary);
  });

  it('holds PScout secondary and keeps firing darts when beam damage is not decisive', () => {
    const state = withActors(
      withShips(createInitialState(123, ['frog', 'pscout']), [
        { id: 0, x: fixedFromInt(400), y: fixedFromInt(0), angle: angle(128), crew: 8 },
        { id: 1, x: fixedFromInt(0), y: fixedFromInt(0), angle: angle(0), crew: 8, battery: 4, primaryCooldown: 0 },
      ]),
      pScoutBeacons(1, 0),
    );

    const input = getAiInput(state, 1);

    expect(input & InputBits.FireSecondary).toBe(0);
    expect(input & InputBits.FirePrimary).toBe(InputBits.FirePrimary);
  });
});

function withShips(state: GameState, ships: readonly Partial<ShipState>[]): GameState {
  return {
    ...state,
    ships: state.ships.map((ship) => ({
      ...ship,
      vx: fixed(0),
      vy: fixed(0),
      ...ships.find((override) => override.id === ship.id),
    })),
  };
}

function withActors(state: GameState, actors: readonly ActorState[]): GameState {
  return {
    ...state,
    actors: [...state.actors, ...actors],
  };
}

function pScoutBeacons(count: number, attachedToShipId: number): readonly ActorState[] {
  return Array.from({ length: count }, (_, index) => ({
    id: 100 + index,
    kind: 'pscoutBeacon',
    ownerId: 1,
    attachedToShipId,
    slot: index,
    x: fixedFromInt(0),
    y: fixedFromInt(0),
    angle: angle(0),
    radius: fixedFromInt(10),
    ttl: null,
    active: true,
  }));
}
