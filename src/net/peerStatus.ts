import type { NetworkMatchStatus } from './matchSession';
import type { ConnectionState } from './webrtc';

export function formatPeerStatus(peerConnectionState: ConnectionState, networkMatchStatus: NetworkMatchStatus | null): string {
  if (!networkMatchStatus) {
    return `Peer state: ${peerConnectionState}`;
  }

  const player = networkMatchStatus.localPlayerIndex + 1;
  const remoteFrame = networkMatchStatus.lastRemoteInputFrame ?? 'none';
  const localHash = networkMatchStatus.lastLocalHashFrame ?? 'none';
  const remoteHash = networkMatchStatus.lastRemoteHashFrame ?? 'none';
  const lastInput = networkMatchStatus.lastInputFrame ?? 'none';
  const remoteInputAge = networkMatchStatus.remoteInputAge ?? 'n/a';
  const lastHash = networkMatchStatus.lastHashFrame ?? 'none';
  const readyStatus = networkMatchStatus.ready ? 'ready' : waitingStatus(networkMatchStatus.role);
  const rollbackStatus = networkMatchStatus.rolledBack ? 'rollback replayed' : 'no rollback';
  const syncStatus = networkMatchStatus.desync
    ? `desync at frame ${networkMatchStatus.desync.frame}`
    : `hash ok local:${localHash} remote:${remoteHash}`;
  const protocolStatus = networkMatchStatus.protocolError
    ? `protocol error: ${networkMatchStatus.protocolError}`
    : 'protocol ok';
  const sessionStatus = networkMatchStatus.sessionError ? `session error: ${networkMatchStatus.sessionError}` : 'session ok';

  return [
    `Peer state: ${peerConnectionState}`,
    `${networkMatchStatus.role} player ${player}`,
    readyStatus,
    `packets sent/received: ${networkMatchStatus.packetsSent}/${networkMatchStatus.packetsReceived}`,
    `last input frame: ${lastInput}`,
    `last remote input: ${remoteFrame}`,
    `remote input age: ${remoteInputAge}`,
    `last hash frame: ${lastHash}`,
    `rollback count: ${networkMatchStatus.rollbackCount}`,
    rollbackStatus,
    syncStatus,
    protocolStatus,
    sessionStatus,
  ].join(' | ');
}

function waitingStatus(role: NetworkMatchStatus['role']): string {
  return role === 'host' ? 'waiting for joiner ready' : 'waiting for host ack';
}
