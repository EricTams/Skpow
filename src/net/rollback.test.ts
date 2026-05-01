import { describe, expect, it } from 'vitest';

import { hashState } from '../sim/hash';
import { runReplay } from '../sim/replay';
import { createInitialState } from '../sim/state';
import { InputBits, type FrameInputs } from '../sim/types';
import { RollbackSession } from './rollback';

describe('rollback session', () => {
  it('rewinds and replays when a predicted remote input was wrong', () => {
    const initialState = createInitialState(99);
    const session = new RollbackSession(initialState);

    session.step(0);
    session.step(InputBits.Thrust);
    session.receiveRemoteInput({ frame: 0, input: InputBits.TurnLeft });

    const canonicalInputs: FrameInputs[] = [
      [0, InputBits.TurnLeft],
      [InputBits.Thrust, 0],
    ];
    const canonical = runReplay(initialState, canonicalInputs, hashState);

    expect(hashState(session.currentState)).toBe(hashState(canonical.finalState));
  });

  it('reports rollback on the next step after a prediction was corrected', () => {
    const initialState = createInitialState(99);
    const session = new RollbackSession(initialState);

    session.step(0);
    session.receiveRemoteInput({ frame: 0, input: InputBits.TurnLeft });

    expect(session.step(0).rolledBack).toBe(true);
  });

  it('routes local input as player two for joiners', () => {
    const initialState = createInitialState(99);
    const session = new RollbackSession(initialState, 1);

    session.receiveRemoteInput({ frame: 0, input: InputBits.TurnLeft });
    session.step(InputBits.Thrust);

    const canonicalInputs: FrameInputs[] = [[InputBits.TurnLeft, InputBits.Thrust]];
    const canonical = runReplay(initialState, canonicalInputs, hashState);

    expect(hashState(session.currentState)).toBe(hashState(canonical.finalState));
  });

  it('records desync reports when remote hashes disagree', () => {
    const initialState = createInitialState(99);
    const session = new RollbackSession(initialState);
    const result = session.step(InputBits.Thrust);
    const remoteHash = result.hash ^ 0xffff;

    expect(session.receiveRemoteHash(result.frame, remoteHash)).toEqual({
      frame: result.frame,
      localHash: result.hash,
      remoteHash,
    });
  });
});
