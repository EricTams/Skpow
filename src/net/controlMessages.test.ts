import { describe, expect, it } from 'vitest';

import { decodeNetworkControlMessage, encodeNetworkControlMessage } from './controlMessages';

describe('network control messages', () => {
  it('round-trips fleet ready messages', () => {
    const message = {
      type: 'fleetReady' as const,
      sideId: 1 as const,
      fleet: [{ uid: 'p2-1', catalogId: 'frog' as const, alive: true }],
    };

    expect(decodeNetworkControlMessage(encodeNetworkControlMessage(message))).toEqual(message);
  });

  it('round-trips ship pick messages', () => {
    const message = { type: 'shipPicked' as const, sideId: 0 as const, uid: 'p1-1' };

    expect(decodeNetworkControlMessage(encodeNetworkControlMessage(message))).toEqual(message);
  });

  it('round-trips round resolution messages', () => {
    const winnerMessage = { type: 'roundResolved' as const, outcome: { kind: 'winner' as const, winnerId: 1 as const } };
    const drawMessage = { type: 'roundResolved' as const, outcome: { kind: 'draw' as const } };

    expect(decodeNetworkControlMessage(encodeNetworkControlMessage(winnerMessage))).toEqual(winnerMessage);
    expect(decodeNetworkControlMessage(encodeNetworkControlMessage(drawMessage))).toEqual(drawMessage);
  });

  it('rejects malformed messages', () => {
    expect(decodeNetworkControlMessage('not json')).toBeNull();
    expect(decodeNetworkControlMessage(JSON.stringify({ type: 'shipPicked', sideId: 2, uid: 'x' }))).toBeNull();
    expect(decodeNetworkControlMessage(JSON.stringify({ type: 'fleetReady', sideId: 0, fleet: [{ uid: 'x', catalogId: 'bad', alive: true }] }))).toBeNull();
    expect(decodeNetworkControlMessage(JSON.stringify({ type: 'roundResolved', outcome: { kind: 'winner', winnerId: 2 } }))).toBeNull();
  });
});
