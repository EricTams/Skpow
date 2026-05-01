import { hashState } from '../sim/hash';
import { stepGame } from '../sim/step';
import type { FrameInputs, GameState } from '../sim/types';

export type PlayerIndex = 0 | 1;

export interface RemoteInput {
  readonly frame: number;
  readonly input: number;
}

export interface DesyncReport {
  readonly frame: number;
  readonly localHash: number;
  readonly remoteHash: number;
}

export interface RollbackStepResult {
  readonly state: GameState;
  readonly frame: number;
  readonly hash: number;
  readonly rolledBack: boolean;
}

export class RollbackSession {
  private state: GameState;
  private readonly snapshots = new Map<number, GameState>();
  private readonly localInputs = new Map<number, number>();
  private readonly remoteInputs = new Map<number, number>();
  private readonly predictedRemoteInputs = new Map<number, number>();
  private readonly localHashes = new Map<number, number>();
  private lastRemoteInput = 0;
  private desync: DesyncReport | null = null;
  private rolledBackSinceLastStep = false;

  public constructor(
    initialState: GameState,
    private readonly localPlayerIndex: PlayerIndex = 0,
    private readonly rollbackLimit = 10,
  ) {
    this.state = initialState;
    this.snapshots.set(initialState.frame, initialState);
  }

  public get currentState(): GameState {
    return this.state;
  }

  public get desyncReport(): DesyncReport | null {
    return this.desync;
  }

  public receiveRemoteInput(input: RemoteInput): boolean {
    this.remoteInputs.set(input.frame, input.input);
    this.lastRemoteInput = input.input;

    const predicted = this.predictedRemoteInputs.get(input.frame);
    if (predicted !== undefined && predicted !== input.input) {
      const rolledBack = this.rollbackFrom(input.frame);
      this.rolledBackSinceLastStep ||= rolledBack;
      return rolledBack;
    }

    return false;
  }

  public receiveRemoteHash(frame: number, remoteHash: number): DesyncReport | null {
    const localHash = this.localHashes.get(frame);
    if (localHash !== undefined && localHash !== remoteHash) {
      this.desync = { frame, localHash, remoteHash };
    }

    return this.desync;
  }

  public step(localInput: number): RollbackStepResult {
    const frame = this.state.frame;
    const rolledBack = this.rolledBackSinceLastStep;
    this.rolledBackSinceLastStep = false;
    this.localInputs.set(frame, localInput);
    this.snapshots.set(frame, this.state);

    const remoteInput = this.remoteInputs.get(frame);
    const predictedRemote = remoteInput ?? this.lastRemoteInput;
    if (remoteInput === undefined) {
      this.predictedRemoteInputs.set(frame, predictedRemote);
    }

    this.state = stepGame(this.state, this.buildFrameInputs(localInput, predictedRemote));
    const hash = hashState(this.state);
    this.localHashes.set(this.state.frame, hash);
    this.pruneHistory(this.state.frame);

    return {
      state: this.state,
      frame: this.state.frame,
      hash,
      rolledBack,
    };
  }

  private rollbackFrom(frame: number): boolean {
    if (this.state.frame - frame > this.rollbackLimit) {
      return false;
    }

    const snapshot = this.snapshots.get(frame);
    if (!snapshot) {
      return false;
    }

    const targetFrame = this.state.frame;
    this.state = snapshot;

    while (this.state.frame < targetFrame) {
      const currentFrame = this.state.frame;
      const local = this.localInputs.get(currentFrame) ?? 0;
      const remote = this.remoteInputs.get(currentFrame) ?? this.predictedRemoteInputs.get(currentFrame) ?? this.lastRemoteInput;
      this.state = stepGame(this.state, this.buildFrameInputs(local, remote));
      this.localHashes.set(this.state.frame, hashState(this.state));
    }

    return true;
  }

  private buildFrameInputs(localInput: number, remoteInput: number): FrameInputs {
    return this.localPlayerIndex === 0 ? [localInput, remoteInput] : [remoteInput, localInput];
  }

  private pruneHistory(currentFrame: number): void {
    const oldestFrame = currentFrame - this.rollbackLimit - 2;

    for (const collection of [
      this.snapshots,
      this.localInputs,
      this.remoteInputs,
      this.predictedRemoteInputs,
      this.localHashes,
    ]) {
      for (const frame of collection.keys()) {
        if (frame < oldestFrame) {
          collection.delete(frame);
        }
      }
    }
  }
}
