import {
  get,
  off,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
  type DataSnapshot,
  type Database,
} from 'firebase/database';

export type LobbyKind = 'standard' | 'dev';

export interface LobbySettings {
  readonly pointTotal: number;
  readonly draftMode: 'open';
  readonly kind?: LobbyKind;
}

export function getLobbyKind(lobby: LobbyRecord): LobbyKind {
  return lobby.settings.kind ?? 'standard';
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

export type ClaimAbortReason =
  | 'lobby-missing'
  | 'lobby-not-open'
  | 'lobby-expired'
  | 'already-claimed'
  | 'rules-rejected'
  | 'race-lost'
  | 'transaction-error';

export type ClaimLobbyResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly reason: ClaimAbortReason;
      readonly detail?: string;
      readonly observedLobby?: Omit<LobbyRecord, 'id'> | null;
      readonly committedSnapshot?: Omit<LobbyRecord, 'id'> | null;
    };

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

  public async claimLobby(lobbyId: string, joinerUid: string): Promise<ClaimLobbyResult> {
    const lobbyRef = ref(this.database, `lobbies/${lobbyId}`);

    // Fetch the lobby state from the server directly. Avoids runTransaction's
    // optimistic-cache behaviour, which silently cancels the transaction (no
    // retry) when the local per-child cache is cold and the update fn returns
    // undefined.
    let snapshotExists: boolean;
    let observedLobby: Omit<LobbyRecord, 'id'> | null;
    try {
      const snapshot = await get(lobbyRef);
      snapshotExists = snapshot.exists();
      observedLobby = snapshotExists ? (snapshot.val() as Omit<LobbyRecord, 'id'>) : null;
    } catch (error) {
      return {
        success: false,
        reason: 'transaction-error',
        detail: `get failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!observedLobby) {
      return {
        success: false,
        reason: 'lobby-missing',
        detail: `get returned exists=${snapshotExists}`,
        observedLobby: null,
      };
    }
    if (observedLobby.status !== 'open') {
      return { success: false, reason: 'lobby-not-open', observedLobby };
    }
    if (observedLobby.expiresAt <= Date.now()) {
      return { success: false, reason: 'lobby-expired', observedLobby };
    }
    if (observedLobby.joinerUid) {
      return { success: false, reason: 'already-claimed', observedLobby };
    }

    // Atomic claim via a partial update. Firebase rules require:
    //   data.status === 'open' && !data.joinerUid &&
    //   newData.status === 'connecting' && newData.joinerUid === auth.uid &&
    //   newData.hostUid === data.hostUid
    // so a server-side race against another joiner causes update() to throw
    // PERMISSION_DENIED rather than silently corrupting the lobby.
    try {
      await update(lobbyRef, {
        joinerUid,
        status: 'connecting',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        reason: detail.includes('PERMISSION_DENIED') ? 'race-lost' : 'transaction-error',
        detail,
        observedLobby,
      };
    }

    return { success: true };
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
