import { createInitialState } from '../sim/state';
import type { ShipId } from '../sim/shipSpecs';
import { InputBits, type GameState } from '../sim/types';
import type { Fixed } from '../sim/fixed';
import type { Angle } from '../sim/trig';
import { isKronBeamHitting } from '../sim/step';
import {
  decodeGameplayPacket,
  encodeDefenderHitPacket,
  encodeOwnerStatePacket,
  encodeOwnerWeaponEventPacket,
  encodeProjectileSpawnPacket,
  encodeRecoveryAckPacket,
  encodeRecoveryRequestPacket,
  encodeRecoverySnapshotPacket,
  encodeSessionConfigPacket,
  encodeSessionReadyAckPacket,
  encodeSessionReadyPacket,
  GameplayPacketType,
  type DefenderHitPacket,
  type OwnerStatePacket,
  type OwnerWeaponEffectKind,
  type OwnerWeaponEventPacket,
  type OwnerWeaponKind,
  type ProjectileSpawnPacket,
  type RecoveryAckPacket,
  type RecoveryRequestPacket,
  type RecoverySnapshotPacket,
  type SessionConfigPacket,
} from './protocol';
import { OwnerAuthoritySession, type PlayerIndex } from './rollback';
import type { ConnectionRole } from './webrtc';

export interface NetworkMatchStatus {
  readonly role: ConnectionRole;
  readonly ready: boolean;
  readonly localPlayerIndex: PlayerIndex;
  readonly aiDemo: boolean;
  readonly frame: number;
  readonly lastOwnerStateFrame: number | null;
  readonly lastProjectileSpawnFrame: number | null;
  readonly lastWeaponEventFrame: number | null;
  readonly lastDefenderHitFrame: number | null;
  readonly paused: boolean;
  readonly recoveryId: number | null;
  readonly recoveryReason: string | null;
  readonly recoveryWaitingForPeer: boolean;
  readonly lastRemoteOwnerFrame: number | null;
  readonly remoteOwnerAgeFrames: number | null;
  readonly packetsSent: number;
  readonly packetsReceived: number;
  readonly protocolError: string | null;
  readonly sessionError: string | null;
}

export interface NetworkMatchStepResult {
  readonly packets: readonly Uint8Array[];
  readonly state: GameState | null;
  readonly status: NetworkMatchStatus;
}

const DEFAULT_MATCH_SEED = 0x5eed_2026;
const PROJECTILE_SPAWN_RESEND_COUNT = 8;
const DEFENDER_HIT_RESEND_COUNT = 8;
const WEAPON_EVENT_RESEND_COUNT = 8;
const REMOTE_OWNER_TIMEOUT_FRAMES = 30;

type RecoveryPhase = 'running' | 'paused-local' | 'paused-remote' | 'reconciling';

interface RecoveryState {
  readonly id: number;
  phase: RecoveryPhase;
  reason: string;
  localSnapshot: GameState | null;
  remoteSnapshot: GameState | null;
  ackReceived: boolean;
  requestSent: boolean;
  snapshotSent: boolean;
  ackSent: boolean;
}

export class NetworkMatchSession {
  private readonly recentLocalProjectileSpawns: ProjectileSpawnPacket[] = [];
  private readonly recentLocalDefenderHits: DefenderHitPacket[] = [];
  private readonly recentLocalWeaponEvents: OwnerWeaponEventPacket[] = [];
  private readonly outgoingPackets: Uint8Array[] = [];
  private readonly receivedProjectileSpawnIds = new Set<number>();
  private readonly processedDefenderHitIds = new Set<string>();
  private readonly processedWeaponEventIds = new Set<string>();
  private readonly sessionConfig: SessionConfigPacket | null = null;
  private activeSessionKey: string | null = null;
  private activeAiDemo = false;
  private activeRoundId = 0;
  private readyImmediately = false;
  private ownerSession: OwnerAuthoritySession | null = null;
  private localPlayerIndex: PlayerIndex;
  private lastOwnerStateFrame: number | null = null;
  private lastProjectileSpawnFrame: number | null = null;
  private lastWeaponEventFrame: number | null = null;
  private lastDefenderHitFrame: number | null = null;
  private recovery: RecoveryState | null = null;
  private nextRecoveryId = 1;
  private lastCompletedRecoveryId = 0;
  private packetsSent = 0;
  private packetsReceived = 0;
  private protocolError: string | null = null;
  private sessionError: string | null = null;
  private sessionReadySent = false;
  private sessionReadyReceived = false;
  private sessionReadyAckSent = false;
  private sessionReadyAckReceived = false;
  // Latest thrust intent reported by the remote owner. Used to spawn matching
  // thrust dust visuals locally, since the remote ship's input is otherwise 0
  // on this machine.
  private remoteThrusting = false;

  public constructor(
    private readonly role: ConnectionRole,
    options: {
      readonly roundId?: number;
      readonly seed?: number;
      readonly loadout?: readonly [ShipId, ShipId];
      readonly aiDemo?: boolean;
      readonly readyImmediately?: boolean;
    } = {},
  ) {
    this.localPlayerIndex = role === 'host' ? 0 : 1;
    this.readyImmediately = options.readyImmediately ?? false;

    if (role === 'host') {
      const config: SessionConfigPacket = {
        roundId: options.roundId ?? 0,
        seed: options.seed ?? DEFAULT_MATCH_SEED,
        loadout: options.loadout ?? ['frog', 'cannonade'],
        aiDemo: options.aiDemo ?? false,
        startFrame: 0,
        hostPlayerIndex: 0,
        joinerPlayerIndex: 1,
      };
      this.sessionConfig = config;
      this.start(config);
      if (this.readyImmediately) {
        this.sessionReadyReceived = true;
        this.sessionReadyAckSent = true;
      }
      this.outgoingPackets.push(encodeSessionConfigPacket(config));
    } else if (this.readyImmediately) {
      this.sessionReadyAckReceived = true;
    }
  }

  public get ready(): boolean {
    return this.role === 'host' ? this.sessionReadyReceived && this.sessionReadyAckSent : this.sessionReadyAckReceived;
  }

  public get currentState(): GameState | null {
    return this.ownerSession?.currentState ?? null;
  }

  public get status(): NetworkMatchStatus {
    return {
      role: this.role,
      ready: this.ready,
      localPlayerIndex: this.localPlayerIndex,
      aiDemo: this.activeAiDemo,
      frame: this.currentState?.frame ?? 0,
      lastOwnerStateFrame: this.lastOwnerStateFrame,
      lastProjectileSpawnFrame: this.lastProjectileSpawnFrame,
      lastWeaponEventFrame: this.lastWeaponEventFrame,
      lastDefenderHitFrame: this.lastDefenderHitFrame,
      paused: this.recovery !== null,
      recoveryId: this.recovery?.id ?? null,
      recoveryReason: this.recovery?.reason ?? null,
      recoveryWaitingForPeer: this.recovery?.phase === 'reconciling' && this.recovery.ackSent && !this.recovery.ackReceived,
      lastRemoteOwnerFrame: this.lastOwnerStateFrame,
      remoteOwnerAgeFrames: this.remoteOwnerAgeFrames,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      protocolError: this.protocolError,
      sessionError: this.sessionError,
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

    if (!this.ownerSession) {
      return { packets: this.takeOutgoingPackets(), state: null, status: this.status };
    }

    if (this.shouldStartRecovery()) {
      this.startRecovery('remote owner updates stale');
    }

    if (this.recovery) {
      this.queueRecoveryPackets();
      return { packets: this.takeOutgoingPackets(), state: this.ownerSession.currentState, status: this.status };
    }

    const previousState = this.ownerSession.currentState;
    const remoteInput = this.remoteThrusting ? InputBits.Thrust : 0;
    const result = this.ownerSession.step(localInput, remoteInput);
    this.queueOwnerState(result.state, localInput);
    this.queueProjectileSpawns(previousState, result.state);
    this.queueWeaponEvents(previousState, result.state, localInput);
    this.queueDefenderHits(previousState, result.state);
    this.outgoingPackets.push(
      ...this.recentLocalProjectileSpawns.map((packet) => encodeProjectileSpawnPacket(packet)),
      ...this.recentLocalWeaponEvents.map((packet) => encodeOwnerWeaponEventPacket(packet)),
      ...this.recentLocalDefenderHits.map((packet) => encodeDefenderHitPacket(packet)),
    );

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
        this.sessionError = 'Received obsolete input packet.';
        break;
      case GameplayPacketType.StateHash:
        this.sessionError = 'Received obsolete state hash packet.';
        break;
      case GameplayPacketType.StateCheckpoint:
        this.sessionError = 'Received obsolete state checkpoint packet.';
        break;
      case GameplayPacketType.OwnerState:
        this.receiveOwnerState(packet);
        break;
      case GameplayPacketType.ProjectileSpawn:
        this.receiveProjectileSpawn(packet);
        break;
      case GameplayPacketType.DefenderHit:
        this.receiveDefenderHit(packet);
        break;
      case GameplayPacketType.OwnerWeaponEvent:
        this.receiveOwnerWeaponEvent(packet);
        break;
      case GameplayPacketType.RecoveryRequest:
        this.receiveRecoveryRequest(packet);
        break;
      case GameplayPacketType.RecoverySnapshot:
        this.receiveRecoverySnapshot(packet);
        break;
      case GameplayPacketType.RecoveryAck:
        this.receiveRecoveryAck(packet);
        break;
    }

    return this.status;
  }

  private start(config: SessionConfigPacket): void {
    this.localPlayerIndex = this.role === 'host' ? config.hostPlayerIndex : config.joinerPlayerIndex;
    this.activeAiDemo = config.aiDemo;
    this.activeRoundId = config.roundId;
    this.ownerSession = new OwnerAuthoritySession(createInitialState(config.seed, config.loadout), this.localPlayerIndex);
    this.activeSessionKey = getSessionConfigKey(config);
    this.lastOwnerStateFrame = null;
    this.lastProjectileSpawnFrame = null;
    this.lastWeaponEventFrame = null;
    this.lastDefenderHitFrame = null;
    this.recovery = null;
    this.lastCompletedRecoveryId = 0;
    this.remoteThrusting = false;
    this.resetOwnerFactWindows();
  }

  private get remoteOwnerAgeFrames(): number | null {
    if (!this.ownerSession || this.lastOwnerStateFrame === null) {
      return null;
    }

    return Math.max(0, this.ownerSession.currentState.frame - this.lastOwnerStateFrame);
  }

  private receiveSessionConfig(packet: SessionConfigPacket): void {
    if (this.role !== 'joiner') {
      this.sessionError = 'Host received an unexpected session config packet.';
      return;
    }

    const incomingKey = getSessionConfigKey(packet);
    if (this.ownerSession && this.activeSessionKey === incomingKey) {
      this.sessionError = null;
      if (!this.sessionReadyAckReceived && !this.readyImmediately) {
        this.outgoingPackets.push(encodeSessionReadyPacket());
        this.sessionReadySent = true;
      }
      return;
    }

    this.start(packet);
    this.sessionReadyAckReceived = this.readyImmediately;
    this.sessionError = null;
    if (!this.readyImmediately) {
      this.outgoingPackets.push(encodeSessionReadyPacket());
      this.sessionReadySent = true;
    }
  }

  private receiveSessionReady(): void {
    if (this.role !== 'host') {
      this.sessionError = 'Joiner received an unexpected session ready packet.';
      return;
    }

    if (!this.ownerSession) {
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

    if (!this.ownerSession || !this.sessionReadySent) {
      this.sessionError = 'Joiner received session ready ack before sending readiness.';
      return;
    }

    this.sessionReadyAckReceived = true;
    this.sessionError = null;
  }

  private receiveOwnerState(packet: OwnerStatePacket): void {
    if (!this.ready || !this.ownerSession) {
      this.sessionError = 'Received owner state before the session was ready.';
      return;
    }

    if (packet.roundId !== this.activeRoundId) {
      this.sessionError = null;
      return;
    }

    if (packet.playerId === this.localPlayerIndex) {
      this.sessionError = 'Ignored owner state for the local player.';
      return;
    }

    if (this.recovery) {
      this.sessionError = null;
      return;
    }

    if (this.lastOwnerStateFrame !== null && packet.frame < this.lastOwnerStateFrame) {
      this.sessionError = null;
      return;
    }

    if (packet.ship.shipId !== this.ownerSession.currentState.ships[packet.playerId]?.shipId) {
      this.sessionError = null;
      return;
    }

    const accepted = this.ownerSession.applyOwnerShipState(packet.ship, packet.frame);
    if (accepted) {
      this.remoteThrusting = packet.thrusting === true;
    }
    this.lastOwnerStateFrame = accepted ? Math.max(this.lastOwnerStateFrame ?? packet.frame, packet.frame) : this.lastOwnerStateFrame;
    this.sessionError = accepted ? null : 'Ignored invalid owner state packet.';
  }

  private receiveProjectileSpawn(packet: ProjectileSpawnPacket): void {
    if (!this.ready || !this.ownerSession) {
      this.sessionError = 'Received projectile spawn before the session was ready.';
      return;
    }

    if (packet.roundId !== this.activeRoundId) {
      this.sessionError = null;
      return;
    }

    if (packet.projectile.ownerId === this.localPlayerIndex) {
      this.sessionError = 'Ignored projectile spawn for the local player.';
      return;
    }

    if (this.recovery) {
      this.sessionError = null;
      return;
    }

    if (this.receivedProjectileSpawnIds.has(packet.projectile.id)) {
      this.sessionError = null;
      return;
    }

    this.receivedProjectileSpawnIds.add(packet.projectile.id);
    const accepted = this.ownerSession.applyProjectileSpawn(packet.projectile, packet.frame);
    this.lastProjectileSpawnFrame = accepted ? Math.max(this.lastProjectileSpawnFrame ?? packet.frame, packet.frame) : this.lastProjectileSpawnFrame;
    this.sessionError = accepted ? null : 'Ignored expired projectile spawn packet.';
  }

  private receiveDefenderHit(packet: DefenderHitPacket): void {
    if (!this.ready || !this.ownerSession) {
      this.sessionError = 'Received defender hit before the session was ready.';
      return;
    }

    if (packet.roundId !== this.activeRoundId) {
      this.sessionError = null;
      return;
    }

    if (packet.defenderId === this.localPlayerIndex) {
      this.sessionError = 'Ignored defender hit for the local player.';
      return;
    }

    if (this.recovery) {
      this.sessionError = null;
      return;
    }

    if (this.processedDefenderHitIds.has(packet.hitId)) {
      this.sessionError = null;
      return;
    }

    this.processedDefenderHitIds.add(packet.hitId);
    this.ownerSession.applyDefenderHit(packet.defenderId, packet.projectileId, packet.crew, packet.alive);
    this.lastDefenderHitFrame = Math.max(this.lastDefenderHitFrame ?? packet.frame, packet.frame);
    this.sessionError = null;
  }

  private receiveOwnerWeaponEvent(packet: OwnerWeaponEventPacket): void {
    if (!this.ready || !this.ownerSession) {
      this.sessionError = 'Received owner weapon event before the session was ready.';
      return;
    }

    if (packet.roundId !== this.activeRoundId) {
      this.sessionError = null;
      return;
    }

    if (packet.ownerId === this.localPlayerIndex) {
      this.sessionError = 'Ignored owner weapon event for the local player.';
      return;
    }

    if (this.recovery) {
      this.sessionError = null;
      return;
    }

    if (this.processedWeaponEventIds.has(packet.eventId)) {
      this.sessionError = null;
      return;
    }

    this.processedWeaponEventIds.add(packet.eventId);
    this.lastWeaponEventFrame = Math.max(this.lastWeaponEventFrame ?? packet.frame, packet.frame);
    this.applyRemoteWeaponEvent(packet);
    this.queueKronBeamDefenderHit(packet);
    this.sessionError = null;
  }

  private receiveRecoveryRequest(packet: RecoveryRequestPacket): void {
    if (!this.ready || !this.ownerSession) {
      this.sessionError = 'Received recovery request before the session was ready.';
      return;
    }

    if (packet.roundId !== this.activeRoundId) {
      this.sessionError = null;
      return;
    }

    if (this.shouldIgnoreRecoveryPacket(packet.recoveryId)) {
      this.sessionError = null;
      return;
    }

    this.ensureRecovery(packet.recoveryId, 'paused-remote', packet.reason);
    this.queueRecoveryPackets();
    this.sessionError = null;
  }

  private receiveRecoverySnapshot(packet: RecoverySnapshotPacket): void {
    if (!this.ready || !this.ownerSession) {
      this.sessionError = 'Received recovery snapshot before the session was ready.';
      return;
    }

    if (packet.roundId !== this.activeRoundId) {
      this.sessionError = null;
      return;
    }

    if (this.shouldIgnoreRecoveryPacket(packet.recoveryId)) {
      this.sessionError = null;
      return;
    }

    const recovery = this.ensureRecovery(packet.recoveryId, 'paused-remote', 'remote recovery snapshot');
    if (packet.senderId === this.localPlayerIndex) {
      this.sessionError = 'Ignored recovery snapshot for the local player.';
      return;
    }

    recovery.remoteSnapshot = packet.state;
    this.tryReconcileRecovery();
    this.sessionError = null;
  }

  private receiveRecoveryAck(packet: RecoveryAckPacket): void {
    if (packet.roundId !== this.activeRoundId) {
      return;
    }

    if (this.shouldIgnoreRecoveryPacket(packet.recoveryId)) {
      return;
    }

    if (!this.recovery || packet.recoveryId !== this.recovery.id || packet.senderId === this.localPlayerIndex) {
      return;
    }

    this.recovery.ackReceived = true;
    this.tryFinishRecovery();
  }

  private applyRemoteWeaponEvent(packet: OwnerWeaponEventPacket): void {
    this.ownerSession?.applyOwnerWeaponEvent(packet);
  }

  private queueKronBeamDefenderHit(packet: OwnerWeaponEventPacket): void {
    if (packet.effectKind !== 'kronBeam' || packet.ownerId === this.localPlayerIndex || !this.ownerSession) {
      return;
    }

    const state = this.ownerSession.currentState;
    const defender = state.ships[this.localPlayerIndex];
    if (!defender?.alive || !isKronBeamHitting(packet.x as Fixed, packet.y as Fixed, packet.angle as Angle, defender, state)) {
      return;
    }

    const damage = Math.max(1, Math.floor(packet.strength ?? 1));
    const crew = Math.max(0, defender.crew - damage);
    const alive = crew > 0;
    const hitId = `${this.localPlayerIndex}:beam:${packet.eventId}`;
    if (this.processedDefenderHitIds.has(hitId)) {
      return;
    }

    this.processedDefenderHitIds.add(hitId);
    this.ownerSession.applyDefenderHit(this.localPlayerIndex, 0, crew, alive);
    const hitPacket: DefenderHitPacket = {
      roundId: this.activeRoundId,
      hitId,
      frame: state.frame,
      defenderId: this.localPlayerIndex,
      attackerId: packet.ownerId,
      projectileId: 0,
      damage,
      crew,
      alive,
    };
    this.recentLocalDefenderHits.unshift(hitPacket);
    this.recentLocalDefenderHits.length = Math.min(this.recentLocalDefenderHits.length, DEFENDER_HIT_RESEND_COUNT);
    this.outgoingPackets.push(encodeDefenderHitPacket(hitPacket));
    this.lastDefenderHitFrame = Math.max(this.lastDefenderHitFrame ?? state.frame, state.frame);
  }

  private shouldStartRecovery(): boolean {
    return this.ready && this.recovery === null && this.lastOwnerStateFrame !== null && (this.remoteOwnerAgeFrames ?? 0) > REMOTE_OWNER_TIMEOUT_FRAMES;
  }

  private startRecovery(reason: string): RecoveryState {
    return this.ensureRecovery(this.nextRecoveryId++, 'paused-local', reason);
  }

  private ensureRecovery(recoveryId: number, phase: RecoveryPhase, reason: string): RecoveryState {
    if (this.recovery?.id === recoveryId) {
      return this.recovery;
    }

    this.recovery = {
      id: recoveryId,
      phase,
      reason,
      localSnapshot: this.ownerSession?.currentState ?? null,
      remoteSnapshot: null,
      ackReceived: false,
      requestSent: false,
      snapshotSent: false,
      ackSent: false,
    };
    this.nextRecoveryId = Math.max(this.nextRecoveryId, recoveryId + 1);
    return this.recovery;
  }

  private shouldIgnoreRecoveryPacket(recoveryId: number): boolean {
    return recoveryId <= this.lastCompletedRecoveryId || (this.recovery !== null && recoveryId < this.recovery.id);
  }

  private queueRecoveryPackets(): void {
    if (!this.recovery || !this.ownerSession) {
      return;
    }

    const frame = this.ownerSession.currentState.frame;
    if (this.recovery.phase === 'paused-local') {
      this.outgoingPackets.push(
        encodeRecoveryRequestPacket({
          roundId: this.activeRoundId,
          recoveryId: this.recovery.id,
          frame,
          requesterId: this.localPlayerIndex,
          reason: this.recovery.reason,
        }),
      );
      this.recovery.requestSent = true;
    }

    if (this.recovery.phase === 'paused-local' || this.recovery.phase === 'paused-remote' || this.recovery.phase === 'reconciling') {
      this.outgoingPackets.push(
        encodeRecoverySnapshotPacket({
          roundId: this.activeRoundId,
          recoveryId: this.recovery.id,
          frame: this.recovery.localSnapshot?.frame ?? frame,
          senderId: this.localPlayerIndex,
          state: this.recovery.localSnapshot ?? this.ownerSession.currentState,
        }),
      );
      this.recovery.snapshotSent = true;
    }

    if (this.recovery.phase === 'reconciling' && this.recovery.ackSent) {
      this.outgoingPackets.push(encodeRecoveryAckPacket({ roundId: this.activeRoundId, recoveryId: this.recovery.id, frame, senderId: this.localPlayerIndex }));
    }
  }

  private tryReconcileRecovery(): void {
    if (!this.recovery || !this.ownerSession || !this.recovery.localSnapshot || !this.recovery.remoteSnapshot) {
      return;
    }

    const merged = mergeRecoverySnapshots(this.recovery.localSnapshot, this.recovery.remoteSnapshot, this.localPlayerIndex);
    this.ownerSession.replaceState(merged);
    this.resetOwnerFactWindows();
    this.recovery.phase = 'reconciling';
    if (!this.recovery.ackSent) {
      this.outgoingPackets.push(encodeRecoveryAckPacket({ roundId: this.activeRoundId, recoveryId: this.recovery.id, frame: merged.frame, senderId: this.localPlayerIndex }));
      this.recovery.ackSent = true;
    }
    this.tryFinishRecovery();
  }

  private tryFinishRecovery(): void {
    if (!this.recovery || !this.recovery.ackReceived || !this.recovery.ackSent) {
      return;
    }

    this.lastOwnerStateFrame = this.ownerSession?.currentState.frame ?? this.lastOwnerStateFrame;
    this.lastCompletedRecoveryId = Math.max(this.lastCompletedRecoveryId, this.recovery.id);
    this.recovery = null;
  }

  private resetOwnerFactWindows(): void {
    this.recentLocalProjectileSpawns.length = 0;
    this.recentLocalDefenderHits.length = 0;
    this.recentLocalWeaponEvents.length = 0;
    this.receivedProjectileSpawnIds.clear();
    this.processedDefenderHitIds.clear();
    this.processedWeaponEventIds.clear();
  }

  private queueOwnerState(state: GameState, localInput: number): void {
    const ship = state.ships[this.localPlayerIndex];
    if (!ship) {
      return;
    }

    this.outgoingPackets.push(
      encodeOwnerStatePacket({
        roundId: this.activeRoundId,
        frame: state.frame,
        playerId: this.localPlayerIndex,
        ship,
        thrusting: (localInput & InputBits.Thrust) !== 0,
      }),
    );
  }

  private queueProjectileSpawns(previousState: GameState, nextState: GameState): void {
    const previousProjectileIds = new Set(previousState.projectiles.map((projectile) => projectile.id));
    for (const projectile of nextState.projectiles) {
      if (projectile.ownerId !== this.localPlayerIndex || previousProjectileIds.has(projectile.id)) {
        continue;
      }

      this.recentLocalProjectileSpawns.unshift({ roundId: this.activeRoundId, frame: nextState.frame, projectile });
    }

    this.recentLocalProjectileSpawns.length = Math.min(this.recentLocalProjectileSpawns.length, PROJECTILE_SPAWN_RESEND_COUNT);
  }

  private queueDefenderHits(previousState: GameState, nextState: GameState): void {
    const previousShip = previousState.ships[this.localPlayerIndex];
    const nextShip = nextState.ships[this.localPlayerIndex];
    if (!previousShip || !nextShip || nextShip.crew >= previousShip.crew) {
      return;
    }

    const removedRemoteProjectile = previousState.projectiles.find(
      (projectile) =>
        projectile.ownerId !== this.localPlayerIndex &&
        !nextState.projectiles.some((candidate) => candidate.id === projectile.id),
    );
    if (!removedRemoteProjectile || !isPlayerIndex(removedRemoteProjectile.ownerId)) {
      return;
    }

    const packet: DefenderHitPacket = {
      roundId: this.activeRoundId,
      hitId: `${this.localPlayerIndex}:${removedRemoteProjectile.id}`,
      frame: nextState.frame,
      defenderId: this.localPlayerIndex,
      attackerId: removedRemoteProjectile.ownerId,
      projectileId: removedRemoteProjectile.id,
      damage: previousShip.crew - nextShip.crew,
      crew: nextShip.crew,
      alive: nextShip.alive,
    };

    if (this.processedDefenderHitIds.has(packet.hitId)) {
      return;
    }

    this.processedDefenderHitIds.add(packet.hitId);
    this.recentLocalDefenderHits.unshift(packet);
    this.recentLocalDefenderHits.length = Math.min(this.recentLocalDefenderHits.length, DEFENDER_HIT_RESEND_COUNT);
  }

  private queueWeaponEvents(previousState: GameState, nextState: GameState, localInput: number): void {
    const ship = nextState.ships[this.localPlayerIndex];
    const previousShip = previousState.ships[this.localPlayerIndex];
    if (!ship || !previousShip) {
      return;
    }

    const localProjectileSpawned = nextState.projectiles.some(
      (projectile) => projectile.ownerId === this.localPlayerIndex && !previousState.projectiles.some((candidate) => candidate.id === projectile.id),
    );
    if (isFrogChargeRelease(previousShip, ship, localProjectileSpawned)) {
      this.queueWeaponEvent(previousShip, ship, nextState, 'primary', 'frogChargeRelease');
    }
    this.queueWeaponEventForInput(previousShip, ship, nextState, localInput, 'primary', localProjectileSpawned);
    this.queueWeaponEventForInput(previousShip, ship, nextState, localInput, 'secondary', localProjectileSpawned);
    this.recentLocalWeaponEvents.length = Math.min(this.recentLocalWeaponEvents.length, WEAPON_EVENT_RESEND_COUNT);
  }

  private queueWeaponEventForInput(
    previousShip: GameState['ships'][number],
    ship: GameState['ships'][number],
    state: GameState,
    input: number,
    weapon: OwnerWeaponKind,
    localProjectileSpawned: boolean,
  ): void {
    const inputBit = weapon === 'primary' ? InputBits.FirePrimary : InputBits.FireSecondary;
    if ((input & inputBit) === 0 || localProjectileSpawned) {
      return;
    }

    const effectKind = getWeaponEffectKind(previousShip, ship, weapon);
    if (effectKind === null) {
      return;
    }
    this.queueWeaponEvent(previousShip, ship, state, weapon, effectKind);
  }

  private queueWeaponEvent(
    previousShip: GameState['ships'][number],
    ship: GameState['ships'][number],
    state: GameState,
    weapon: OwnerWeaponKind,
    effectKind: OwnerWeaponEffectKind,
  ): void {
    const eventId = `${this.localPlayerIndex}:${state.frame}:${weapon}:${effectKind}`;
    if (this.processedWeaponEventIds.has(eventId)) {
      return;
    }

    const packet: OwnerWeaponEventPacket = {
      roundId: this.activeRoundId,
      eventId,
      frame: state.frame,
      ownerId: this.localPlayerIndex,
      weapon,
      effectKind,
      x: ship.x,
      y: ship.y,
      vx: ship.vx,
      vy: ship.vy,
      angle: ship.angle,
      durationFrames: getWeaponEventDuration(ship, effectKind),
      strength: getWeaponEventStrength(previousShip, ship, effectKind),
    };

    this.processedWeaponEventIds.add(eventId);
    this.recentLocalWeaponEvents.unshift(packet);
  }
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlayerIndex(value: number): value is PlayerIndex {
  return value === 0 || value === 1;
}

function getSessionConfigKey(config: SessionConfigPacket): string {
  return `${config.roundId}:${config.seed}:${config.loadout[0]}:${config.loadout[1]}:${config.aiDemo}:${config.hostPlayerIndex}:${config.joinerPlayerIndex}`;
}

function mergeRecoverySnapshots(local: GameState, remote: GameState, localPlayerIndex: PlayerIndex): GameState {
  const finalFrame = Math.max(local.frame, remote.frame);
  const remotePlayerIndex = localPlayerIndex === 0 ? 1 : 0;
  const higherFrameState = local.frame >= remote.frame ? local : remote;
  const ships = local.ships.map((ship, index) => {
    return index === localPlayerIndex ? ship : remote.ships[remotePlayerIndex];
  });
  const localProjectiles = local.projectiles.filter((projectile) => projectile.ownerId === localPlayerIndex);
  const remoteProjectiles = remote.projectiles.filter((projectile) => projectile.ownerId === remotePlayerIndex);
  const localActors = local.actors.filter((actor) => actor.ownerId === localPlayerIndex);
  const remoteActors = remote.actors.filter((actor) => actor.ownerId === remotePlayerIndex);

  return {
    ...higherFrameState,
    frame: finalFrame,
    ships,
    actors: [...localActors, ...remoteActors],
    projectiles: [...localProjectiles, ...remoteProjectiles],
    nextProjectileId: Math.max(local.nextProjectileId, remote.nextProjectileId),
    nextActorId: Math.max(local.nextActorId, remote.nextActorId),
    winnerId: getWinnerId(ships),
  };
}

function getWinnerId(ships: readonly GameState['ships'][number][]): number | null {
  const aliveShips = ships.filter((ship) => ship.alive);
  return aliveShips.length === 1 ? aliveShips[0].id : null;
}

function getWeaponEffectKind(
  previousShip: GameState['ships'][number],
  ship: GameState['ships'][number],
  weapon: OwnerWeaponKind,
): OwnerWeaponEffectKind | null {
  if (weapon === 'primary') {
    if (ship.shipId === 'kron') {
      return 'kronBeam';
    }
    if (ship.shipId === 'frog' && (ship.custom.frogCharge ?? 0) !== (previousShip.custom.frogCharge ?? 0)) {
      return (previousShip.custom.frogCharge ?? 0) <= 0 ? 'frogChargeStart' : 'frogChargeUpdate';
    }
    return null;
  }

  switch (ship.shipId) {
    case 'frog':
      return 'frogShield';
    case 'kron':
      return 'kronFreeze';
    case 'krab':
      return 'krabToggle';
    case 'voskum':
      return 'voskumBlink';
    case 'zizlik':
      return 'zizlikNode';
    case 'pscout':
      return 'pscoutBeam';
    default:
      return 'generic';
  }
}

function getWeaponEventDuration(ship: GameState['ships'][number], effectKind: OwnerWeaponEffectKind): number | undefined {
  switch (effectKind) {
    case 'pscoutBeam':
      return ship.custom.pscoutBeamFrames;
    case 'kronBeam':
      return ship.primaryCooldown;
    case 'kronFreeze':
      return ship.secondaryCooldown;
    default:
      return undefined;
  }
}

function getWeaponEventStrength(
  previousShip: GameState['ships'][number],
  ship: GameState['ships'][number],
  effectKind: OwnerWeaponEffectKind,
): number | undefined {
  switch (effectKind) {
    case 'frogChargeStart':
    case 'frogChargeUpdate':
      return ship.custom.frogCharge;
    case 'frogChargeRelease':
      return previousShip.custom.frogCharge;
    case 'pscoutBeam':
      return ship.custom.pscoutBeamStrength;
    default:
      return undefined;
  }
}

function isFrogChargeRelease(
  previousShip: GameState['ships'][number],
  ship: GameState['ships'][number],
  localProjectileSpawned: boolean,
): boolean {
  return ship.shipId === 'frog' && localProjectileSpawned && (previousShip.custom.frogCharge ?? 0) > 0 && (ship.custom.frogCharge ?? 0) === 0;
}
