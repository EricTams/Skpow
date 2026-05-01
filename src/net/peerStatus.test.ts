import { describe, expect, it } from 'vitest';

import type { NetworkMatchStatus } from './matchSession';
import { formatPeerStatus } from './peerStatus';

describe('peer status formatting', () => {
  it('shows closed and failed peer state when no match diagnostics are available', () => {
    expect(formatPeerStatus('closed', null)).toBe('Peer state: closed');
    expect(formatPeerStatus('failed', null)).toBe('Peer state: failed');
  });

  it('shows readiness and networking diagnostics clearly', () => {
    expect(formatPeerStatus('connected', buildStatus())).toBe(
      [
        'Peer state: connected',
        'host player 1',
        'waiting for joiner ready',
        'packets sent/received: 4/3',
        'last input frame: 12',
        'last remote input: 10',
        'remote input age: 2',
        'last hash frame: 60',
        'rollback count: 1',
        'rollback replayed',
        'hash ok local:60 remote:none',
        'protocol error: bad version',
        'session error: stale input',
      ].join(' | '),
    );
  });
});

function buildStatus(): NetworkMatchStatus {
  return {
    role: 'host',
    ready: false,
    localPlayerIndex: 0,
    frame: 12,
    lastRemoteInputFrame: 10,
    lastLocalHashFrame: 60,
    lastRemoteHashFrame: null,
    lastInputFrame: 12,
    remoteInputAge: 2,
    lastHashFrame: 60,
    rolledBack: true,
    rollbackCount: 1,
    packetsSent: 4,
    packetsReceived: 3,
    protocolError: 'bad version',
    sessionError: 'stale input',
    desync: null,
  };
}
