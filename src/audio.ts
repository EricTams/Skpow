import { audioAssets, type SfxId } from './audioAssets';

const AUDIO_MUTED_STORAGE_KEY = 'skpow.audioMuted';
const SFX_POOL_SIZE = 4;
const MUSIC_VOLUME = 0.58;
const SFX_VOLUME = 0.82;

type AudioStateListener = () => void;

export class GameAudio {
  private muted = readStoredMuted();
  private unlocked = false;
  private combatMusicRequested = false;
  private readonly music = new Audio(audioAssets.music.combat);
  private readonly sfxPools = new Map<SfxId, HTMLAudioElement[]>();
  private readonly sfxBuffers = new Map<SfxId, AudioBuffer>();
  private readonly sfxBufferLoads = new Map<SfxId, Promise<AudioBuffer | null>>();
  private readonly listeners = new Set<AudioStateListener>();
  private audioContext: AudioContext | null = null;
  private sfxGain: GainNode | null = null;

  public constructor() {
    this.music.loop = true;
    this.music.preload = 'auto';
    this.music.volume = MUSIC_VOLUME;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean): void {
    if (this.muted === muted) {
      if (!muted) {
        void this.unlockAndResume();
      }
      return;
    }

    this.muted = muted;
    storeMuted(muted);
    if (muted) {
      this.pauseMusic();
    } else {
      void this.unlockAndResume();
    }
    this.emitChange();
  }

  public toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public startCombatMusic(): void {
    this.combatMusicRequested = true;
    if (!this.muted) {
      void this.unlockAndResume();
    }
  }

  public stopCombatMusic(): void {
    this.combatMusicRequested = false;
    this.pauseMusic();
    this.music.currentTime = 0;
  }

  public playSfx(id: SfxId): void {
    if (this.muted) {
      return;
    }

    void this.unlock();

    const buffer = this.sfxBuffers.get(id);
    if (buffer && this.playBufferedSfx(buffer)) {
      return;
    }

    void this.loadSfxBuffer(id);
    this.playPooledSfx(id);
  }

  public subscribe(listener: AudioStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async unlockAndResume(): Promise<void> {
    await this.unlock();
    if (this.combatMusicRequested) {
      await this.playMusic();
    }
  }

  private async unlock(): Promise<void> {
    if (this.unlocked) {
      await this.resumeAudioContext();
      return;
    }

    this.unlocked = true;
    this.music.load();
    this.warmSfxPools();
    this.preloadSfxBuffers();
    await this.resumeAudioContext();
  }

  private async playMusic(): Promise<void> {
    if (!this.music.paused) {
      return;
    }

    await this.music.play().catch(() => {
      // Keep the requested state so the next unmute/click can resume music.
    });
  }

  private pauseMusic(): void {
    this.music.pause();
  }

  private playBufferedSfx(buffer: AudioBuffer): boolean {
    const context = this.getAudioContext();
    const gain = this.sfxGain;
    if (!context || !gain || context.state === 'closed') {
      return false;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start();
    return true;
  }

  private playPooledSfx(id: SfxId): void {
    const clip = this.getAvailableSfx(id);
    clip.currentTime = 0;
    void clip.play().catch(() => {
      // Browsers may still reject playback until a trusted gesture; keep gameplay running.
    });
  }

  private getAvailableSfx(id: SfxId): HTMLAudioElement {
    const pool = this.getSfxPool(id);
    const idle = pool.find((clip) => clip.paused || clip.ended);
    return idle ?? pool[0];
  }

  private getSfxPool(id: SfxId): HTMLAudioElement[] {
    const existing = this.sfxPools.get(id);
    if (existing) {
      return existing;
    }

    const url = audioAssets.sfx[id];
    const pool = Array.from({ length: SFX_POOL_SIZE }, () => {
      const clip = new Audio(url);
      clip.preload = 'auto';
      clip.volume = SFX_VOLUME;
      return clip;
    });
    this.sfxPools.set(id, pool);
    return pool;
  }

  private warmSfxPools(): void {
    for (const id of Object.keys(audioAssets.sfx) as SfxId[]) {
      for (const clip of this.getSfxPool(id)) {
        clip.load();
      }
    }
  }

  private preloadSfxBuffers(): void {
    if (!this.getAudioContext()) {
      return;
    }

    for (const id of Object.keys(audioAssets.sfx) as SfxId[]) {
      void this.loadSfxBuffer(id);
    }
  }

  private loadSfxBuffer(id: SfxId): Promise<AudioBuffer | null> {
    const existingBuffer = this.sfxBuffers.get(id);
    if (existingBuffer) {
      return Promise.resolve(existingBuffer);
    }

    const existingLoad = this.sfxBufferLoads.get(id);
    if (existingLoad) {
      return existingLoad;
    }

    const context = this.getAudioContext();
    if (!context || context.state === 'closed') {
      return Promise.resolve(null);
    }

    const load = fetch(audioAssets.sfx[id])
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((data) => (data ? context.decodeAudioData(data) : null))
      .then((buffer) => {
        if (buffer) {
          this.sfxBuffers.set(id, buffer);
        }
        return buffer;
      })
      .catch(() => null)
      .finally(() => {
        this.sfxBufferLoads.delete(id);
      });

    this.sfxBufferLoads.set(id, load);
    return load;
  }

  private getAudioContext(): AudioContext | null {
    if (this.audioContext) {
      return this.audioContext;
    }

    try {
      this.audioContext = new AudioContext();
      this.sfxGain = this.audioContext.createGain();
      this.sfxGain.gain.value = SFX_VOLUME;
      this.sfxGain.connect(this.audioContext.destination);
      return this.audioContext;
    } catch {
      return null;
    }
  }

  private async resumeAudioContext(): Promise<void> {
    const context = this.getAudioContext();
    if (!context || context.state !== 'suspended') {
      return;
    }

    await context.resume().catch(() => {
      // A user gesture may still be required; the next audio control/input can try again.
    });
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function readStoredMuted(): boolean {
  try {
    const stored = window.localStorage.getItem(AUDIO_MUTED_STORAGE_KEY);
    return stored === null ? true : stored !== 'false';
  } catch {
    return true;
  }
}

function storeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(AUDIO_MUTED_STORAGE_KEY, String(muted));
  } catch {
    // Private browsing/storage failures should not block audio controls.
  }
}
