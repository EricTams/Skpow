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
        'last owner state: 10',
        'last projectile spawn: 11',
        'last weapon event: 12',
        'last defender hit: 13',
        'remote owner age: 2',
        'recovery paused: 7 (remote owner updates stale)',
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
    aiDemo: false,
    frame: 12,
    lastOwnerStateFrame: 10,
    lastProjectileSpawnFrame: 11,
    lastWeaponEventFrame: 12,
    lastDefenderHitFrame: 13,
    paused: true,
    recoveryId: 7,
    recoveryReason: 'remote owner updates stale',
    recoveryWaitingForPeer: false,
    lastRemoteOwnerFrame: 10,
    remoteOwnerAgeFrames: 2,
    packetsSent: 4,
    packetsReceived: 3,
    protocolError: 'bad version',
    sessionError: 'stale input',
  };
}
