import { describe, expect, it } from 'vitest';

import { hashState } from './hash';
import { runReplay } from './replay';
import { createInitialState } from './state';
import { InputBits, type FrameInputs } from './types';

describe('deterministic replay', () => {
  it('produces identical hashes for the same start state and inputs', () => {
    const frames: FrameInputs[] = Array.from({ length: 120 }, (_, frame) => [
      frame % 3 === 0 ? InputBits.Thrust : InputBits.TurnRight,
      frame % 10 === 0 ? InputBits.FirePrimary : 0,
    ]);

    const first = runReplay(createInitialState(1234), frames, hashState);
    const second = runReplay(createInitialState(1234), frames, hashState);

    expect(first.frameHashes).toEqual(second.frameHashes);
    expect(hashState(first.finalState)).toBe(hashState(second.finalState));
  });
});
