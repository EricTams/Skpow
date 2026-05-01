import type { LobbyRecord, LobbyRepository } from './lobby';

export type ConnectionRole = 'host' | 'joiner';
export type ConnectionState = 'idle' | 'signaling' | 'connected' | 'failed' | 'closed';

export interface PeerConnectionEvents {
  readonly onStateChange?: (state: ConnectionState) => void;
  readonly onControlMessage?: (message: string) => void;
  readonly onGameplayMessage?: (message: Uint8Array) => void;
}

export class PeerConnectionSession {
  private readonly peer: RTCPeerConnection;
  private readonly cleanupCallbacks: Array<() => void> = [];
  private readonly pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private controlChannel: RTCDataChannel | null = null;
  private gameplayChannel: RTCDataChannel | null = null;
  private state: ConnectionState = 'idle';
  private connected = false;
  private closed = false;

  public constructor(
    private readonly role: ConnectionRole,
    private readonly lobbyId: string,
    private readonly lobbyRepository: LobbyRepository,
    private readonly events: PeerConnectionEvents = {},
  ) {
    this.peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.peer.onconnectionstatechange = () => this.handleConnectionState();
    this.peer.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      const candidate = event.candidate.toJSON();
      void (this.role === 'host'
        ? this.lobbyRepository.addHostCandidate(this.lobbyId, candidate)
        : this.lobbyRepository.addJoinerCandidate(this.lobbyId, candidate));
    };
    this.peer.ondatachannel = (event) => this.attachDataChannel(event.channel);
  }

  public async start(): Promise<void> {
    this.emitStateChange('signaling');

    if (this.role === 'host') {
      await this.startHost();
      return;
    }

    await this.startJoiner();
  }

  public sendControlMessage(message: string): boolean {
    if (this.controlChannel?.readyState !== 'open') {
      return false;
    }

    this.controlChannel.send(message);
    return true;
  }

  public sendGameplayMessage(message: Uint8Array): boolean {
    if (this.gameplayChannel?.readyState !== 'open') {
      return false;
    }

    const payload = message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
    this.gameplayChannel.send(payload);
    return true;
  }

  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const cleanup of this.cleanupCallbacks) {
      cleanup();
    }

    this.controlChannel?.close();
    this.gameplayChannel?.close();
    this.peer.close();
    this.emitStateChange('closed');
  }

  private async startHost(): Promise<void> {
    this.attachDataChannel(this.peer.createDataChannel('control'));
    this.attachDataChannel(
      this.peer.createDataChannel('gameplay', {
        ordered: false,
        maxRetransmits: 0,
      }),
    );

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    await this.lobbyRepository.setOffer(this.lobbyId, offer);

    this.cleanupCallbacks.push(
      this.lobbyRepository.observeLobby(this.lobbyId, (lobby) => {
        if (lobby?.answer && !this.peer.currentRemoteDescription) {
          void this.setRemoteDescription(lobby.answer);
        }
      }),
      this.lobbyRepository.observeJoinerCandidates(this.lobbyId, (candidate) => {
        void this.addIceCandidate(candidate);
      }),
    );
  }

  private async startJoiner(): Promise<void> {
    const lobby = await this.waitForLobbyOffer();
    await this.setRemoteDescription(lobby.offer);

    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    await this.lobbyRepository.setAnswer(this.lobbyId, answer);

    this.cleanupCallbacks.push(
      this.lobbyRepository.observeHostCandidates(this.lobbyId, (candidate) => {
        void this.addIceCandidate(candidate);
      }),
    );
  }

  private waitForLobbyOffer(): Promise<LobbyRecord & { offer: RTCSessionDescriptionInit }> {
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | null = null;
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for host offer.'));
      }, 15_000);

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        unsubscribe?.();
      };

      unsubscribe = this.lobbyRepository.observeLobby(this.lobbyId, (lobby) => {
        if (lobby?.offer) {
          cleanup();
          resolve(lobby as LobbyRecord & { offer: RTCSessionDescriptionInit });
        }
      });
    });
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';

    if (channel.label === 'control') {
      this.controlChannel = channel;
      channel.onmessage = (event) => this.events.onControlMessage?.(String(event.data));
    }

    if (channel.label === 'gameplay') {
      this.gameplayChannel = channel;
      channel.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.events.onGameplayMessage?.(new Uint8Array(event.data));
        }
      };
    }

    channel.onopen = () => {
      if (this.areDataChannelsOpen() && !this.connected) {
        this.connected = true;
        this.emitStateChange('connected');
        if (this.role === 'host') {
          void this.lobbyRepository.deleteLobby(this.lobbyId);
        }
      }
    };
    channel.onclose = () => {
      if (!this.closed && this.connected) {
        this.emitStateChange('failed');
      }
    };
    channel.onerror = () => {
      if (!this.closed) {
        this.emitStateChange('failed');
      }
    };
  }

  private async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.peer.setRemoteDescription(description);
    await this.flushPendingRemoteCandidates();
  }

  private async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.peer.remoteDescription) {
      this.pendingRemoteCandidates.push(candidate);
      return;
    }

    try {
      await this.peer.addIceCandidate(candidate);
    } catch (error) {
      console.warn('Could not add ICE candidate yet.', error);
    }
  }

  private async flushPendingRemoteCandidates(): Promise<void> {
    while (this.pendingRemoteCandidates.length > 0 && this.peer.remoteDescription) {
      const candidate = this.pendingRemoteCandidates.shift();
      if (candidate) {
        await this.addIceCandidate(candidate);
      }
    }
  }

  private handleConnectionState(): void {
    if (this.peer.connectionState === 'connected' && this.areDataChannelsOpen()) {
      if (!this.connected) {
        this.connected = true;
        this.emitStateChange('connected');
      }
      return;
    }

    if (this.peer.connectionState === 'failed' || this.peer.connectionState === 'disconnected') {
      this.emitStateChange('failed');
    }
  }

  private areDataChannelsOpen(): boolean {
    return this.controlChannel?.readyState === 'open' && this.gameplayChannel?.readyState === 'open';
  }

  private emitStateChange(nextState: ConnectionState): void {
    if (this.state === nextState) {
      return;
    }

    this.state = nextState;
    this.events.onStateChange?.(nextState);
  }
}
