import { describe, expect, it } from 'vitest';

import { InputBits, type ProjectileState } from '../sim/types';
import type { ShipId } from '../sim/shipSpecs';
import { fixed, fixedFromInt } from '../sim/fixed';
import { angle } from '../sim/trig';
import {
  decodeGameplayPacket,
  encodeDefenderHitPacket,
  encodeInputPacket,
  encodeOwnerWeaponEventPacket,
  encodeProjectileSpawnPacket,
  encodeRecoveryAckPacket,
  encodeSessionConfigPacket,
  encodeStateHashPacket,
  GameplayPacketType,
} from './protocol';
import { NetworkMatchSession } from './matchSession';

describe('network match session', () => {
  it('has the host emit session config for the joiner', () => {
    const host = new NetworkMatchSession('host', { seed: 123 });
    const packets = host.takeOutgoingPackets();

    expect(packets).toHaveLength(1);
    expect(decodeGameplayPacket(packets[0])).toEqual({
      type: GameplayPacketType.SessionConfig,
      roundId: 0,
      seed: 123,
      loadout: ['frog', 'cannonade'],
      aiDemo: false,
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
    expect(packets).not.toContain(GameplayPacketType.OwnerState);
  });

  it('uses session ready and ack packets before either peer is ready', () => {
    const host = new NetworkMatchSession('host', { seed: 123 });
    const joiner = new NetworkMatchSession('joiner');
    const configPackets = host.takeOutgoingPackets();

    for (const packet of configPackets) {
      joiner.receiveGameplayMessage(packet);
    }

    const readyPackets = joiner.takeOutgoingPackets();
    expect(readyPackets.map((packet) => decodeGameplayPacket(packet).type)).toEqual([GameplayPacketType.SessionReady]);

    for (const packet of readyPackets) {
      host.receiveGameplayMessage(packet);
    }

    const ackPackets = host.takeOutgoingPackets();
    expect(host.ready).toBe(true);
    expect(ackPackets.map((packet) => decodeGameplayPacket(packet).type)).toEqual([GameplayPacketType.SessionReadyAck]);

    for (const packet of ackPackets) {
      joiner.receiveGameplayMessage(packet);
    }

    expect(joiner.ready).toBe(true);
    expect(joiner.status.localPlayerIndex).toBe(1);
  });

  it('starts both peers with the loadout from session config', () => {
    const host = new NetworkMatchSession('host', { seed: 123, loadout: ['krab', 'pscout'], aiDemo: true });
    const joiner = new NetworkMatchSession('joiner');
    deliverPackets(joiner, host.takeOutgoingPackets());

    expect(joiner.status.aiDemo).toBe(true);
    expect(host.currentState?.ships.map((ship) => ship.shipId)).toEqual(['krab', 'pscout']);
    expect(joiner.currentState?.ships.map((ship) => ship.shipId)).toEqual(['krab', 'pscout']);
  });

  it('lets the host start a new configured round over an existing joiner session', () => {
    const { joiner } = connectSessions({ seed: 123 });
    const nextHost = new NetworkMatchSession('host', { roundId: 1, seed: 456, loadout: ['gooj', 'kron'] });

    deliverPackets(joiner, nextHost.takeOutgoingPackets());

    expect(joiner.ready).toBe(false);
    expect(joiner.currentState?.frame).toBe(0);
    expect(joiner.currentState?.ships.map((ship) => ship.shipId)).toEqual(['gooj', 'kron']);
    expect(joiner.takeOutgoingPackets().map((packet) => decodeGameplayPacket(packet).type)).toEqual([GameplayPacketType.SessionReady]);
  });

  it('ignores stale owner state from an older round', () => {
    const { joiner } = connectSessions({ seed: 123, loadout: ['frog', 'cannonade'] });
    const staleOwnerState = joiner.step(0).packets.find((packet) => decodeGameplayPacket(packet).type === GameplayPacketType.OwnerState);
    expect(staleOwnerState).toBeDefined();
    if (!staleOwnerState) {
      return;
    }

    const nextHost = new NetworkMatchSession('host', { roundId: 1, seed: 456, loadout: ['zizlik', 'frog'], readyImmediately: true });
    expect(nextHost.currentState?.ships.map((ship) => ship.shipId)).toEqual(['zizlik', 'frog']);

    nextHost.receiveGameplayMessage(staleOwnerState);
    expect(nextHost.currentState?.ships.map((ship) => ship.shipId)).toEqual(['zizlik', 'frog']);
  });

  it('steps local input immediately and emits owner facts instead of input packets', () => {
    const { host } = connectSessions({ seed: 123 });
    const result = host.step(InputBits.FirePrimary);
    const packetTypes = result.packets.map((packet) => decodeGameplayPacket(packet).type);

    expect(result.state?.ships[0].custom.frogCharge).toBe(1);
    expect(result.status.frame).toBe(1);
    expect(packetTypes).toContain(GameplayPacketType.OwnerState);
    expect(packetTypes).toContain(GameplayPacketType.OwnerWeaponEvent);
    expect(packetTypes).not.toContain(GameplayPacketType.Input);
    expect(packetTypes).not.toContain(GameplayPacketType.StateHash);
    expect(packetTypes).not.toContain(GameplayPacketType.StateCheckpoint);
  });

  it('applies remote owner state fast-forwarded to the local frame', () => {
    const { host, joiner } = connectSessions({ seed: 123 });
    joiner.step(0);
    joiner.step(0);
    const hostResult = host.step(InputBits.Thrust);
    const ownerStatePacket = hostResult.packets.find((packet) => decodeGameplayPacket(packet).type === GameplayPacketType.OwnerState);

    expect(ownerStatePacket).toBeDefined();
    if (!ownerStatePacket) {
      return;
    }

    joiner.receiveGameplayMessage(ownerStatePacket);

    expect(joiner.status.lastOwnerStateFrame).toBe(1);
    expect(joiner.currentState?.ships[0].x).not.toBe(host.currentState?.ships[0].x);
    expect(joiner.currentState?.ships[0].vx).toBe(host.currentState?.ships[0].vx);
  });

  it('spawns thrust dust for the remote owner once they report thrust intent', () => {
    const { host, joiner } = connectSessions({ seed: 123 });

    // Host thrusts and broadcasts an owner state packet that carries the thrust intent.
    const hostResult = host.step(InputBits.Thrust);
    const ownerStatePacket = hostResult.packets.find((packet) => decodeGameplayPacket(packet).type === GameplayPacketType.OwnerState);
    expect(ownerStatePacket).toBeDefined();
    if (!ownerStatePacket) {
      return;
    }
    const decoded = decodeGameplayPacket(ownerStatePacket);
    if (decoded.type !== GameplayPacketType.OwnerState) {
      throw new Error('expected an owner state packet');
    }
    expect(decoded.thrusting).toBe(true);

    joiner.receiveGameplayMessage(ownerStatePacket);

    // Joiner steps with no local input; dust should still spawn for the remote ship.
    let joinerState = joiner.step(0).state;
    let remoteDust = joinerState?.effects.filter((effect) => effect.kind === 'thrustDust' && effect.ownerId === 0) ?? [];
    // Step a few times so we cross at least one spawn interval.
    for (let frame = 0; frame < 6 && remoteDust.length === 0; frame += 1) {
      joinerState = joiner.step(0).state;
      remoteDust = joinerState?.effects.filter((effect) => effect.kind === 'thrustDust' && effect.ownerId === 0) ?? [];
    }
    expect(remoteDust.length).toBeGreaterThan(0);

    // Once the host releases thrust the remote dust should stop being spawned.
    const releasedPacket = host.step(0).packets.find((packet) => decodeGameplayPacket(packet).type === GameplayPacketType.OwnerState);
    expect(releasedPacket).toBeDefined();
    if (!releasedPacket) {
      return;
    }
    const releasedDecoded = decodeGameplayPacket(releasedPacket);
    if (releasedDecoded.type !== GameplayPacketType.OwnerState) {
      throw new Error('expected an owner state packet');
    }
    expect(releasedDecoded.thrusting).toBe(false);
    joiner.receiveGameplayMessage(releasedPacket);
  });

  it('applies remote projectile spawns idempotently and fast-forwards them', () => {
    const { host, joiner } = connectSessions({ seed: 123 });
    host.step(0);
    host.step(0);
    const joinerResult = joiner.step(InputBits.FirePrimary);
    const spawnPacket = joinerResult.packets.find((packet) => decodeGameplayPacket(packet).type === GameplayPacketType.ProjectileSpawn);

    expect(spawnPacket).toBeDefined();
    if (!spawnPacket) {
      return;
    }

    host.receiveGameplayMessage(spawnPacket);
    host.receiveGameplayMessage(spawnPacket);

    const spawned = host.currentState?.projectiles.filter((projectile) => projectile.ownerId === 1) ?? [];
    const original = decodeGameplayPacket(spawnPacket);
    expect(original.type).toBe(GameplayPacketType.ProjectileSpawn);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.id % 2).toBe(0);
    expect(spawned[0]?.ttl).toBeLessThan(original.type === GameplayPacketType.ProjectileSpawn ? original.projectile.ttl : 999);
  });

  it('sends Frog charge start/update events and release before projectile spawn', () => {
    const { host, joiner } = connectSessions({ seed: 123 });
    const charging = host.step(InputBits.FirePrimary).packets.map((packet) => decodeGameplayPacket(packet));
    const chargeEvent = charging.find((packet) => packet.type === GameplayPacketType.OwnerWeaponEvent);

    expect(chargeEvent).toMatchObject({
      type: GameplayPacketType.OwnerWeaponEvent,
      ownerId: 0,
      weapon: 'primary',
      effectKind: 'frogChargeStart',
      strength: 1,
    });

    const releasePackets = host.step(0).packets;
    const releaseEvents = releasePackets.map((packet) => decodeGameplayPacket(packet));
    expect(releaseEvents).toContainEqual(expect.objectContaining({ type: GameplayPacketType.OwnerWeaponEvent, effectKind: 'frogChargeRelease' }));
    expect(releaseEvents).toContainEqual(expect.objectContaining({ type: GameplayPacketType.ProjectileSpawn }));

    for (const packet of charging) {
      if (packet.type === GameplayPacketType.OwnerWeaponEvent) {
        joiner.receiveGameplayMessage(encodeOwnerWeaponEventPacket(packet));
      }
    }

    expect(joiner.currentState?.ships[0].custom.frogCharge).toBe(1);
  });

  it('applies defender hit events idempotently', () => {
    const { host, joiner } = connectSessions({ seed: 123 });
    const projectile = buildProjectile({ id: 2, ownerId: 1 });
    host.receiveGameplayMessage(encodeProjectileSpawnPacket({ roundId: 0, frame: 0, projectile }));
    const hitPacket = encodeDefenderHitPacket({
      roundId: 0,
      hitId: `0:${projectile.id}`,
      frame: host.currentState?.frame ?? 0,
      defenderId: 0,
      attackerId: 1,
      projectileId: projectile.id,
      damage: 2,
      crew: 8,
      alive: true,
    });

    joiner.receiveGameplayMessage(hitPacket);
    joiner.receiveGameplayMessage(hitPacket);

    expect(joiner.currentState?.ships[0].crew).toBe(8);
    expect(joiner.currentState?.ships[0].alive).toBe(true);
    expect(joiner.currentState?.projectiles.some((candidate) => candidate.id === projectile.id)).toBe(false);
  });

  it('lets the defender apply and confirm remote Kron beam hits', () => {
    const { host, joiner } = connectSessions({ seed: 123, loadout: ['kron', 'frog'] });
    const defender = joiner.currentState?.ships[1];
    expect(defender).toBeDefined();
    if (!defender) {
      return;
    }

    joiner.receiveGameplayMessage(
      encodeOwnerWeaponEventPacket({
        roundId: 0,
        eventId: '0:1:primary:kronBeam',
        frame: joiner.currentState?.frame ?? 0,
        ownerId: 0,
        weapon: 'primary',
        effectKind: 'kronBeam',
        x: fixedFromInt(-450),
        y: defender.y,
        vx: fixed(0),
        vy: fixed(0),
        angle: angle(0),
        durationFrames: 10,
        strength: 1,
      }),
    );

    expect(joiner.currentState?.ships[1].crew).toBe(defender.crew - 1);
    const hitPacket = joiner.takeOutgoingPackets().find((packet) => decodeGameplayPacket(packet).type === GameplayPacketType.DefenderHit);
    expect(hitPacket).toBeDefined();
    if (!hitPacket) {
      return;
    }

    host.receiveGameplayMessage(hitPacket);
    expect(host.currentState?.ships[1].crew).toBe(defender.crew - 1);
  });

  it('spawns Zizlik clone actors on the joiner when the host fires its secondary', () => {
    const { joiner } = connectSessions({ seed: 123, loadout: ['zizlik', 'frog'] });
    const ship = joiner.currentState?.ships[0];
    expect(ship).toBeDefined();
    if (!ship) {
      return;
    }

    const baseEvent = {
      roundId: 0,
      frame: joiner.currentState?.frame ?? 0,
      ownerId: 0 as const,
      weapon: 'secondary' as const,
      effectKind: 'zizlikNode' as const,
      x: ship.x,
      y: ship.y,
      vx: ship.vx,
      vy: ship.vy,
      angle: ship.angle,
    };

    joiner.receiveGameplayMessage(encodeOwnerWeaponEventPacket({ ...baseEvent, eventId: '0:1:secondary:zizlikNode' }));
    joiner.receiveGameplayMessage(encodeOwnerWeaponEventPacket({ ...baseEvent, eventId: '0:2:secondary:zizlikNode' }));

    const remoteNodes = joiner.currentState?.actors.filter((actor) => actor.kind === 'zizlikNode' && actor.ownerId === 0) ?? [];
    expect(remoteNodes).toHaveLength(2);
    expect(new Set(remoteNodes.map((actor) => actor.slot))).toEqual(new Set([1, -1]));

    // A third event with both slots already occupied should be a no-op.
    joiner.receiveGameplayMessage(encodeOwnerWeaponEventPacket({ ...baseEvent, eventId: '0:3:secondary:zizlikNode' }));
    expect(joiner.currentState?.actors.filter((actor) => actor.kind === 'zizlikNode' && actor.ownerId === 0)).toHaveLength(2);

    // Re-delivering the same events must not duplicate the clones (eventId dedup).
    joiner.receiveGameplayMessage(encodeOwnerWeaponEventPacket({ ...baseEvent, eventId: '0:1:secondary:zizlikNode' }));
    expect(joiner.currentState?.actors.filter((actor) => actor.kind === 'zizlikNode' && actor.ownerId === 0)).toHaveLength(2);
  });

  it('records protocol and session errors for obsolete or invalid packets', () => {
    const joiner = new NetworkMatchSession('joiner');

    joiner.receiveGameplayMessage(new Uint8Array([99, GameplayPacketType.Input]));
    expect(joiner.status.protocolError).toContain('Unsupported gameplay protocol version');
    expect(joiner.status.packetsReceived).toBe(0);

    const connected = connectSessions({ seed: 123 });
    connected.joiner.receiveGameplayMessage(
      encodeInputPacket({
        frame: 0,
        input: InputBits.TurnLeft,
        previousInputs: [],
      }),
    );
    expect(connected.joiner.status.sessionError).toBe('Received obsolete input packet.');

    connected.host.receiveGameplayMessage(encodeStateHashPacket({ frame: 1, hash: 0xffff }));
    expect(connected.host.status.sessionError).toBe('Received obsolete state hash packet.');

    connected.host.receiveGameplayMessage(
      encodeSessionConfigPacket({
        roundId: 0,
        seed: 123,
        loadout: ['frog', 'cannonade'],
        aiDemo: false,
        startFrame: 0,
        hostPlayerIndex: 0,
        joinerPlayerIndex: 1,
      }),
    );
    expect(connected.host.status.sessionError).toBe('Host received an unexpected session config packet.');
  });

  it('pauses stepping and emits recovery packets when remote owner updates go stale', () => {
    const { host, joiner } = connectSessions({ seed: 123 });
    deliverPackets(joiner, host.step(0).packets);
    deliverPackets(host, joiner.step(0).packets);

    let result = host.step(InputBits.Thrust);
    for (let frame = 0; frame < 32 && !result.status.paused; frame += 1) {
      result = host.step(InputBits.Thrust);
    }

    const packetTypes = result.packets.map((packet) => decodeGameplayPacket(packet).type);
    const pausedFrame = result.state?.frame;
    const pausedAgain = host.step(InputBits.Thrust);

    expect(result.status.paused).toBe(true);
    expect(result.status.remoteOwnerAgeFrames).toBeGreaterThan(30);
    expect(packetTypes).toContain(GameplayPacketType.RecoveryRequest);
    expect(packetTypes).toContain(GameplayPacketType.RecoverySnapshot);
    expect(packetTypes).not.toContain(GameplayPacketType.OwnerState);
    expect(pausedAgain.state?.frame).toBe(pausedFrame);
  });

  it('reconciles snapshots by owner and resumes automatically after both peers ack', () => {
    const { host, joiner } = connectSessions({ seed: 123 });
    deliverPackets(joiner, host.step(InputBits.Thrust).packets);
    deliverPackets(host, joiner.step(InputBits.TurnLeft).packets);

    let recoveryPackets: readonly Uint8Array[] = [];
    for (let frame = 0; frame < 34 && recoveryPackets.length === 0; frame += 1) {
      const result = host.step(InputBits.Thrust);
      if (result.status.paused) {
        recoveryPackets = result.packets;
      }
    }

    const hostShipX = host.currentState?.ships[0].x;
    const joinerShipX = joiner.currentState?.ships[1].x;
    deliverPackets(joiner, recoveryPackets);
    expect(joiner.status.paused).toBe(true);

    const joinerRecoveryPackets = joiner.takeOutgoingPackets();
    deliverPackets(host, joinerRecoveryPackets);
    expect(host.status.paused).toBe(false);
    expect(host.currentState?.ships[0].x).toBe(hostShipX);
    expect(host.currentState?.ships[1].x).toBe(joinerShipX);

    deliverPackets(joiner, host.takeOutgoingPackets());
    expect(joiner.status.paused).toBe(false);
  });

  it('keeps waiting for the current recovery ack before resuming', () => {
    const { host, joiner } = connectSessions({ seed: 123 });
    deliverPackets(joiner, host.step(0).packets);
    deliverPackets(host, joiner.step(0).packets);

    let recoveryPackets: readonly Uint8Array[] = [];
    for (let frame = 0; frame < 34 && recoveryPackets.length === 0; frame += 1) {
      const result = host.step(0);
      if (result.status.paused) {
        recoveryPackets = result.packets;
      }
    }

    deliverPackets(joiner, recoveryPackets);
    const snapshotOnly = joiner.takeOutgoingPackets().filter((packet) => decodeGameplayPacket(packet).type === GameplayPacketType.RecoverySnapshot);
    deliverPackets(host, snapshotOnly);
    expect(host.status.paused).toBe(true);

    host.receiveGameplayMessage(encodeRecoveryAckPacket({ roundId: 0, recoveryId: 999, frame: host.currentState?.frame ?? 0, senderId: 1 }));
    expect(host.status.paused).toBe(true);
  });

  it('keeps sending snapshots while reconciling so a peer can recover after a dropped snapshot', () => {
    const { host, joiner } = connectSessions({ seed: 123 });
    deliverPackets(joiner, host.step(0).packets);
    deliverPackets(host, joiner.step(0).packets);

    let recoveryPackets: readonly Uint8Array[] = [];
    for (let frame = 0; frame < 34 && recoveryPackets.length === 0; frame += 1) {
      const result = host.step(0);
      if (result.status.paused) {
        recoveryPackets = result.packets;
      }
    }

    const requestOnly = recoveryPackets.filter((packet) => decodeGameplayPacket(packet).type === GameplayPacketType.RecoveryRequest);
    deliverPackets(joiner, requestOnly);
    deliverPackets(host, joiner.takeOutgoingPackets());
    expect(host.status.recoveryWaitingForPeer).toBe(true);

    const hostRecoveryRetry = host.step(0).packets;
    const hostRecoveryRetryTypes = hostRecoveryRetry.map((packet) => decodeGameplayPacket(packet).type);
    expect(hostRecoveryRetryTypes).toContain(GameplayPacketType.RecoverySnapshot);
    expect(hostRecoveryRetryTypes).toContain(GameplayPacketType.RecoveryAck);

    deliverPackets(joiner, hostRecoveryRetry);
    expect(joiner.status.paused).toBe(false);
    deliverPackets(host, joiner.takeOutgoingPackets());
    expect(host.status.paused).toBe(false);

    deliverPackets(joiner, recoveryPackets);
    expect(joiner.status.paused).toBe(false);
  });

  it('stays packet-error-free through delayed duplicated owner facts', () => {
    const harness = new NetworkHarness({ seed: 123 });
    const inputs = [
      [InputBits.Thrust, 0],
      [InputBits.FirePrimary, InputBits.TurnLeft],
      [0, InputBits.FirePrimary],
      [InputBits.TurnRight, InputBits.Thrust],
      [0, 0],
    ] as const;

    for (const [hostInput, joinerInput] of inputs) {
      harness.step(hostInput, joinerInput);
    }
    harness.drain();

    expect(harness.host.status.protocolError).toBeNull();
    expect(harness.joiner.status.protocolError).toBeNull();
    expect(harness.host.status.lastOwnerStateFrame).not.toBeNull();
    expect(harness.joiner.status.lastOwnerStateFrame).not.toBeNull();
  });
});

function connectSessions(options: { readonly seed?: number; readonly loadout?: readonly [ShipId, ShipId] } = {}): {
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

function deliverPackets(target: NetworkMatchSession, packets: readonly Uint8Array[]): void {
  for (const packet of packets) {
    target.receiveGameplayMessage(packet);
  }
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

  public constructor(options: { readonly seed?: number; readonly loadout?: readonly [ShipId, ShipId] } = {}) {
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
      const deliverAt = this.tick + [1, 0, 1, 0, 1][packetNumber % 5];
      this.queue.push({ to, packet, deliverAt, sequence: packetNumber });
      if (packetNumber % 6 === 2) {
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
}

function buildProjectile(overrides: Partial<ProjectileState> = {}): ProjectileState {
  return {
    id: 1,
    ownerId: 0,
    kind: 'frogBubble',
    x: fixedFromInt(1000),
    y: fixedFromInt(1000),
    vx: fixed(0),
    vy: fixed(0),
    angle: angle(0),
    ttl: 50,
    damage: 1,
    radius: fixedFromInt(20),
    rotation: fixed(0),
    trackPct: fixed(0),
    variety: 0,
    active: true,
    ...overrides,
  };
}

