import {
  off,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  update,
  type DataSnapshot,
  type Database,
} from 'firebase/database';

export interface LobbySettings {
  readonly pointTotal: number;
  readonly draftMode: 'open';
}

export interface LobbyRecord {
  readonly id: string;
  readonly hostUid: string;
  readonly settings: LobbySettings;
  readonly createdAt: number | object;
  readonly expiresAt: number;
  readonly status: 'open' | 'connecting';
  readonly joinerUid?: string;
  readonly offer?: RTCSessionDescriptionInit;
  readonly answer?: RTCSessionDescriptionInit;
}

export interface CandidateRecord {
  readonly candidate: RTCIceCandidateInit;
  readonly createdAt: number | object;
}

export class LobbyRepository {
  public constructor(private readonly database: Database) {}

  public async createLobby(hostUid: string, settings: LobbySettings): Promise<string> {
    const lobbyRef = push(ref(this.database, 'lobbies'));
    if (!lobbyRef.key) {
      throw new Error('Could not allocate lobby id.');
    }

    const lobby: Omit<LobbyRecord, 'id'> = {
      hostUid,
      settings,
      createdAt: serverTimestamp(),
      expiresAt: Date.now() + 5 * 60_000,
      status: 'open',
    };

    await set(lobbyRef, lobby);
    await onDisconnect(lobbyRef).remove();
    return lobbyRef.key;
  }

  public observeOpenLobbies(onChange: (lobbies: readonly LobbyRecord[]) => void): () => void {
    const lobbiesRef = ref(this.database, 'lobbies');
    const handler = (snapshot: DataSnapshot) => {
      const value = snapshot.val() as Record<string, Omit<LobbyRecord, 'id'>> | null;
      const lobbies = Object.entries(value ?? {})
        .map(([id, lobby]) => ({ id, ...lobby }))
        .filter((lobby) => lobby.status === 'open' && lobby.expiresAt > Date.now());
      onChange(lobbies);
    };

    onValue(lobbiesRef, handler);
    return () => off(lobbiesRef, 'value', handler);
  }

  public async deleteLobby(lobbyId: string): Promise<void> {
    await remove(ref(this.database, `lobbies/${lobbyId}`));
  }

  public async claimLobby(lobbyId: string, joinerUid: string): Promise<boolean> {
    const lobbyRef = ref(this.database, `lobbies/${lobbyId}`);
    const result = await runTransaction(lobbyRef, (currentLobby: Omit<LobbyRecord, 'id'> | null) => {
      if (
        currentLobby &&
        currentLobby.status === 'open' &&
        currentLobby.expiresAt > Date.now() &&
        !currentLobby.joinerUid
      ) {
        return {
          ...currentLobby,
          joinerUid,
          status: 'connecting',
        };
      }

      return undefined;
    });

    const claimedLobby = result.snapshot.val() as Omit<LobbyRecord, 'id'> | null;
    if (!result.committed || claimedLobby?.joinerUid !== joinerUid) {
      return false;
    }

    return true;
  }

  public async setOffer(lobbyId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    await update(ref(this.database, `lobbies/${lobbyId}`), {
      offer,
    });
  }

  public async setAnswer(lobbyId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    await set(ref(this.database, `lobbies/${lobbyId}/answer`), answer);
  }

  public observeLobby(lobbyId: string, onChange: (lobby: LobbyRecord | null) => void): () => void {
    const lobbyRef = ref(this.database, `lobbies/${lobbyId}`);
    const handler = (snapshot: DataSnapshot) => {
      const value = snapshot.val() as Omit<LobbyRecord, 'id'> | null;
      onChange(value ? { id: lobbyId, ...value } : null);
    };

    onValue(lobbyRef, handler);
    return () => off(lobbyRef, 'value', handler);
  }

  public async addHostCandidate(lobbyId: string, candidate: RTCIceCandidateInit): Promise<void> {
    await this.addCandidate(`lobbies/${lobbyId}/hostCandidates`, candidate);
  }

  public async addJoinerCandidate(lobbyId: string, candidate: RTCIceCandidateInit): Promise<void> {
    await this.addCandidate(`lobbies/${lobbyId}/joinerCandidates`, candidate);
  }

  public observeHostCandidates(lobbyId: string, onCandidate: (candidate: RTCIceCandidateInit) => void): () => void {
    return this.observeCandidates(`lobbies/${lobbyId}/hostCandidates`, onCandidate);
  }

  public observeJoinerCandidates(lobbyId: string, onCandidate: (candidate: RTCIceCandidateInit) => void): () => void {
    return this.observeCandidates(`lobbies/${lobbyId}/joinerCandidates`, onCandidate);
  }

  private async addCandidate(path: string, candidate: RTCIceCandidateInit): Promise<void> {
    await set(push(ref(this.database, path)), {
      candidate,
      createdAt: serverTimestamp(),
    } satisfies CandidateRecord);
  }

  private observeCandidates(path: string, onCandidate: (candidate: RTCIceCandidateInit) => void): () => void {
    const candidatesRef = ref(this.database, path);
    const seen = new Set<string>();
    const handler = (snapshot: DataSnapshot) => {
      const value = snapshot.val() as Record<string, CandidateRecord> | null;
      for (const [id, record] of Object.entries(value ?? {})) {
        if (!seen.has(id)) {
          seen.add(id);
          onCandidate(record.candidate);
        }
      }
    };

    onValue(candidatesRef, handler);
    return () => off(candidatesRef, 'value', handler);
  }
}
