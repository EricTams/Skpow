import type { ShipId } from '../sim/shipSpecs';
import type { GameState, GameplaySettings, ProjectileState, ShipState } from '../sim/types';

export interface InputPacket {
  readonly frame: number;
  readonly input: number;
  readonly previousInputs: readonly number[];
}

export interface StateHashPacket {
  readonly frame: number;
  readonly hash: number;
}

export interface StateCheckpointPacket {
  readonly frame: number;
  readonly hash: number;
  readonly state: GameState;
}

export interface OwnerStatePacket {
  readonly roundId: number;
  readonly frame: number;
  readonly playerId: 0 | 1;
  readonly ship: ShipState;
  // Owner reports whether they were holding thrust this frame so the
  // remote machine can spawn matching thrust dust effects locally.
  readonly thrusting?: boolean;
}

export interface ProjectileSpawnPacket {
  readonly roundId: number;
  readonly frame: number;
  readonly projectile: ProjectileState;
}

export type OwnerWeaponKind = 'primary' | 'secondary';
export type OwnerWeaponEffectKind =
  | 'frogCharge'
  | 'frogChargeStart'
  | 'frogChargeUpdate'
  | 'frogChargeRelease'
  | 'bolterChargeStart'
  | 'bolterChargeUpdate'
  | 'bolterChargeRelease'
  | 'bolterBlossom'
  | 'frogShield'
  | 'kronBeam'
  | 'kronFreeze'
  | 'krabToggle'
  | 'voskumBlink'
  | 'zizlikNode'
  | 'pscoutBeam'
  | 'nurtipDetonate'
  | 'generic';

export interface OwnerWeaponEventPacket {
  readonly roundId: number;
  readonly eventId: string;
  readonly frame: number;
  readonly ownerId: 0 | 1;
  readonly weapon: OwnerWeaponKind;
  readonly effectKind: OwnerWeaponEffectKind;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly durationFrames?: number;
  readonly strength?: number;
}

export interface DefenderHitPacket {
  readonly roundId: number;
  readonly hitId: string;
  readonly frame: number;
  readonly defenderId: 0 | 1;
  readonly attackerId: 0 | 1;
  readonly projectileId: number;
  readonly damage: number;
  readonly crew: number;
  readonly alive: boolean;
}

export interface RecoveryRequestPacket {
  readonly roundId: number;
  readonly recoveryId: number;
  readonly frame: number;
  readonly requesterId: 0 | 1;
  readonly reason: string;
}

export interface RecoverySnapshotPacket {
  readonly roundId: number;
  readonly recoveryId: number;
  readonly frame: number;
  readonly senderId: 0 | 1;
  readonly state: GameState;
}

export interface RecoveryAckPacket {
  readonly roundId: number;
  readonly recoveryId: number;
  readonly frame: number;
  readonly senderId: 0 | 1;
}

export interface SessionConfigPacket {
  readonly roundId: number;
  readonly seed: number;
  readonly loadout: readonly [ShipId, ShipId];
  readonly gameplay: GameplaySettings;
  readonly aiDemo: boolean;
  readonly startFrame: number;
  readonly hostPlayerIndex: 0 | 1;
  readonly joinerPlayerIndex: 0 | 1;
}

export interface SessionReadyPacket {}

export interface SessionReadyAckPacket {}

export const GAMEPLAY_PROTOCOL_VERSION = 9;
const HEADER_LENGTH = 2;
const ALLOWED_SPEED_MULTIPLIERS = new Set([1, 1.5, 2]);
const STATE_CHECKPOINT_HEADER_LENGTH = 10;

export enum GameplayPacketType {
  SessionConfig = 1,
  Input = 2,
  StateHash = 3,
  SessionReady = 4,
  SessionReadyAck = 5,
  StateCheckpoint = 6,
  OwnerState = 7,
  ProjectileSpawn = 8,
  DefenderHit = 9,
  OwnerWeaponEvent = 10,
  RecoveryRequest = 11,
  RecoverySnapshot = 12,
  RecoveryAck = 13,
}

export type GameplayPacket =
  | ({ readonly type: GameplayPacketType.SessionConfig } & SessionConfigPacket)
  | ({ readonly type: GameplayPacketType.Input } & InputPacket)
  | ({ readonly type: GameplayPacketType.StateHash } & StateHashPacket)
  | ({ readonly type: GameplayPacketType.StateCheckpoint } & StateCheckpointPacket)
  | ({ readonly type: GameplayPacketType.OwnerState } & OwnerStatePacket)
  | ({ readonly type: GameplayPacketType.ProjectileSpawn } & ProjectileSpawnPacket)
  | ({ readonly type: GameplayPacketType.DefenderHit } & DefenderHitPacket)
  | ({ readonly type: GameplayPacketType.OwnerWeaponEvent } & OwnerWeaponEventPacket)
  | ({ readonly type: GameplayPacketType.RecoveryRequest } & RecoveryRequestPacket)
  | ({ readonly type: GameplayPacketType.RecoverySnapshot } & RecoverySnapshotPacket)
  | ({ readonly type: GameplayPacketType.RecoveryAck } & RecoveryAckPacket)
  | ({ readonly type: GameplayPacketType.SessionReady } & SessionReadyPacket)
  | ({ readonly type: GameplayPacketType.SessionReadyAck } & SessionReadyAckPacket);

export function encodeInputPacket(packet: InputPacket): Uint8Array {
  const previousCount = Math.min(4, packet.previousInputs.length);
  const bytes = new Uint8Array(8 + previousCount);
  const view = new DataView(bytes.buffer);
  writeHeader(bytes, GameplayPacketType.Input);
  view.setUint32(2, packet.frame, true);
  bytes[6] = packet.input & 0xff;
  bytes[7] = previousCount;

  for (let i = 0; i < previousCount; i += 1) {
    bytes[8 + i] = packet.previousInputs[i] & 0xff;
  }

  return bytes;
}

export function decodeInputPacket(bytes: Uint8Array): InputPacket {
  assertHeader(bytes, GameplayPacketType.Input);
  if (bytes.byteLength < 8) {
    throw new Error('Input packet is too short.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const previousCount = bytes[7];
  const previousInputs: number[] = [];

  for (let i = 0; i < previousCount && 8 + i < bytes.byteLength; i += 1) {
    previousInputs.push(bytes[8 + i]);
  }

  return {
    frame: view.getUint32(2, true),
    input: bytes[6],
    previousInputs,
  };
}

export function encodeStateHashPacket(packet: StateHashPacket): Uint8Array {
  const bytes = new Uint8Array(10);
  const view = new DataView(bytes.buffer);
  writeHeader(bytes, GameplayPacketType.StateHash);
  view.setUint32(2, packet.frame, true);
  view.setUint32(6, packet.hash, true);
  return bytes;
}

export function decodeStateHashPacket(bytes: Uint8Array): StateHashPacket {
  assertHeader(bytes, GameplayPacketType.StateHash);
  if (bytes.byteLength !== 10) {
    throw new Error('State hash packet must be exactly 10 bytes.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    frame: view.getUint32(2, true),
    hash: view.getUint32(6, true),
  };
}

export function encodeStateCheckpointPacket(packet: StateCheckpointPacket): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(packet.state));
  const bytes = new Uint8Array(STATE_CHECKPOINT_HEADER_LENGTH + payload.byteLength);
  const view = new DataView(bytes.buffer);
  writeHeader(bytes, GameplayPacketType.StateCheckpoint);
  view.setUint32(2, packet.frame, true);
  view.setUint32(6, packet.hash, true);
  bytes.set(payload, STATE_CHECKPOINT_HEADER_LENGTH);
  return bytes;
}

export function decodeStateCheckpointPacket(bytes: Uint8Array): StateCheckpointPacket {
  assertHeader(bytes, GameplayPacketType.StateCheckpoint);
  if (bytes.byteLength <= STATE_CHECKPOINT_HEADER_LENGTH) {
    throw new Error('State checkpoint packet is missing its state payload.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payload = new TextDecoder().decode(bytes.subarray(STATE_CHECKPOINT_HEADER_LENGTH));
  const state = readGameState(payload);
  const frame = view.getUint32(2, true);
  if (state.frame !== frame) {
    throw new Error('State checkpoint frame does not match its state payload.');
  }

  return {
    frame,
    hash: view.getUint32(6, true),
    state,
  };
}

export function encodeOwnerStatePacket(packet: OwnerStatePacket): Uint8Array {
  return encodeJsonPacket(GameplayPacketType.OwnerState, packet);
}

export function decodeOwnerStatePacket(bytes: Uint8Array): OwnerStatePacket {
  assertHeader(bytes, GameplayPacketType.OwnerState);
  const packet = readJsonPacket<OwnerStatePacket>(bytes, 'Owner state packet');
  if (!Number.isInteger(packet.roundId) || !isPlayerIndex(packet.playerId) || packet.ship.id !== packet.playerId) {
    throw new Error('Owner state packet has an invalid player id.');
  }
  return packet;
}

export function encodeProjectileSpawnPacket(packet: ProjectileSpawnPacket): Uint8Array {
  return encodeJsonPacket(GameplayPacketType.ProjectileSpawn, packet);
}

export function decodeProjectileSpawnPacket(bytes: Uint8Array): ProjectileSpawnPacket {
  assertHeader(bytes, GameplayPacketType.ProjectileSpawn);
  const packet = readJsonPacket<ProjectileSpawnPacket>(bytes, 'Projectile spawn packet');
  if (
    !Number.isInteger(packet.roundId) ||
    !isPlayerIndex(packet.projectile.ownerId) ||
    !isProjectileIdForOwner(packet.projectile.id, packet.projectile.ownerId)
  ) {
    throw new Error('Projectile spawn packet has an invalid projectile owner/id pair.');
  }
  return packet;
}

export function encodeOwnerWeaponEventPacket(packet: OwnerWeaponEventPacket): Uint8Array {
  return encodeJsonPacket(GameplayPacketType.OwnerWeaponEvent, packet);
}

export function decodeOwnerWeaponEventPacket(bytes: Uint8Array): OwnerWeaponEventPacket {
  assertHeader(bytes, GameplayPacketType.OwnerWeaponEvent);
  const packet = readJsonPacket<OwnerWeaponEventPacket>(bytes, 'Owner weapon event packet');
  if (!Number.isInteger(packet.roundId) || !isPlayerIndex(packet.ownerId) || !isOwnerWeapon(packet.weapon) || !isOwnerWeaponEffect(packet.effectKind)) {
    throw new Error('Owner weapon event packet has an invalid owner or effect.');
  }
  return packet;
}

export function encodeDefenderHitPacket(packet: DefenderHitPacket): Uint8Array {
  return encodeJsonPacket(GameplayPacketType.DefenderHit, packet);
}

export function decodeDefenderHitPacket(bytes: Uint8Array): DefenderHitPacket {
  assertHeader(bytes, GameplayPacketType.DefenderHit);
  const packet = readJsonPacket<DefenderHitPacket>(bytes, 'Defender hit packet');
  if (!Number.isInteger(packet.roundId) || !isPlayerIndex(packet.defenderId) || !isPlayerIndex(packet.attackerId)) {
    throw new Error('Defender hit packet has an invalid player id.');
  }
  if (packet.projectileId !== 0 && !isProjectileIdForOwner(packet.projectileId, packet.attackerId)) {
    throw new Error('Defender hit packet has an invalid projectile owner/id pair.');
  }
  return packet;
}

export function encodeRecoveryRequestPacket(packet: RecoveryRequestPacket): Uint8Array {
  return encodeJsonPacket(GameplayPacketType.RecoveryRequest, packet);
}

export function decodeRecoveryRequestPacket(bytes: Uint8Array): RecoveryRequestPacket {
  assertHeader(bytes, GameplayPacketType.RecoveryRequest);
  const packet = readJsonPacket<RecoveryRequestPacket>(bytes, 'Recovery request packet');
  if (!Number.isInteger(packet.roundId) || !isPlayerIndex(packet.requesterId)) {
    throw new Error('Recovery request packet has an invalid requester id.');
  }
  return packet;
}

export function encodeRecoverySnapshotPacket(packet: RecoverySnapshotPacket): Uint8Array {
  return encodeJsonPacket(GameplayPacketType.RecoverySnapshot, packet);
}

export function decodeRecoverySnapshotPacket(bytes: Uint8Array): RecoverySnapshotPacket {
  assertHeader(bytes, GameplayPacketType.RecoverySnapshot);
  const packet = readJsonPacket<RecoverySnapshotPacket>(bytes, 'Recovery snapshot packet');
  if (!Number.isInteger(packet.roundId) || !isPlayerIndex(packet.senderId) || packet.state.frame !== packet.frame) {
    throw new Error('Recovery snapshot packet has an invalid sender or state frame.');
  }
  return packet;
}

export function encodeRecoveryAckPacket(packet: RecoveryAckPacket): Uint8Array {
  return encodeJsonPacket(GameplayPacketType.RecoveryAck, packet);
}

export function decodeRecoveryAckPacket(bytes: Uint8Array): RecoveryAckPacket {
  assertHeader(bytes, GameplayPacketType.RecoveryAck);
  const packet = readJsonPacket<RecoveryAckPacket>(bytes, 'Recovery ack packet');
  if (!Number.isInteger(packet.roundId) || !isPlayerIndex(packet.senderId)) {
    throw new Error('Recovery ack packet has an invalid sender id.');
  }
  return packet;
}

export function encodeSessionConfigPacket(packet: SessionConfigPacket): Uint8Array {
  return encodeJsonPacket(GameplayPacketType.SessionConfig, packet);
}

export function decodeSessionConfigPacket(bytes: Uint8Array): SessionConfigPacket {
  assertHeader(bytes, GameplayPacketType.SessionConfig);
  const packet = readJsonPacket<SessionConfigPacket>(bytes, 'Session config packet');
  if (!isPlayerIndex(packet.hostPlayerIndex) || !isPlayerIndex(packet.joinerPlayerIndex)) {
    throw new Error('Session config packet has an invalid player index.');
  }
  if (!Number.isInteger(packet.roundId) || !Number.isInteger(packet.seed) || !Number.isInteger(packet.startFrame)) {
    throw new Error('Session config packet has invalid numeric fields.');
  }
  if (typeof packet.aiDemo !== 'boolean') {
    throw new Error('Session config packet has an invalid AI demo flag.');
  }
  if (
    typeof packet.gameplay !== 'object' ||
    packet.gameplay === null ||
    !Number.isInteger(packet.gameplay.gravityDivisor) ||
    packet.gameplay.gravityDivisor < 1 ||
    !ALLOWED_SPEED_MULTIPLIERS.has(packet.gameplay.speedMultiplier)
  ) {
    throw new Error('Session config packet has invalid gameplay settings.');
  }
  if (!Array.isArray(packet.loadout) || packet.loadout.length !== 2 || !isShipId(packet.loadout[0]) || !isShipId(packet.loadout[1])) {
    throw new Error('Session config packet has an invalid loadout.');
  }

  return packet;
}

export function encodeSessionReadyPacket(_packet: SessionReadyPacket = {}): Uint8Array {
  const bytes = new Uint8Array(HEADER_LENGTH);
  writeHeader(bytes, GameplayPacketType.SessionReady);
  return bytes;
}

export function decodeSessionReadyPacket(bytes: Uint8Array): SessionReadyPacket {
  assertHeader(bytes, GameplayPacketType.SessionReady);
  if (bytes.byteLength !== HEADER_LENGTH) {
    throw new Error('Session ready packet must be exactly 2 bytes.');
  }

  return {};
}

export function encodeSessionReadyAckPacket(_packet: SessionReadyAckPacket = {}): Uint8Array {
  const bytes = new Uint8Array(HEADER_LENGTH);
  writeHeader(bytes, GameplayPacketType.SessionReadyAck);
  return bytes;
}

export function decodeSessionReadyAckPacket(bytes: Uint8Array): SessionReadyAckPacket {
  assertHeader(bytes, GameplayPacketType.SessionReadyAck);
  if (bytes.byteLength !== HEADER_LENGTH) {
    throw new Error('Session ready ack packet must be exactly 2 bytes.');
  }

  return {};
}

export function decodeGameplayPacket(bytes: Uint8Array): GameplayPacket {
  if (bytes.byteLength < HEADER_LENGTH) {
    throw new Error('Gameplay packet is too short.');
  }

  assertProtocolVersion(bytes);

  switch (bytes[1]) {
    case GameplayPacketType.SessionConfig:
      return { type: GameplayPacketType.SessionConfig, ...decodeSessionConfigPacket(bytes) };
    case GameplayPacketType.Input:
      return { type: GameplayPacketType.Input, ...decodeInputPacket(bytes) };
    case GameplayPacketType.StateHash:
      return { type: GameplayPacketType.StateHash, ...decodeStateHashPacket(bytes) };
    case GameplayPacketType.StateCheckpoint:
      return { type: GameplayPacketType.StateCheckpoint, ...decodeStateCheckpointPacket(bytes) };
    case GameplayPacketType.OwnerState:
      return { type: GameplayPacketType.OwnerState, ...decodeOwnerStatePacket(bytes) };
    case GameplayPacketType.ProjectileSpawn:
      return { type: GameplayPacketType.ProjectileSpawn, ...decodeProjectileSpawnPacket(bytes) };
    case GameplayPacketType.DefenderHit:
      return { type: GameplayPacketType.DefenderHit, ...decodeDefenderHitPacket(bytes) };
    case GameplayPacketType.OwnerWeaponEvent:
      return { type: GameplayPacketType.OwnerWeaponEvent, ...decodeOwnerWeaponEventPacket(bytes) };
    case GameplayPacketType.RecoveryRequest:
      return { type: GameplayPacketType.RecoveryRequest, ...decodeRecoveryRequestPacket(bytes) };
    case GameplayPacketType.RecoverySnapshot:
      return { type: GameplayPacketType.RecoverySnapshot, ...decodeRecoverySnapshotPacket(bytes) };
    case GameplayPacketType.RecoveryAck:
      return { type: GameplayPacketType.RecoveryAck, ...decodeRecoveryAckPacket(bytes) };
    case GameplayPacketType.SessionReady:
      return { type: GameplayPacketType.SessionReady, ...decodeSessionReadyPacket(bytes) };
    case GameplayPacketType.SessionReadyAck:
      return { type: GameplayPacketType.SessionReadyAck, ...decodeSessionReadyAckPacket(bytes) };
    default:
      throw new Error(`Unknown gameplay packet type: ${bytes[1]}.`);
  }
}

function writeHeader(bytes: Uint8Array, type: GameplayPacketType): void {
  bytes[0] = GAMEPLAY_PROTOCOL_VERSION;
  bytes[1] = type;
}

function assertHeader(bytes: Uint8Array, type: GameplayPacketType): void {
  if (bytes.byteLength < HEADER_LENGTH) {
    throw new Error('Gameplay packet is too short.');
  }

  assertProtocolVersion(bytes);
  if (bytes[1] !== type) {
    throw new Error(`Expected gameplay packet type ${type}, received ${bytes[1]}.`);
  }
}

function assertProtocolVersion(bytes: Uint8Array): void {
  if (bytes[0] !== GAMEPLAY_PROTOCOL_VERSION) {
    throw new Error(`Unsupported gameplay protocol version: ${bytes[0]}.`);
  }
}

function isPlayerIndex(value: number): value is 0 | 1 {
  return value === 0 || value === 1;
}

function isProjectileIdForOwner(projectileId: number, ownerId: 0 | 1): boolean {
  return Number.isInteger(projectileId) && projectileId > 0 && projectileId % 2 === (ownerId === 0 ? 1 : 0);
}

function isOwnerWeapon(value: string): value is OwnerWeaponKind {
  return value === 'primary' || value === 'secondary';
}

function isOwnerWeaponEffect(value: string): value is OwnerWeaponEffectKind {
  return (
    value === 'frogCharge' ||
    value === 'frogChargeStart' ||
    value === 'frogChargeUpdate' ||
    value === 'frogChargeRelease' ||
    value === 'bolterChargeStart' ||
    value === 'bolterChargeUpdate' ||
    value === 'bolterChargeRelease' ||
    value === 'bolterBlossom' ||
    value === 'frogShield' ||
    value === 'kronBeam' ||
    value === 'kronFreeze' ||
    value === 'krabToggle' ||
    value === 'voskumBlink' ||
    value === 'zizlikNode' ||
    value === 'pscoutBeam' ||
    value === 'nurtipDetonate' ||
    value === 'generic'
  );
}

function isShipId(value: unknown): value is ShipId {
  return (
    value === 'frog' ||
    value === 'cannonade' ||
    value === 'zizlik' ||
    value === 'voskum' ||
    value === 'pscout' ||
    value === 'kron' ||
    value === 'gooj' ||
    value === 'krab' ||
    value === 'nurtip' ||
    value === 'duk' ||
    value === 'discfighter' ||
    value === 'doubleship' ||
    value === 'bolter' ||
    value === 'shugg'
  );
}

function encodeJsonPacket(type: GameplayPacketType, packet: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(packet));
  const bytes = new Uint8Array(HEADER_LENGTH + payload.byteLength);
  writeHeader(bytes, type);
  bytes.set(payload, HEADER_LENGTH);
  return bytes;
}

function readJsonPacket<T>(bytes: Uint8Array, packetName: string): T {
  if (bytes.byteLength <= HEADER_LENGTH) {
    throw new Error(`${packetName} is missing its payload.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_LENGTH)));
  } catch {
    throw new Error(`${packetName} has invalid JSON payload.`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${packetName} has an invalid payload.`);
  }

  return parsed as T;
}

function readGameState(payload: string): GameState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('State checkpoint packet has invalid JSON payload.');
  }

  if (!isRecord(parsed) || !Number.isInteger(parsed.frame) || !Array.isArray(parsed.ships)) {
    throw new Error('State checkpoint packet has an invalid state payload.');
  }

  if (!Array.isArray(parsed.actors) || !Array.isArray(parsed.projectiles)) {
    throw new Error('State checkpoint packet has an invalid state payload.');
  }

  if (!isRecord(parsed.arena) || !isRecord(parsed.planet)) {
    throw new Error('State checkpoint packet has an invalid state payload.');
  }

  if (!Number.isInteger(parsed.nextProjectileId) || !Number.isInteger(parsed.nextActorId) || !Number.isInteger(parsed.rngSeed)) {
    throw new Error('State checkpoint packet has an invalid state payload.');
  }

  return parsed as unknown as GameState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
