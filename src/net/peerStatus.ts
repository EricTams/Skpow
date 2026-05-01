import type { NetworkMatchStatus } from './matchSession';
import type { ConnectionState } from './webrtc';

export function formatPeerStatus(peerConnectionState: ConnectionState, networkMatchStatus: NetworkMatchStatus | null): string {
  if (!networkMatchStatus) {
    return `Peer state: ${peerConnectionState}`;
  }

  const player = networkMatchStatus.localPlayerIndex + 1;
  const ownerStateFrame = networkMatchStatus.lastOwnerStateFrame ?? 'none';
  const projectileFrame = networkMatchStatus.lastProjectileSpawnFrame ?? 'none';
  const weaponFrame = networkMatchStatus.lastWeaponEventFrame ?? 'none';
  const hitFrame = networkMatchStatus.lastDefenderHitFrame ?? 'none';
  const recoveryStatus = networkMatchStatus.paused
    ? `recovery paused: ${networkMatchStatus.recoveryId ?? 'none'} (${formatRecoveryWait(networkMatchStatus)})`
    : 'recovery running';
  const remoteOwnerAge = networkMatchStatus.remoteOwnerAgeFrames ?? 'unknown';
  const readyStatus = networkMatchStatus.ready ? 'ready' : waitingStatus(networkMatchStatus.role);
  const protocolStatus = networkMatchStatus.protocolError
    ? `protocol error: ${networkMatchStatus.protocolError}`
    : 'protocol ok';
  const sessionStatus = networkMatchStatus.sessionError ? `session error: ${networkMatchStatus.sessionError}` : 'session ok';

  return [
    `Peer state: ${peerConnectionState}`,
    `${networkMatchStatus.role} player ${player}`,
    readyStatus,
    `packets sent/received: ${networkMatchStatus.packetsSent}/${networkMatchStatus.packetsReceived}`,
    `last owner state: ${ownerStateFrame}`,
    `last projectile spawn: ${projectileFrame}`,
    `last weapon event: ${weaponFrame}`,
    `last defender hit: ${hitFrame}`,
    `remote owner age: ${remoteOwnerAge}`,
    recoveryStatus,
    protocolStatus,
    sessionStatus,
  ].join(' | ');
}

function waitingStatus(role: NetworkMatchStatus['role']): string {
  return role === 'host' ? 'waiting for joiner ready' : 'waiting for host ack';
}

function formatRecoveryWait(status: NetworkMatchStatus): string {
  if (status.recoveryWaitingForPeer) {
    return 'waiting for peer resync';
  }
  return status.recoveryReason ?? 'unknown';
}
