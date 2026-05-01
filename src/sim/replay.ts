import { stepGame } from './step';
import type { FrameInputs, GameState } from './types';

export interface ReplayResult {
  readonly finalState: GameState;
  readonly frameHashes: readonly number[];
}

export function runReplay(
  initialState: GameState,
  frames: readonly FrameInputs[],
  hashState: (state: GameState) => number,
): ReplayResult {
  let state = initialState;
  const frameHashes: number[] = [];

  for (const inputs of frames) {
    state = stepGame(state, inputs);
    frameHashes.push(hashState(state));
  }

  return {
    finalState: state,
    frameHashes,
  };
}
