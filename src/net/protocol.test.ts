import { describe, expect, it } from 'vitest';

import { InputBits } from '../sim/types';
import {
  decodeGameplayPacket,
  decodeInputPacket,
  decodeSessionConfigPacket,
  decodeSessionReadyAckPacket,
  decodeSessionReadyPacket,
  decodeStateHashPacket,
  encodeInputPacket,
  encodeSessionConfigPacket,
  encodeSessionReadyAckPacket,
  encodeSessionReadyPacket,
  encodeStateHashPacket,
  GameplayPacketType,
} from './protocol';

describe('network protocol packets', () => {
  it('round-trips gameplay input packets', () => {
    const packet = {
      frame: 42,
      input: InputBits.Thrust | InputBits.FirePrimary,
      previousInputs: [1, 2, 3, 4, 5],
    };

    expect(decodeInputPacket(encodeInputPacket(packet))).toEqual({
      frame: 42,
      input: packet.input,
      previousInputs: [1, 2, 3, 4],
    });
    expect(decodeGameplayPacket(encodeInputPacket(packet))).toEqual({
      type: GameplayPacketType.Input,
      frame: 42,
      input: packet.input,
      previousInputs: [1, 2, 3, 4],
    });
  });

  it('round-trips state hash packets', () => {
    const packet = { frame: 60, hash: 0xabcd_1234 };

    expect(decodeStateHashPacket(encodeStateHashPacket(packet))).toEqual(packet);
    expect(decodeGameplayPacket(encodeStateHashPacket(packet))).toEqual({
      type: GameplayPacketType.StateHash,
      ...packet,
    });
  });

  it('round-trips session config packets', () => {
    const packet = { seed: 123, startFrame: 0, hostPlayerIndex: 0 as const, joinerPlayerIndex: 1 as const };

    expect(decodeSessionConfigPacket(encodeSessionConfigPacket(packet))).toEqual(packet);
    expect(decodeGameplayPacket(encodeSessionConfigPacket(packet))).toEqual({
      type: GameplayPacketType.SessionConfig,
      ...packet,
    });
  });

  it('round-trips session readiness packets', () => {
    expect(decodeSessionReadyPacket(encodeSessionReadyPacket())).toEqual({});
    expect(decodeGameplayPacket(encodeSessionReadyPacket())).toEqual({
      type: GameplayPacketType.SessionReady,
    });

    expect(decodeSessionReadyAckPacket(encodeSessionReadyAckPacket())).toEqual({});
    expect(decodeGameplayPacket(encodeSessionReadyAckPacket())).toEqual({
      type: GameplayPacketType.SessionReadyAck,
    });
  });

  it('rejects malformed session readiness packets', () => {
    expect(() => decodeSessionReadyPacket(new Uint8Array([1, GameplayPacketType.SessionReady, 0]))).toThrow(
      'Session ready packet must be exactly 2 bytes.',
    );
    expect(() => decodeSessionReadyAckPacket(new Uint8Array([1, GameplayPacketType.SessionReadyAck, 0]))).toThrow(
      'Session ready ack packet must be exactly 2 bytes.',
    );
  });

  it('rejects unknown versions and packet types', () => {
    expect(() => decodeGameplayPacket(new Uint8Array([99, GameplayPacketType.Input]))).toThrow(
      'Unsupported gameplay protocol version',
    );
    expect(() => decodeGameplayPacket(new Uint8Array([1, 99]))).toThrow('Unknown gameplay packet type');
  });
});
