import { createInitialState } from '../sim/state';
import type { GameState } from '../sim/types';
import {
  decodeGameplayPacket,
  encodeInputPacket,
  encodeSessionConfigPacket,
  encodeSessionReadyAckPacket,
  encodeSessionReadyPacket,
  encodeStateHashPacket,
  GameplayPacketType,
  type InputPacket,
  type SessionConfigPacket,
} from './protocol';
import { RollbackSession, type DesyncReport, type PlayerIndex } from './rollback';
import type { ConnectionRole } from './webrtc';

export interface NetworkMatchStatus {
  readonly role: ConnectionRole;
  readonly ready: boolean;
  readonly localPlayerIndex: PlayerIndex;
  readonly frame: number;
  readonly lastRemoteInputFrame: number | null;
  readonly lastLocalHashFrame: number | null;
  readonly lastRemoteHashFrame: number | null;
  readonly lastInputFrame: number | null;
  readonly remoteInputAge: number | null;
  readonly lastHashFrame: number | null;
  readonly rolledBack: boolean;
  readonly rollbackCount: number;
  readonly packetsSent: number;
  readonly packetsReceived: number;
  readonly protocolError: string | null;
  readonly sessionError: string | null;
  readonly desync: DesyncReport | null;
}

export interface NetworkMatchStepResult {
  readonly packets: readonly Uint8Array[];
  readonly state: GameState | null;
  readonly status: NetworkMatchStatus;
}

const DEFAULT_MATCH_SEED = 0x5eed_2026;
const DEFAULT_HASH_INTERVAL = 60;
const DEFAULT_ROLLBACK_LIMIT = 10;
const INPUT_RESEND_COUNT = 4;

export class NetworkMatchSession {
  private readonly hashInterval: number;
  private readonly rollbackLimit: number;
  private readonly localInputHistory: number[] = [];
  private readonly outgoingPackets: Uint8Array[] = [];
  private readonly receivedRemoteInputFrames = new Set<number>();
  private readonly sessionConfig: SessionConfigPacket | null = null;
  private rollbackSession: RollbackSession | null = null;
  private localPlayerIndex: PlayerIndex;
  private lastRemoteInputFrame: number | null = null;
  private lastLocalHashFrame: number | null = null;
  private lastRemoteHashFrame: number | null = null;
  private lastInputFrame: number | null = null;
  private rolledBack = false;
  private rollbackCount = 0;
  private packetsSent = 0;
  private packetsReceived = 0;
  private protocolError: string | null = null;
  private sessionError: string | null = null;
  private sessionReadySent = false;
  private sessionReadyReceived = false;
  private sessionReadyAckSent = false;
  private sessionReadyAckReceived = false;

  public constructor(
    private readonly role: ConnectionRole,
    options: {
      readonly seed?: number;
      readonly hashInterval?: number;
      readonly rollbackLimit?: number;
    } = {},
  ) {
    this.hashInterval = options.hashInterval ?? DEFAULT_HASH_INTERVAL;
    this.rollbackLimit = options.rollbackLimit ?? DEFAULT_ROLLBACK_LIMIT;
    this.localPlayerIndex = role === 'host' ? 0 : 1;

    if (role === 'host') {
      const config: SessionConfigPacket = {
        seed: options.seed ?? DEFAULT_MATCH_SEED,
        startFrame: 0,
        hostPlayerIndex: 0,
        joinerPlayerIndex: 1,
      };
      this.sessionConfig = config;
      this.start(config);
      this.outgoingPackets.push(encodeSessionConfigPacket(config));
    }
  }

  public get ready(): boolean {
    return this.role === 'host' ? this.sessionReadyReceived && this.sessionReadyAckSent : this.sessionReadyAckReceived;
  }

  public get currentState(): GameState | null {
    return this.rollbackSession?.currentState ?? null;
  }

  public get status(): NetworkMatchStatus {
    return {
      role: this.role,
      ready: this.ready,
      localPlayerIndex: this.localPlayerIndex,
      frame: this.currentState?.frame ?? 0,
      lastRemoteInputFrame: this.lastRemoteInputFrame,
      lastLocalHashFrame: this.lastLocalHashFrame,
      lastRemoteHashFrame: this.lastRemoteHashFrame,
      lastInputFrame: this.lastInputFrame,
      remoteInputAge: this.remoteInputAge,
      lastHashFrame: this.lastLocalHashFrame,
      rolledBack: this.rolledBack,
      rollbackCount: this.rollbackCount,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      protocolError: this.protocolError,
      sessionError: this.sessionError,
      desync: this.rollbackSession?.desyncReport ?? null,
    };
  }

  public takeOutgoingPackets(): Uint8Array[] {
    const packets = this.outgoingPackets.splice(0);
    this.packetsSent += packets.length;
    return packets;
  }

  public step(localInput: number): NetworkMatchStepResult {
    if (!this.ready) {
      if (this.role === 'host' && this.sessionConfig && !this.sessionReadyReceived) {
        this.outgoingPackets.push(encodeSessionConfigPacket(this.sessionConfig));
      }

      return { packets: this.takeOutgoingPackets(), state: null, status: this.status };
    }

    if (!this.rollbackSession) {
      return { packets: this.takeOutgoingPackets(), state: null, status: this.status };
    }

    const frame = this.rollbackSession.currentState.frame;
    const result = this.rollbackSession.step(localInput);
    this.rolledBack = result.rolledBack;
    if (result.rolledBack) {
      this.rollbackCount += 1;
    }

    this.localInputHistory.unshift(localInput);
    this.localInputHistory.length = Math.min(this.localInputHistory.length, INPUT_RESEND_COUNT);
    this.lastInputFrame = frame;
    this.outgoingPackets.push(
      encodeInputPacket({
        frame,
        input: localInput,
        previousInputs: this.localInputHistory.slice(1),
      }),
    );

    if (result.frame % this.hashInterval === 0) {
      this.lastLocalHashFrame = result.frame;
      this.outgoingPackets.push(encodeStateHashPacket({ frame: result.frame, hash: result.hash }));
    }

    return { packets: this.takeOutgoingPackets(), state: result.state, status: this.status };
  }

  public receiveGameplayMessage(bytes: Uint8Array): NetworkMatchStatus {
    let packet: ReturnType<typeof decodeGameplayPacket>;
    try {
      packet = decodeGameplayPacket(bytes);
      this.packetsReceived += 1;
      this.protocolError = null;
    } catch (error) {
      this.protocolError = readError(error);
      return this.status;
    }

    switch (packet.type) {
      case GameplayPacketType.SessionConfig:
        this.receiveSessionConfig(packet);
        break;
      case GameplayPacketType.SessionReady:
        this.receiveSessionReady();
        break;
      case GameplayPacketType.SessionReadyAck:
        this.receiveSessionReadyAck();
        break;
      case GameplayPacketType.Input:
        this.receiveInputWindow(packet);
        break;
      case GameplayPacketType.StateHash:
        if (this.ready && this.rollbackSession) {
          this.lastRemoteHashFrame = packet.frame;
          this.rollbackSession.receiveRemoteHash(packet.frame, packet.hash);
        } else {
          this.sessionError = 'Received state hash before the session was ready.';
        }
        break;
    }

    return this.status;
  }

  private get remoteInputAge(): number | null {
    if (!this.rollbackSession || this.lastRemoteInputFrame === null) {
      return null;
    }

    return Math.max(0, this.rollbackSession.currentState.frame - this.lastRemoteInputFrame);
  }

  private start(config: SessionConfigPacket): void {
    this.localPlayerIndex = this.role === 'host' ? config.hostPlayerIndex : config.joinerPlayerIndex;
    this.rollbackSession = new RollbackSession(createInitialState(config.seed), this.localPlayerIndex, this.rollbackLimit);
  }

  private receiveSessionConfig(packet: SessionConfigPacket): void {
    if (this.role !== 'joiner') {
      this.sessionError = 'Host received an unexpected session config packet.';
      return;
    }

    if (this.rollbackSession) {
      this.sessionError = 'Joiner received a duplicate session config packet.';
      if (!this.sessionReadyAckReceived) {
        this.outgoingPackets.push(encodeSessionReadyPacket());
        this.sessionReadySent = true;
      }
      return;
    }

    this.start(packet);
    this.sessionError = null;
    this.outgoingPackets.push(encodeSessionReadyPacket());
    this.sessionReadySent = true;
  }

  private receiveSessionReady(): void {
    if (this.role !== 'host') {
      this.sessionError = 'Joiner received an unexpected session ready packet.';
      return;
    }

    if (!this.rollbackSession) {
      this.sessionError = 'Host received session ready before local session start.';
      return;
    }

    this.sessionReadyReceived = true;
    this.sessionReadyAckSent = true;
    this.sessionError = null;
    this.outgoingPackets.push(encodeSessionReadyAckPacket());
  }

  private receiveSessionReadyAck(): void {
    if (this.role !== 'joiner') {
      this.sessionError = 'Host received an unexpected session ready ack packet.';
      return;
    }

    if (!this.rollbackSession || !this.sessionReadySent) {
      this.sessionError = 'Joiner received session ready ack before sending readiness.';
      return;
    }

    this.sessionReadyAckReceived = true;
    this.sessionError = null;
  }

  private receiveInputWindow(packet: InputPacket): void {
    if (!this.ready || !this.rollbackSession) {
      this.sessionError = 'Received input before the session was ready.';
      return;
    }

    let acceptedInput = false;
    for (let i = packet.previousInputs.length - 1; i >= 0; i -= 1) {
      const frame = packet.frame - i - 1;
      acceptedInput = this.receiveRemoteInput(frame, packet.previousInputs[i]) || acceptedInput;
    }

    acceptedInput = this.receiveRemoteInput(packet.frame, packet.input) || acceptedInput;
    this.sessionError = acceptedInput ? null : 'Ignored stale input packet.';
  }

  private receiveRemoteInput(frame: number, input: number): boolean {
    if (!this.rollbackSession || frame < 0 || this.receivedRemoteInputFrames.has(frame)) {
      return false;
    }

    this.receivedRemoteInputFrames.add(frame);
    this.rollbackSession.receiveRemoteInput({ frame, input });
    this.lastRemoteInputFrame = Math.max(this.lastRemoteInputFrame ?? frame, frame);
    return true;
  }
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
