import { describe, expect, it } from 'vitest';

import { InputBits } from '../sim/types';
import { fixed, fixedFromInt } from '../sim/fixed';
import { angle } from '../sim/trig';
import {
  decodeGameplayPacket,
  decodeInputPacket,
  decodeSessionConfigPacket,
  decodeSessionReadyAckPacket,
  decodeSessionReadyPacket,
  decodeDefenderHitPacket,
  decodeOwnerStatePacket,
  decodeOwnerWeaponEventPacket,
  decodeProjectileSpawnPacket,
  decodeRecoveryAckPacket,
  decodeRecoveryRequestPacket,
  decodeRecoverySnapshotPacket,
  decodeStateCheckpointPacket,
  decodeStateHashPacket,
  encodeDefenderHitPacket,
  encodeInputPacket,
  encodeOwnerStatePacket,
  encodeOwnerWeaponEventPacket,
  encodeProjectileSpawnPacket,
  encodeRecoveryAckPacket,
  encodeRecoveryRequestPacket,
  encodeRecoverySnapshotPacket,
  encodeSessionConfigPacket,
  encodeSessionReadyAckPacket,
  encodeSessionReadyPacket,
  encodeStateCheckpointPacket,
  encodeStateHashPacket,
  GameplayPacketType,
} from './protocol';
import { createInitialState } from '../sim/state';
import { hashState } from '../sim/hash';

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

  it('round-trips authoritative state checkpoint packets', () => {
    const state = createInitialState(123);
    const packet = { frame: state.frame, hash: hashState(state), state };

    expect(decodeStateCheckpointPacket(encodeStateCheckpointPacket(packet))).toEqual(packet);
    expect(decodeGameplayPacket(encodeStateCheckpointPacket(packet))).toEqual({
      type: GameplayPacketType.StateCheckpoint,
      ...packet,
    });
  });

  it('round-trips owner state packets', () => {
    const state = createInitialState(123);
    const packet = { roundId: 2, frame: 7, playerId: 0 as const, ship: state.ships[0] };

    expect(decodeOwnerStatePacket(encodeOwnerStatePacket(packet))).toEqual(packet);
    expect(decodeGameplayPacket(encodeOwnerStatePacket(packet))).toEqual({
      type: GameplayPacketType.OwnerState,
      ...packet,
    });
  });

  it('round-trips projectile spawn packets', () => {
    const projectile = {
      id: 1,
      ownerId: 0,
      kind: 'frogBubble' as const,
      x: fixedFromInt(10),
      y: fixedFromInt(20),
      vx: fixedFromInt(30),
      vy: fixedFromInt(40),
      angle: angle(0),
      ttl: 50,
      damage: 1,
      radius: fixedFromInt(60),
      rotation: fixed(0),
      trackPct: fixed(0),
      variety: 0,
      active: true,
    };
    const packet = { roundId: 2, frame: 9, projectile };

    expect(decodeProjectileSpawnPacket(encodeProjectileSpawnPacket(packet))).toEqual(packet);
    expect(decodeGameplayPacket(encodeProjectileSpawnPacket(packet))).toEqual({
      type: GameplayPacketType.ProjectileSpawn,
      ...packet,
    });
  });

  it('round-trips owner weapon event packets', () => {
    const packet = {
      roundId: 2,
      eventId: '0:12:primary:kronBeam',
      frame: 12,
      ownerId: 0 as const,
      weapon: 'primary' as const,
      effectKind: 'kronBeam' as const,
      x: fixedFromInt(10),
      y: fixedFromInt(20),
      vx: fixed(1),
      vy: fixed(2),
      angle: angle(32),
      durationFrames: 18,
      strength: 1,
    };

    expect(decodeOwnerWeaponEventPacket(encodeOwnerWeaponEventPacket(packet))).toEqual(packet);
    expect(decodeGameplayPacket(encodeOwnerWeaponEventPacket(packet))).toEqual({
      type: GameplayPacketType.OwnerWeaponEvent,
      ...packet,
    });
  });

  it('round-trips defender hit packets', () => {
    const packet = {
      roundId: 2,
      hitId: '1:1',
      frame: 12,
      defenderId: 1 as const,
      attackerId: 0 as const,
      projectileId: 1,
      damage: 2,
      crew: 8,
      alive: true,
    };

    expect(decodeDefenderHitPacket(encodeDefenderHitPacket(packet))).toEqual(packet);
    expect(decodeGameplayPacket(encodeDefenderHitPacket(packet))).toEqual({
      type: GameplayPacketType.DefenderHit,
      ...packet,
    });
  });

  it('round-trips recovery request, snapshot, and ack packets', () => {
    const state = createInitialState(123);
    const request = { roundId: 2, recoveryId: 4, frame: 30, requesterId: 0 as const, reason: 'remote owner updates stale' };
    const snapshot = { roundId: 2, recoveryId: 4, frame: state.frame, senderId: 1 as const, state };
    const ack = { roundId: 2, recoveryId: 4, frame: 31, senderId: 0 as const };

    expect(decodeRecoveryRequestPacket(encodeRecoveryRequestPacket(request))).toEqual(request);
    expect(decodeGameplayPacket(encodeRecoveryRequestPacket(request))).toEqual({
      type: GameplayPacketType.RecoveryRequest,
      ...request,
    });
    expect(decodeRecoverySnapshotPacket(encodeRecoverySnapshotPacket(snapshot))).toEqual(snapshot);
    expect(decodeGameplayPacket(encodeRecoverySnapshotPacket(snapshot))).toEqual({
      type: GameplayPacketType.RecoverySnapshot,
      ...snapshot,
    });
    expect(decodeRecoveryAckPacket(encodeRecoveryAckPacket(ack))).toEqual(ack);
    expect(decodeGameplayPacket(encodeRecoveryAckPacket(ack))).toEqual({
      type: GameplayPacketType.RecoveryAck,
      ...ack,
    });
  });

  it('rejects malformed state checkpoint packets', () => {
    const state = createInitialState(123);
    const packet = encodeStateCheckpointPacket({ frame: state.frame + 1, hash: hashState(state), state });

    expect(() => decodeStateCheckpointPacket(packet)).toThrow('State checkpoint frame does not match its state payload.');
    expect(() => decodeStateCheckpointPacket(new Uint8Array([7, GameplayPacketType.StateCheckpoint]))).toThrow(
      'State checkpoint packet is missing its state payload.',
    );
  });

  it('round-trips session config packets', () => {
    const packet = {
      roundId: 2,
      seed: 123,
      loadout: ['frog', 'cannonade'] as const,
      gameplay: { gravityDivisor: 6, speedMultiplier: 1.5 },
      aiDemo: true,
      startFrame: 0,
      hostPlayerIndex: 0 as const,
      joinerPlayerIndex: 1 as const,
    };

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
    expect(() => decodeSessionReadyPacket(new Uint8Array([7, GameplayPacketType.SessionReady, 0]))).toThrow(
      'Session ready packet must be exactly 2 bytes.',
    );
    expect(() => decodeSessionReadyAckPacket(new Uint8Array([7, GameplayPacketType.SessionReadyAck, 0]))).toThrow(
      'Session ready ack packet must be exactly 2 bytes.',
    );
  });

  it('rejects unknown versions and packet types', () => {
    expect(() => decodeGameplayPacket(new Uint8Array([99, GameplayPacketType.Input]))).toThrow(
      'Unsupported gameplay protocol version',
    );
    expect(() => decodeGameplayPacket(new Uint8Array([7, 99]))).toThrow('Unknown gameplay packet type');
  });
});
