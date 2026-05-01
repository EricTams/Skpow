export interface InputPacket {
  readonly frame: number;
  readonly input: number;
  readonly previousInputs: readonly number[];
}

export interface StateHashPacket {
  readonly frame: number;
  readonly hash: number;
}

export interface SessionConfigPacket {
  readonly seed: number;
  readonly startFrame: number;
  readonly hostPlayerIndex: 0 | 1;
  readonly joinerPlayerIndex: 0 | 1;
}

export interface SessionReadyPacket {}

export interface SessionReadyAckPacket {}

export const GAMEPLAY_PROTOCOL_VERSION = 1;
const HEADER_LENGTH = 2;

export enum GameplayPacketType {
  SessionConfig = 1,
  Input = 2,
  StateHash = 3,
  SessionReady = 4,
  SessionReadyAck = 5,
}

export type GameplayPacket =
  | ({ readonly type: GameplayPacketType.SessionConfig } & SessionConfigPacket)
  | ({ readonly type: GameplayPacketType.Input } & InputPacket)
  | ({ readonly type: GameplayPacketType.StateHash } & StateHashPacket)
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

export function encodeSessionConfigPacket(packet: SessionConfigPacket): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  writeHeader(bytes, GameplayPacketType.SessionConfig);
  view.setUint32(2, packet.seed, true);
  view.setUint32(6, packet.startFrame, true);
  bytes[10] = packet.hostPlayerIndex;
  bytes[11] = packet.joinerPlayerIndex;
  return bytes;
}

export function decodeSessionConfigPacket(bytes: Uint8Array): SessionConfigPacket {
  assertHeader(bytes, GameplayPacketType.SessionConfig);
  if (bytes.byteLength !== 12) {
    throw new Error('Session config packet must be exactly 12 bytes.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hostPlayerIndex = bytes[10];
  const joinerPlayerIndex = bytes[11];
  if (!isPlayerIndex(hostPlayerIndex) || !isPlayerIndex(joinerPlayerIndex)) {
    throw new Error('Session config packet has an invalid player index.');
  }

  return {
    seed: view.getUint32(2, true),
    startFrame: view.getUint32(6, true),
    hostPlayerIndex,
    joinerPlayerIndex,
  };
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
