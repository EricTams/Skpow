import { describe, expect, it } from 'vitest';

import { hashState } from '../sim/hash';
import { runReplay } from '../sim/replay';
import { createInitialState } from '../sim/state';
import { InputBits, type FrameInputs } from '../sim/types';
import { decodeGameplayPacket, encodeInputPacket, encodeSessionConfigPacket, encodeStateHashPacket, GameplayPacketType } from './protocol';
import { NetworkMatchSession } from './matchSession';

describe('network match session', () => {
  it('has the host emit session config for the joiner', () => {
    const host = new NetworkMatchSession('host', { seed: 123 });
    const packets = host.takeOutgoingPackets();

    expect(packets).toHaveLength(1);
    expect(decodeGameplayPacket(packets[0])).toEqual({
      type: GameplayPacketType.SessionConfig,
      seed: 123,
      startFrame: 0,
      hostPlayerIndex: 0,
      joinerPlayerIndex: 1,
    });
  });

  it('resends host session config and does not step until joiner readiness arrives', () => {
    const host = new NetworkMatchSession('host', { seed: 123 });
    host.takeOutgoingPackets();

    const result = host.step(InputBits.Thrust);
    const packets = result.packets.map((packet) => decodeGameplayPacket(packet).type);

    expect(result.state).toBeNull();
    expect(host.ready).toBe(false);
    expect(packets).toContain(GameplayPacketType.SessionConfig);
    expect(packets).not.toContain(GameplayPacketType.Input);
  });

  it('uses session ready and ack packets before either peer is ready', () => {
    const host = new NetworkMatchSession('host', { seed: 123 });
    const joiner = new NetworkMatchSession('joiner');
    const configPackets = host.takeOutgoingPackets();

    expect(host.ready).toBe(false);
    expect(joiner.ready).toBe(false);

    for (const packet of configPackets) {
      joiner.receiveGameplayMessage(packet);
    }

    const readyPackets = joiner.takeOutgoingPackets();
    expect(readyPackets.map((packet) => decodeGameplayPacket(packet).type)).toEqual([GameplayPacketType.SessionReady]);
    expect(joiner.ready).toBe(false);

    for (const packet of readyPackets) {
      host.receiveGameplayMessage(packet);
    }

    expect(host.ready).toBe(true);
    const ackPackets = host.takeOutgoingPackets();
    expect(ackPackets.map((packet) => decodeGameplayPacket(packet).type)).toEqual([GameplayPacketType.SessionReadyAck]);

    for (const packet of ackPackets) {
      joiner.receiveGameplayMessage(packet);
    }

    expect(joiner.ready).toBe(true);
    expect(joiner.status.localPlayerIndex).toBe(1);
  });

  it('routes remote input packets into rollback for the opposite player', () => {
    const { joiner } = connectSessions({ seed: 123 });
    joiner.receiveGameplayMessage(
      encodeInputPacket({
        frame: 0,
        input: InputBits.TurnLeft,
        previousInputs: [],
      }),
    );

    const result = joiner.step(InputBits.Thrust);
    const canonical = runReplay(createInitialState(123), [[InputBits.TurnLeft, InputBits.Thrust]], hashState);

    expect(result.state ? hashState(result.state) : null).toBe(hashState(canonical.finalState));
    expect(result.status.lastRemoteInputFrame).toBe(0);
  });

  it('records desyncs from typed state hash packets', () => {
    const { host } = connectSessions({ hashInterval: 1 });
    const result = host.step(0);

    host.receiveGameplayMessage(encodeStateHashPacket({ frame: 1, hash: 0xffff }));

    expect(result.status.lastLocalHashFrame).toBe(1);
    expect(host.status.desync).toEqual({
      frame: 1,
      localHash: expect.any(Number),
      remoteHash: 0xffff,
    });
  });

  it('updates packet, input, hash, age, and rollback diagnostics', () => {
    const { host, joiner } = connectSessions({ seed: 123, hashInterval: 1 });

    const hostResult = host.step(InputBits.TurnLeft);
    const hostPackets = hostResult.packets;
    for (const packet of hostPackets) {
      joiner.receiveGameplayMessage(packet);
    }

    expect(host.status.packetsSent).toBeGreaterThanOrEqual(3);
    expect(host.status.lastInputFrame).toBe(0);
    expect(host.status.lastHashFrame).toBe(1);
    expect(host.status.lastLocalHashFrame).toBe(1);
    expect(joiner.status.packetsReceived).toBeGreaterThanOrEqual(2);
    expect(joiner.status.lastRemoteInputFrame).toBe(0);
    expect(joiner.status.remoteInputAge).toBe(0);

    const rollbackPeer = connectSessions({ seed: 123 });
    rollbackPeer.joiner.step(0);
    rollbackPeer.joiner.receiveGameplayMessage(
      encodeInputPacket({
        frame: 0,
        input: InputBits.FirePrimary,
        previousInputs: [],
      }),
    );
    const rollbackResult = rollbackPeer.joiner.step(0);

    expect(rollbackResult.status.rolledBack).toBe(true);
    expect(rollbackResult.status.rollbackCount).toBe(1);
    expect(rollbackResult.status.remoteInputAge).toBe(2);
  });

  it('stays deterministic through delayed, duplicated, and out-of-order gameplay packets', () => {
    const harness = new NetworkHarness({ seed: 123, hashInterval: 4, rollbackLimit: 64 });
    const inputs: readonly FrameInputs[] = [
      [InputBits.Thrust, 0],
      [InputBits.Thrust, InputBits.TurnLeft],
      [0, InputBits.TurnLeft],
      [InputBits.TurnRight, InputBits.Thrust],
      [InputBits.TurnRight, InputBits.Thrust],
      [0, 0],
      [InputBits.TurnLeft, InputBits.TurnRight],
      [InputBits.Thrust, InputBits.Thrust],
      [0, InputBits.TurnLeft],
      [InputBits.TurnRight, 0],
      [InputBits.TurnLeft, 0],
      [0, InputBits.TurnRight],
    ];

    for (const [hostInput, joinerInput] of inputs) {
      harness.step(hostInput, joinerInput);
    }

    for (let i = 0; i < 4; i += 1) {
      harness.step(0, 0);
    }

    harness.drain();

    expect(harness.host.currentState?.frame).toBe(harness.joiner.currentState?.frame);
    expect(harness.host.currentState ? hashState(harness.host.currentState) : null).toBe(
      harness.joiner.currentState ? hashState(harness.joiner.currentState) : null,
    );
    expect(harness.host.status.protocolError).toBeNull();
    expect(harness.joiner.status.protocolError).toBeNull();
    expect(harness.host.status.lastRemoteInputFrame).toBeGreaterThanOrEqual(inputs.length - 2);
    expect(harness.joiner.status.lastRemoteInputFrame).toBeGreaterThanOrEqual(inputs.length - 2);
  });

  it('recovers a dropped input packet from the resend window', () => {
    const { host, joiner } = connectSessions({ seed: 123 });

    host.step(InputBits.Thrust);
    joiner.step(0);

    for (const packet of host.step(0).packets) {
      joiner.receiveGameplayMessage(packet);
    }

    const result = joiner.step(0);
    const canonical = runReplay(createInitialState(123), [[InputBits.Thrust, 0], [0, 0]], hashState);

    expect(result.state ? hashState(result.state) : null).toBe(hashState(canonical.finalState));
    expect(joiner.status.lastRemoteInputFrame).toBe(1);
  });

  it('records protocol and session errors for invalid or stale packets', () => {
    const joiner = new NetworkMatchSession('joiner');

    joiner.receiveGameplayMessage(new Uint8Array([99, GameplayPacketType.Input]));
    expect(joiner.status.protocolError).toContain('Unsupported gameplay protocol version');
    expect(joiner.status.packetsReceived).toBe(0);

    joiner.receiveGameplayMessage(
      encodeInputPacket({
        frame: 0,
        input: InputBits.TurnLeft,
        previousInputs: [],
      }),
    );
    expect(joiner.status.sessionError).toBe('Received input before the session was ready.');

    const connected = connectSessions({ seed: 123 });
    connected.joiner.receiveGameplayMessage(
      encodeInputPacket({
        frame: 0,
        input: InputBits.TurnLeft,
        previousInputs: [],
      }),
    );
    connected.joiner.receiveGameplayMessage(
      encodeInputPacket({
        frame: 0,
        input: InputBits.TurnLeft,
        previousInputs: [],
      }),
    );
    expect(connected.joiner.status.sessionError).toBe('Ignored stale input packet.');

    connected.host.receiveGameplayMessage(
      encodeSessionConfigPacket({
        seed: 123,
        startFrame: 0,
        hostPlayerIndex: 0,
        joinerPlayerIndex: 1,
      }),
    );
    expect(connected.host.status.sessionError).toBe('Host received an unexpected session config packet.');
  });
});

function connectSessions(options: { readonly seed?: number; readonly hashInterval?: number; readonly rollbackLimit?: number } = {}): {
  readonly host: NetworkMatchSession;
  readonly joiner: NetworkMatchSession;
} {
  const host = new NetworkMatchSession('host', options);
  const joiner = new NetworkMatchSession('joiner', options);

  for (const packet of host.takeOutgoingPackets()) {
    joiner.receiveGameplayMessage(packet);
  }

  for (const packet of joiner.takeOutgoingPackets()) {
    host.receiveGameplayMessage(packet);
  }

  for (const packet of host.takeOutgoingPackets()) {
    joiner.receiveGameplayMessage(packet);
  }

  return { host, joiner };
}

type QueuedPeer = 'host' | 'joiner';

interface QueuedPacket {
  readonly to: QueuedPeer;
  readonly packet: Uint8Array;
  readonly deliverAt: number;
  readonly sequence: number;
}

class NetworkHarness {
  public readonly host: NetworkMatchSession;
  public readonly joiner: NetworkMatchSession;
  private readonly queue: QueuedPacket[] = [];
  private sequence = 0;
  private tick = 0;

  public constructor(options: { readonly seed?: number; readonly hashInterval?: number; readonly rollbackLimit?: number } = {}) {
    const sessions = connectSessions(options);
    this.host = sessions.host;
    this.joiner = sessions.joiner;
  }

  public step(hostInput: number, joinerInput: number): void {
    this.deliverDue();
    this.enqueue('joiner', this.host.step(hostInput).packets);
    this.enqueue('host', this.joiner.step(joinerInput).packets);
    this.deliverDue();
    this.tick += 1;
  }

  public drain(): void {
    while (this.queue.length > 0) {
      this.deliverDue();
      this.tick += 1;
    }
  }

  private enqueue(to: QueuedPeer, packets: readonly Uint8Array[]): void {
    for (const packet of packets) {
      const packetNumber = this.sequence;
      this.sequence += 1;

      if (this.shouldDrop(packetNumber)) {
        continue;
      }

      const deliverAt = this.tick + this.delayFor(packetNumber);
      this.queue.push({ to, packet, deliverAt, sequence: packetNumber });

      if (this.shouldDuplicate(packetNumber)) {
        this.queue.push({ to, packet, deliverAt: deliverAt + 1, sequence: this.sequence });
        this.sequence += 1;
      }
    }
  }

  private deliverDue(): void {
    const due = this.queue
      .filter((packet) => packet.deliverAt <= this.tick)
      .sort((left, right) => right.sequence - left.sequence);
    this.queue.splice(0, this.queue.length, ...this.queue.filter((packet) => packet.deliverAt > this.tick));

    for (const packet of due) {
      if (packet.to === 'host') {
        this.host.receiveGameplayMessage(packet.packet);
      } else {
        this.joiner.receiveGameplayMessage(packet.packet);
      }
    }
  }

  private delayFor(packetNumber: number): number {
    return [1, 0, 1, 0, 1][packetNumber % 5];
  }

  private shouldDrop(packetNumber: number): boolean {
    return packetNumber === -1;
  }

  private shouldDuplicate(packetNumber: number): boolean {
    return packetNumber % 6 === 2;
  }
}
