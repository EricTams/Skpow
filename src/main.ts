import './style.css';

import { MenuInputBits, bindKeyboard, readGamepadMenuInput, readInputDeviceStatus, readLocalInputs, readPrimaryLocalInput } from './input';
import { createFixedLoop, SIM_FPS } from './loop';
import { getFirebaseClient, isFirebaseConfigured, observeAnonymousUser, signInWithAnonymousAuth } from './net/firebase';
import { getLobbyKind, LobbyRepository, type LobbyKind, type LobbyRecord } from './net/lobby';
import { NetworkMatchSession, type NetworkMatchStatus } from './net/matchSession';
import { formatPeerStatus } from './net/peerStatus';
import { GameplayPacketType } from './net/protocol';
import { PeerConnectionSession, type ConnectionRole, type ConnectionState } from './net/webrtc';
import { CanvasRenderer, hasActiveShipExplosion } from './render/canvasRenderer';
import { LegacyImageStore, type LegacyImageLoadingProgress, legacyAssets } from './render/legacyAssets';
import { DEFAULT_MATCH_SHIPS, SHIP_CATALOG, getShipCatalogEntry, type ShipCatalogId } from './ships';
import { getAiInput, getAiMovementMode, type AiMovementMode } from './sim/ai';
import type { Fixed } from './sim/fixed';
import { hashState } from './sim/hash';
import { createInitialState } from './sim/state';
import { isKronBeamHitting, stepGame } from './sim/step';
import { ANGLE_STEPS, type Angle } from './sim/trig';
import type { ActorState, GameState, ProjectileState, ShipState } from './sim/types';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Could not find #app element.');
}

const BUDGET_PRESETS = [100, 150, 200] as const;
const AI_DEMO_ROUND_FRAMES = 30 * SIM_FPS;
const NETWORK_CORRECTION_BLEND_FRAMES = 5;
const LAGGY_MP_BUDGET = 100;
const LAGGY_MP_FIND_TIMEOUT_MS = 1500;
const MAX_FLEET_SLOTS = 14;
const FLEET_NAV_REPEAT_FRAMES = 10;

interface FleetShip {
  readonly uid: string;
  readonly catalogId: ShipCatalogId;
  readonly alive: boolean;
}

interface BattleSession {
  readonly budget: number;
  readonly fleets: readonly [readonly FleetShip[], readonly FleetShip[]];
  readonly selectedShipUids: readonly [string | null, string | null];
}

interface PacketImpairmentSettings {
  readonly delayMs: number;
  readonly jitterMs: number;
  readonly dropPct: number;
}

interface NetworkDebugSettings {
  readonly localImpairment: PacketImpairmentSettings;
  readonly aiHost: boolean;
  readonly aiJoiner: boolean;
}

interface PresentationCorrection {
  readonly from: GameState;
  readonly totalFrames: number;
  remainingFrames: number;
}

type MatchOutcome = { readonly kind: 'active' } | { readonly kind: 'winner'; readonly winnerId: number } | { readonly kind: 'draw' };

type AppPhase =
  | { readonly name: 'loading' }
  | { readonly name: 'mainMenu' }
  | { readonly name: 'singleBudget' }
  | { readonly name: 'fleetBuild'; readonly budget: number; readonly fleet: readonly FleetShip[] }
  | { readonly name: 'shipSelect'; readonly session: BattleSession; readonly message?: string }
  | { readonly name: 'fighting'; readonly session: BattleSession; readonly handledWinnerId: number | null }
  | { readonly name: 'aiDemo'; readonly round: number }
  | { readonly name: 'roundResult'; readonly session: BattleSession; readonly winnerId: number; readonly loserId: number }
  | { readonly name: 'finalResult'; readonly title: string; readonly detail: string }
  | { readonly name: 'multiplayerMenu' }
  | { readonly name: 'hostSetup' }
  | { readonly name: 'lobbyBrowser' }
  | { readonly name: 'networkConnecting'; readonly role: ConnectionRole; readonly budget: number; readonly lobbyId: string }
  | { readonly name: 'networkFleetBuild'; readonly role: ConnectionRole; readonly budget: number; readonly lobbyId: string; readonly fleet: readonly FleetShip[] }
  | { readonly name: 'networkFight'; readonly handledWinnerId: number | null }
  | { readonly name: 'networkResult'; readonly winnerId: number };

type MatchLoadout = readonly [ShipCatalogId, ShipCatalogId];
type FleetBuilderNavDirection = 'up' | 'down' | 'left' | 'right';

interface FleetBuilderNavTarget {
  readonly nav: string;
  readonly index: number;
}

let appPhase: AppPhase = { name: 'loading' };
let state: GameState = createInitialState();
let currentLoadout: MatchLoadout = DEFAULT_MATCH_SHIPS;
let currentUid: string | null = null;
let lobbies: readonly LobbyRecord[] = [];
let peerSession: PeerConnectionSession | null = null;
let currentHostLobbyId: string | null = null;
let peerConnectionState: ConnectionState = 'idle';
let networkMatch: NetworkMatchSession | null = null;
let networkMatchStatus: NetworkMatchStatus | null = null;
let networkAiRound = 0;
let pendingHostShip: ShipCatalogId | null = null;
let pendingJoinerShip: ShipCatalogId | null = null;
let lastInputStatusText = '';
let lastInputDebugText = '';
let inputStatusRenderTick = 0;
let cleanupLobbyObserver: (() => void) | null = null;
let fleetSerial = 0;
let loadingProgress: LegacyImageLoadingProgress = { loaded: 0, failed: 0, total: Object.keys(legacyAssets).length };
let networkDebugSettings: NetworkDebugSettings = {
  localImpairment: { delayMs: 0, jitterMs: 0, dropPct: 0 },
  aiHost: false,
  aiJoiner: false,
};
let presentationCorrection: PresentationCorrection | null = null;
let suppressPeerDisconnectPopup = false;
let pauseMenuOpen = false;
let lastRenderedPhaseName: AppPhase['name'] | null = null;
let fleetBuilderNavTarget: FleetBuilderNavTarget | null = null;
let fleetBuilderPickingSlotIndex: number | null = null;
let fleetBuilderConfirmingBack = false;
let previousFleetBuilderInput = 0;
let fleetBuilderNavRepeatFrames = 0;
const pendingGameplayTimers = new Set<number>();
const MP_AI_IMPAIRMENT_DEFAULTS: PacketImpairmentSettings = { delayMs: 100, jitterMs: 50, dropPct: 3 };

app.innerHTML = `
  <main class="legacy-screen">
    <aside class="left-panel legacy-panel" data-player-hud="0"></aside>
    <section class="game-panel" aria-label="SkPow legacy arena">
      <div class="arena-frame">
        <canvas class="game-canvas" data-game-canvas aria-label="SkPow prototype arena"></canvas>
        <div class="menu-overlay" data-menu-overlay></div>
        <div class="arena-hint arena-hint-hidden" data-arena-hint aria-live="polite"></div>
        <div class="network-recovery-overlay network-recovery-overlay-hidden" data-network-recovery-overlay aria-live="polite">
          <div class="network-recovery-card">
            <h2>Resyncing Network Match</h2>
            <p data-network-recovery-message>Waiting for peer snapshot...</p>
          </div>
        </div>
        <div class="pause-overlay pause-overlay-hidden" data-pause-overlay role="dialog" aria-modal="true" aria-labelledby="pause-title">
          <div class="pause-card">
            <h2 id="pause-title">Menu</h2>
            <div class="menu-actions">
              <button type="button" data-pause-resume>Resume</button>
              <button type="button" data-pause-quit>Quit to Main Menu</button>
            </div>
          </div>
        </div>
        <div class="popup-overlay popup-overlay-hidden" data-popup-overlay role="dialog" aria-modal="true" aria-labelledby="popup-title" aria-live="assertive">
          <div class="popup-card">
            <h2 id="popup-title" data-popup-title>Notice</h2>
            <p data-popup-message></p>
            <div class="menu-actions">
              <button type="button" data-popup-dismiss>OK</button>
            </div>
          </div>
        </div>
      </div>
    </section>
    <aside class="side-panel legacy-panel" data-player-hud="1"></aside>
  </main>
  <section class="developer-panel" aria-label="Prototype diagnostics">
    <div class="game-header">
      <h1>SkPow Prototype</h1>
      <p>Super melee prototype: build a fleet, choose your next ship, and fight until one side is out of ships.</p>
      <p class="status-line" data-game-status>Frame 0</p>
      <p class="status-line" data-match-status>Loading assets</p>
      <p class="status-line" data-input-status>No controller detected</p>
    </div>
    <section class="debug-dock">
      <details class="panel-section secondary-panel">
        <summary>Firebase Lobby</summary>
        <p data-firebase-status>Checking Firebase config...</p>
        <div class="button-row">
          <button type="button" data-sign-in>Sign in anonymously</button>
          <button type="button" data-create-lobby>Create test lobby</button>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" data-show-own-lobbies />
          Show my own lobbies for two-window testing
        </label>
        <div class="lobby-list" data-lobby-list></div>
      </details>
      <details class="panel-section secondary-panel">
        <summary>Peer Connection</summary>
        <p class="status-line" data-peer-summary>Peer: idle</p>
        <p data-peer-status>Idle</p>
        <div class="button-row">
          <button type="button" data-send-control>Send control ping</button>
          <button type="button" data-close-peer>Close peer</button>
        </div>
        <div class="button-row">
          <button type="button" data-laggy-mp-host>Laggy MP Host</button>
          <button type="button" data-laggy-mp-client>Laggy MP Client</button>
        </div>
        <p class="dev-helper-text">
          Laggy MP creates a separate dev lobby with AI input on both sides and packet impairment enabled. Dev lobbies do not appear in the standard multiplayer browser.
        </p>
        <div class="network-debug-grid">
          <fieldset>
            <legend>Local outgoing fake lag</legend>
            <label>Delay ms <input type="number" min="0" max="5000" step="25" value="0" data-fake-lag-field="delayMs" /></label>
            <label>Jitter ms <input type="number" min="0" max="5000" step="25" value="0" data-fake-lag-field="jitterMs" /></label>
            <label>Drop % <input type="number" min="0" max="100" step="1" value="0" data-fake-lag-field="dropPct" /></label>
          </fieldset>
        </div>
      </details>
      <details class="panel-section secondary-panel">
        <summary>Debug Log</summary>
        <pre class="debug-log" data-debug-log></pre>
      </details>
    </section>
  </section>
`;

const legacyScreen = requiredElement<HTMLElement>('.legacy-screen');
const canvas = requiredElement<HTMLCanvasElement>('[data-game-canvas]');
const arenaFrame = requiredElement<HTMLElement>('.arena-frame');
const menuOverlay = requiredElement<HTMLElement>('[data-menu-overlay]');
const networkRecoveryOverlay = requiredElement<HTMLElement>('[data-network-recovery-overlay]');
const networkRecoveryMessage = requiredElement<HTMLElement>('[data-network-recovery-message]');
const arenaHint = requiredElement<HTMLElement>('[data-arena-hint]');
const popupOverlay = requiredElement<HTMLElement>('[data-popup-overlay]');
const popupTitle = requiredElement<HTMLElement>('[data-popup-title]');
const popupMessage = requiredElement<HTMLElement>('[data-popup-message]');
const popupDismissButton = requiredElement<HTMLButtonElement>('[data-popup-dismiss]');
const pauseOverlay = requiredElement<HTMLElement>('[data-pause-overlay]');
const pauseResumeButton = requiredElement<HTMLButtonElement>('[data-pause-resume]');
const pauseQuitButton = requiredElement<HTMLButtonElement>('[data-pause-quit]');
const gameStatus = requiredElement<HTMLElement>('[data-game-status]');
const matchStatus = requiredElement<HTMLElement>('[data-match-status]');
const inputStatus = requiredElement<HTMLElement>('[data-input-status]');
const firebaseStatus = requiredElement<HTMLElement>('[data-firebase-status]');
const peerSummary = requiredElement<HTMLElement>('[data-peer-summary]');
const peerStatus = requiredElement<HTMLElement>('[data-peer-status]');
const debugLog = requiredElement<HTMLElement>('[data-debug-log]');
const lobbyList = requiredElement<HTMLElement>('[data-lobby-list]');
const signInButton = requiredElement<HTMLButtonElement>('[data-sign-in]');
const createLobbyButton = requiredElement<HTMLButtonElement>('[data-create-lobby]');
const sendControlButton = requiredElement<HTMLButtonElement>('[data-send-control]');
const closePeerButton = requiredElement<HTMLButtonElement>('[data-close-peer]');
const showOwnLobbiesCheckbox = requiredElement<HTMLInputElement>('[data-show-own-lobbies]');
const laggyMpHostButton = requiredElement<HTMLButtonElement>('[data-laggy-mp-host]');
const laggyMpClientButton = requiredElement<HTMLButtonElement>('[data-laggy-mp-client]');
const fakeLagInputs = Array.from(document.querySelectorAll<HTMLInputElement>('[data-fake-lag-field]'));
const hudContainers = Array.from(document.querySelectorAll<HTMLElement>('[data-player-hud]'));

const legacyImages = new LegacyImageStore({
  onProgress: (progress) => {
    loadingProgress = progress;
    if (appPhase.name === 'loading' && progress.loaded + progress.failed >= progress.total) {
      appPhase = { name: 'mainMenu' };
    }
    renderMenu();
  },
});
const renderer = new CanvasRenderer(canvas, legacyImages);
renderer.setShipLoadout(currentLoadout);
renderHud(currentLoadout);
renderMenu();

const firebase = getFirebaseClient();
const lobbyRepository = firebase ? new LobbyRepository(firebase.database) : null;

const cleanupKeyboard = bindKeyboard({
  shouldCapture: (event) =>
    appPhase.name === 'fighting' ||
    appPhase.name === 'networkFight' ||
    (isFleetBuilderPhase() && event.code !== 'ShiftLeft' && event.code !== 'ShiftRight'),
});
window.addEventListener('beforeunload', cleanupKeyboard);
window.addEventListener('keydown', (event) => {
  if (handleFleetBuilderKeyboardNav(event)) {
    return;
  }

  if (event.code !== 'Escape') {
    return;
  }

  if (!popupOverlay.classList.contains('popup-overlay-hidden')) {
    hidePopup();
    return;
  }

  if (isPauseMenuAvailable()) {
    togglePauseMenu();
  }
});

createFixedLoop(
  () => {
    updateFleetBuilderGamepadNav();

    if (appPhase.name === 'fighting') {
      if (pauseMenuOpen) {
        return;
      }
      const localInputs = readLocalInputs();
      state = stepGame(state, [localInputs[0], getAiInput(state, 1)]);
      trackDamage(state);
      if (hasActiveShipExplosion(state)) {
        return;
      }
      const outcome = getMatchOutcome(state);
      if (outcome.kind === 'winner' && appPhase.handledWinnerId !== outcome.winnerId) {
        resolveLocalRound(appPhase.session, outcome.winnerId);
      } else if (outcome.kind === 'draw' && appPhase.handledWinnerId === null) {
        resolveLocalMutualDestruction(appPhase.session);
      }
      return;
    }

    if (appPhase.name === 'aiDemo') {
      if (pauseMenuOpen) {
        return;
      }
      state = stepGame(state, [getAiInput(state, 0), getAiInput(state, 1)]);
      trackDamage(state);
      if (hasActiveShipExplosion(state)) {
        return;
      }
      if (isAiDemoRoundComplete(state)) {
        startAiDemoRound(appPhase.round + 1);
      }
      return;
    }

    if (appPhase.name === 'networkFight' && networkMatch && peerConnectionState === 'connected') {
      if (shouldStartNextNetworkAiRound()) {
        startNextNetworkAiRound();
        return;
      }

      const result = networkMatch.step(readNetworkLocalInput());
      networkMatchStatus = result.status;
      sendGameplayPackets(result.packets);
      updatePeerStatus();
      syncNetworkLoadoutFromMatch();
      const trackable = result.state ?? networkMatch.currentState;
      if (trackable) {
        trackDamage(trackable);
      }
      const networkPresentationState = result.state ?? networkMatch.currentState;
      const outcome = getMatchOutcome(networkPresentationState);
      if (shouldStartNextNetworkAiRound()) {
        startNextNetworkAiRound();
        return;
      }
      if (networkPresentationState && hasActiveShipExplosion(networkPresentationState)) {
        return;
      }
      if (outcome.kind === 'winner' && !networkMatchStatus?.aiDemo && appPhase.handledWinnerId !== outcome.winnerId) {
        appPhase = { name: 'networkResult', winnerId: outcome.winnerId };
        renderMenu();
      } else if (outcome.kind === 'draw' && !networkMatchStatus?.aiDemo && appPhase.handledWinnerId === null) {
        appPhase = { name: 'finalResult', title: 'Draw', detail: 'Both online ships were destroyed.' };
        renderMenu();
      }
    }
  },
  () => {
    maybeUpdateInputStatus();

    if (!isCombatPhase()) {
      clearCanvas();
      gameStatus.textContent = 'Menu';
      matchStatus.textContent = formatPhaseStatus();
      return;
    }

    const authoritativeState = networkMatch?.currentState ?? state;
    const renderState = getPresentationState(authoritativeState);
    renderer.setAiDebugModes(getAiDebugModes(renderState));
    renderer.render(renderState);
    gameStatus.textContent = `Frame ${authoritativeState.frame} | Hash ${hashState(authoritativeState).toString(16).padStart(8, '0')}`;
    matchStatus.textContent = formatMatchStatus(authoritativeState);
    updateLegacyHud(authoritativeState);
  },
).start();

function getAiDebugModes(renderState: GameState): readonly (AiMovementMode | null)[] {
  if (appPhase.name === 'aiDemo') {
    return renderState.ships.map((ship) => getAiMovementMode(renderState, ship.id));
  }

  if (appPhase.name === 'fighting') {
    return renderState.ships.map((ship) => (ship.id === 1 ? getAiMovementMode(renderState, ship.id) : null));
  }

  if (appPhase.name === 'networkFight') {
    return renderState.ships.map((ship) => {
      if (ship.id === 0 && (networkMatchStatus?.aiDemo || networkDebugSettings.aiHost)) {
        return getAiMovementMode(renderState, ship.id);
      }

      if (ship.id === 1 && (networkMatchStatus?.aiDemo || networkDebugSettings.aiJoiner)) {
        return getAiMovementMode(renderState, ship.id);
      }

      return null;
    });
  }

  return [];
}

function maybeStartPresentationCorrection(
  previousState: GameState | null,
  session: NetworkMatchSession,
): void {
  const nextState = session.currentState;
  if (!previousState || !nextState) {
    return;
  }

  if (hashState(previousState) === hashState(nextState)) {
    return;
  }

  const currentPresentation = peekPresentationState(previousState);
  presentationCorrection = {
    from: currentPresentation,
    totalFrames: NETWORK_CORRECTION_BLEND_FRAMES,
    remainingFrames: NETWORK_CORRECTION_BLEND_FRAMES,
  };
}

function getPresentationState(authoritativeState: GameState): GameState {
  if (!presentationCorrection) {
    return authoritativeState;
  }

  const progress = getPresentationCorrectionProgress();
  presentationCorrection.remainingFrames -= 1;
  const easedProgress = easeOutCubic(Math.max(0, Math.min(1, progress)));
  const renderState = blendGameState(presentationCorrection.from, authoritativeState, easedProgress, getLocalPresentationShipId());

  if (presentationCorrection.remainingFrames <= 0) {
    presentationCorrection = null;
  }

  return renderState;
}

function peekPresentationState(authoritativeState: GameState): GameState {
  if (!presentationCorrection) {
    return authoritativeState;
  }

  const progress = getPresentationCorrectionProgress();
  return blendGameState(
    presentationCorrection.from,
    authoritativeState,
    easeOutCubic(Math.max(0, Math.min(1, progress))),
    getLocalPresentationShipId(),
  );
}

function getPresentationCorrectionProgress(): number {
  return presentationCorrection ? 1 - presentationCorrection.remainingFrames / presentationCorrection.totalFrames : 1;
}

function blendGameState(from: GameState, to: GameState, progress: number, immediateShipId: number | null): GameState {
  const fromShips = new Map(from.ships.map((ship) => [ship.id, ship]));
  const fromActors = new Map(from.actors.map((actor) => [actor.id, actor]));
  const fromProjectiles = new Map(from.projectiles.map((projectile) => [projectile.id, projectile]));

  return {
    ...to,
    ships: to.ships.map((ship) => (ship.id === immediateShipId ? ship : blendShip(fromShips.get(ship.id), ship, to, progress))),
    actors: to.actors.map((actor) => blendActor(fromActors.get(actor.id), actor, to, progress)),
    projectiles: to.projectiles.map((projectile) => blendProjectile(fromProjectiles.get(projectile.id), projectile, to, progress)),
  };
}

function getLocalPresentationShipId(): number | null {
  return appPhase.name === 'networkFight' ? (networkMatch?.status.localPlayerIndex ?? null) : null;
}

function blendShip(from: ShipState | undefined, to: ShipState, state: GameState, progress: number): ShipState {
  if (!from || from.shipId !== to.shipId) {
    return to;
  }

  return {
    ...to,
    x: lerpWrappedFixed(from.x, to.x, state.arena.width, progress),
    y: lerpWrappedFixed(from.y, to.y, state.arena.height, progress),
    angle: lerpAngle(from.angle, to.angle, progress),
    custom: {
      ...to.custom,
      cameraOverrideX:
        from.custom.cameraOverrideX !== undefined && to.custom.cameraOverrideX !== undefined
          ? lerpWrappedFixed(from.custom.cameraOverrideX, to.custom.cameraOverrideX, state.arena.width, progress)
          : to.custom.cameraOverrideX,
      cameraOverrideY:
        from.custom.cameraOverrideY !== undefined && to.custom.cameraOverrideY !== undefined
          ? lerpWrappedFixed(from.custom.cameraOverrideY, to.custom.cameraOverrideY, state.arena.height, progress)
          : to.custom.cameraOverrideY,
    },
  };
}

function blendActor(from: ActorState | undefined, to: ActorState, state: GameState, progress: number): ActorState {
  if (!from || from.kind !== to.kind) {
    return to;
  }

  return {
    ...to,
    x: lerpWrappedFixed(from.x, to.x, state.arena.width, progress),
    y: lerpWrappedFixed(from.y, to.y, state.arena.height, progress),
    angle: lerpAngle(from.angle, to.angle, progress),
  };
}

function blendProjectile(from: ProjectileState | undefined, to: ProjectileState, state: GameState, progress: number): ProjectileState {
  if (!from || from.kind !== to.kind) {
    return to;
  }

  return {
    ...to,
    x: lerpWrappedFixed(from.x, to.x, state.arena.width, progress),
    y: lerpWrappedFixed(from.y, to.y, state.arena.height, progress),
    angle: lerpAngle(from.angle, to.angle, progress),
  };
}

function lerpWrappedFixed(from: Fixed, to: Fixed, max: Fixed, progress: number): Fixed {
  const delta = getWrappedFixedDelta(to, from, max);
  return wrapSignedFixed(Math.round(from + delta * progress) as Fixed, max);
}

function getWrappedFixedDelta(to: Fixed, from: Fixed, max: Fixed): number {
  const radius = max / 2;
  let delta = to - from;
  if (delta > radius) {
    delta -= max;
  } else if (delta < -radius) {
    delta += max;
  }
  return delta;
}

function wrapSignedFixed(value: Fixed, max: Fixed): Fixed {
  const radius = max / 2;
  if (value < -radius) {
    return (value + max) as Fixed;
  }

  if (value > radius) {
    return (value - max) as Fixed;
  }

  return value;
}

function lerpAngle(from: Angle, to: Angle, progress: number): Angle {
  const radius = ANGLE_STEPS / 2;
  let delta = to - from;
  if (delta > radius) {
    delta -= ANGLE_STEPS;
  } else if (delta < -radius) {
    delta += ANGLE_STEPS;
  }

  return (((Math.round(from + delta * progress) % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS) as Angle;
}

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

function readNetworkLocalInput(): number {
  if (pauseMenuOpen) {
    return 0;
  }

  if (!networkMatch) {
    return readPrimaryLocalInput();
  }

  const status = networkMatch.status;
  const aiEnabled = status.aiDemo || (status.role === 'host' ? networkDebugSettings.aiHost : networkDebugSettings.aiJoiner);
  const currentState = networkMatch.currentState;
  if (aiEnabled && currentState) {
    return getAiInput(currentState, status.localPlayerIndex);
  }

  return readPrimaryLocalInput();
}

function shouldStartNextNetworkAiRound(): boolean {
  if (!networkMatch || networkMatch.status.role !== 'host' || !networkMatch.status.aiDemo || peerConnectionState !== 'connected') {
    return false;
  }

  const currentState = networkMatch.currentState;
  return currentState !== null && isAiDemoRoundComplete(currentState);
}

function startNextNetworkAiRound(): void {
  if (!networkMatch || networkMatch.status.role !== 'host') {
    return;
  }

  networkAiRound += 1;
  currentLoadout = chooseRandomNetworkAiLoadout();
  const seed = Date.now() >>> 0;
  clearPendingGameplayPackets();
  state = createInitialState(seed, currentLoadout);
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
  networkMatch = new NetworkMatchSession('host', { roundId: networkAiRound, seed, loadout: currentLoadout, aiDemo: true, readyImmediately: true });
  networkMatchStatus = networkMatch.status;
  presentationCorrection = null;
  sendGameplayPackets(networkMatch.takeOutgoingPackets());
  updatePeerStatus();
  log(
    `Laggy MP round ${networkAiRound + 1}: ${getShipCatalogEntry(currentLoadout[0]).name} vs ${getShipCatalogEntry(currentLoadout[1]).name}`,
  );
}

function syncNetworkLoadoutFromMatch(): void {
  const ships = networkMatch?.currentState?.ships;
  if (!ships || ships.length < 2) {
    return;
  }

  const loadout: MatchLoadout = [ships[0].shipId, ships[1].shipId];
  if (loadout[0] === currentLoadout[0] && loadout[1] === currentLoadout[1]) {
    return;
  }

  currentLoadout = loadout;
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
}

if (!isFirebaseConfigured() || !firebase || !lobbyRepository) {
  firebaseStatus.textContent = 'Firebase env values are missing. Local prototype is still playable.';
  signInButton.disabled = true;
  createLobbyButton.disabled = true;
  laggyMpHostButton.disabled = true;
  laggyMpClientButton.disabled = true;
} else {
  firebaseStatus.textContent = 'Firebase configured. Signing in anonymously...';
  createLobbyButton.disabled = true;
  laggyMpHostButton.disabled = true;
  laggyMpClientButton.disabled = true;
  observeAnonymousUser((user) => {
    currentUid = user?.uid ?? null;
    const signedIn = currentUid !== null;
    createLobbyButton.disabled = !signedIn;
    laggyMpHostButton.disabled = !signedIn;
    laggyMpClientButton.disabled = !signedIn;
    firebaseStatus.textContent = currentUid
      ? `Signed in anonymously: ${currentUid}`
      : 'Not signed in. Tap "Sign In Anonymously" to retry.';
    updateLobbyObserver();
    renderLobbies();
    renderMenu();
  });
  // Kick off anonymous sign-in automatically so multiplayer is ready without an extra
  // tap in the dev panel. The observer above will fire once the auth completes.
  void signInWithAnonymousAuth().catch((error) => {
    log(`Auto sign-in failed: ${readError(error)}`);
    firebaseStatus.textContent = 'Auto sign-in failed. Tap "Sign In Anonymously" to retry.';
  });
}

menuOverlay.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) {
    return;
  }

  handleMenuAction(button);
});

popupDismissButton.addEventListener('click', () => {
  hidePopup();
});

popupOverlay.addEventListener('click', (event) => {
  if (event.target === popupOverlay) {
    hidePopup();
  }
});

pauseResumeButton.addEventListener('click', () => {
  closePauseMenu();
});

pauseQuitButton.addEventListener('click', () => {
  quitToMainMenu();
});

pauseOverlay.addEventListener('click', (event) => {
  if (event.target === pauseOverlay) {
    closePauseMenu();
  }
});

signInButton.addEventListener('click', () => {
  void signInWithAnonymousAuth().catch((error) => log(`Anonymous auth failed: ${readError(error)}`));
});

createLobbyButton.addEventListener('click', () => {
  if (!currentUid || !lobbyRepository) {
    return;
  }

  clearAiOverrides();
  void createHostLobby(currentUid, lobbyRepository, 100);
});

sendControlButton.addEventListener('click', () => {
  const sent = peerSession?.sendControlMessage(`ping:${Date.now()}`) ?? false;
  log(sent ? 'Sent control ping.' : 'Control channel is not open.');
});

closePeerButton.addEventListener('click', () => {
  closePeer();
  appPhase = { name: 'mainMenu' };
  renderMenu();
});

showOwnLobbiesCheckbox.addEventListener('change', () => {
  renderLobbies();
  renderMenu();
});

laggyMpHostButton.addEventListener('click', () => {
  void startLaggyMpHost();
});

laggyMpClientButton.addEventListener('click', () => {
  void startLaggyMpClient();
});

for (const input of fakeLagInputs) {
  input.addEventListener('change', () => {
    updateFakeLagSetting(input);
  });
}

function handleMenuAction(button: HTMLButtonElement): void {
  const action = button.dataset.action;
  switch (action) {
    case 'main-single':
      appPhase = { name: 'singleBudget' };
      break;
    case 'main-ai-demo':
      startAiDemoRound(1);
      return;
    case 'main-multi':
      appPhase = { name: 'multiplayerMenu' };
      break;
    case 'sign-in':
      void signInWithAnonymousAuth().catch((error) => log(`Anonymous auth failed: ${readError(error)}`));
      return;
    case 'back':
      goBack();
      return;
    case 'choose-budget':
      appPhase = { name: 'fleetBuild', budget: readBudget(button), fleet: [] };
      break;
    case 'fleet-add':
      addShipToPlayerFleet(readShipId(button));
      return;
    case 'fleet-slot-pick':
      selectFleetBuilderSlot(readFleetSlotIndex(button));
      return;
    case 'fleet-pick-ship':
      addShipToPlayerFleet(readShipId(button));
      return;
    case 'fleet-picker-cancel':
      cancelFleetBuilderShipPicker();
      return;
    case 'fleet-back-request':
      requestFleetBuilderBackConfirmation();
      return;
    case 'fleet-back-cancel':
      cancelFleetBuilderBackConfirmation();
      return;
    case 'fleet-back-confirm':
      confirmFleetBuilderBack();
      return;
    case 'fleet-remove':
      removeShipFromPlayerFleet(readFleetUid(button));
      return;
    case 'fleet-ready':
      if (appPhase.name === 'networkFleetBuild') {
        readyNetworkFleet();
      } else {
        startSinglePlayerRun();
      }
      return;
    case 'ship-pick':
      choosePlayerShip(readFleetUid(button));
      return;
    case 'round-continue':
      continueAfterRound();
      return;
    case 'final-main':
      quitToMainMenu();
      return;
    case 'multi-host':
      if (!ensureMultiplayerReady('Cannot create a hosted lobby right now.')) {
        return;
      }
      appPhase = { name: 'hostSetup' };
      break;
    case 'multi-join':
      if (!ensureMultiplayerReady('Cannot browse hosted lobbies right now.')) {
        return;
      }
      appPhase = { name: 'lobbyBrowser' };
      break;
    case 'host-lobby':
      void hostLobbyFromMenu(readBudget(button));
      return;
    case 'join-lobby':
      void joinLobbyFromMenu(readLobbyId(button));
      return;
  }

  renderMenu();
}

function renderMenu(): void {
  const phaseChanged = lastRenderedPhaseName !== null && lastRenderedPhaseName !== appPhase.name;
  if (phaseChanged) {
    closePauseMenu();
    fleetBuilderConfirmingBack = false;
  }
  if (!isPauseMenuAvailable()) {
    closePauseMenu();
  }
  lastRenderedPhaseName = appPhase.name;

  const combatPhase = isCombatPhase();
  legacyScreen.classList.toggle('legacy-screen-menu-active', !combatPhase);
  arenaFrame.classList.toggle('arena-frame-menu-active', !combatPhase);
  menuOverlay.classList.toggle('menu-overlay-hidden', combatPhase);
  updateNetworkRecoveryOverlay();
  updateArenaHint();
  updateLobbyObserver();

  switch (appPhase.name) {
    case 'loading':
      menuOverlay.innerHTML = renderLoadingMenu();
      break;
    case 'mainMenu':
      menuOverlay.innerHTML = renderMainMenu();
      break;
    case 'singleBudget':
      menuOverlay.innerHTML = renderBudgetMenu(
        'Build Single Player Fleet',
        'choose-budget',
        'Pick a point budget for your side.',
        '<button type="button" data-action="back">Back</button>',
      );
      break;
    case 'fleetBuild':
      menuOverlay.innerHTML = renderFleetBuildMenu(appPhase);
      break;
    case 'shipSelect':
      menuOverlay.innerHTML = renderShipSelectMenu(appPhase);
      break;
    case 'roundResult':
      menuOverlay.innerHTML = renderRoundResultMenu(appPhase);
      break;
    case 'finalResult':
      menuOverlay.innerHTML = renderFinalResultMenu(appPhase.title, appPhase.detail);
      break;
    case 'multiplayerMenu':
      menuOverlay.innerHTML = renderMultiplayerMenu();
      break;
    case 'hostSetup':
      menuOverlay.innerHTML = renderBudgetMenu(
        'Create Hosted Lobby',
        'host-lobby',
        'Choose the point budget advertised to joiners.',
        '<button type="button" data-action="back">Back</button>',
      );
      break;
    case 'lobbyBrowser':
      menuOverlay.innerHTML = renderLobbyBrowserMenu();
      break;
    case 'networkConnecting':
      menuOverlay.innerHTML = renderNetworkConnectingMenu(appPhase);
      break;
    case 'networkFleetBuild':
      menuOverlay.innerHTML = renderFleetBuildMenu(appPhase);
      break;
    case 'networkResult':
      menuOverlay.innerHTML = renderFinalResultMenu(`Player ${appPhase.winnerId + 1} wins`, 'The online duel is complete.');
      break;
    case 'fighting':
    case 'aiDemo':
    case 'networkFight':
      menuOverlay.innerHTML = '';
      break;
  }

  if (isFleetBuilderPhase()) {
    queueFleetBuilderFocusRestore();
  }
}

function renderLoadingMenu(): string {
  const complete = loadingProgress.loaded + loadingProgress.failed;
  const percent = loadingProgress.total === 0 ? 100 : Math.round((complete / loadingProgress.total) * 100);
  const failedText = loadingProgress.failed > 0 ? ` (${loadingProgress.failed} failed)` : '';
  return `
    <section class="menu-card menu-card-narrow">
      ${renderMenuBrand()}
      <p class="menu-kicker">Loading</p>
      <h2>Preparing the melee</h2>
      <div class="loading-bar" aria-label="Asset loading progress">
        <span style="width: ${percent}%"></span>
      </div>
      <p>${complete} / ${loadingProgress.total} art assets loaded${failedText}</p>
    </section>
  `;
}

function renderMainMenu(): string {
  return `
    <section class="menu-card">
      ${renderMenuBrand()}
      <p class="menu-kicker">SkPow Super Melee</p>
      <h2>Main Menu</h2>
      <p>Build a fleet, pick your next ship, and fight until one side is out of ships.</p>
      <div class="menu-actions">
        <button type="button" data-action="main-single">Single Player</button>
        <button type="button" data-action="main-ai-demo">Attract Mode</button>
        <button type="button" data-action="main-multi">Multiplayer</button>
      </div>
    </section>
  `;
}

function renderBudgetMenu(title: string, action: string, detail: string, backButton: string = ''): string {
  return `
    <section class="menu-card">
      ${renderMenuBrand()}
      <p class="menu-kicker">Point Budget</p>
      <h2>${title}</h2>
      <p>${detail}</p>
      <div class="budget-grid">
        ${BUDGET_PRESETS.map((budget) => `<button type="button" data-action="${action}" data-budget="${budget}">${budget} pts</button>`).join('')}
      </div>
      <label class="menu-field">
        Custom budget
        <input type="number" min="40" max="999" step="10" value="100" data-budget-input />
      </label>
      <div class="menu-actions">
        <button type="button" data-action="${action}" data-budget-source="custom">Use Custom Budget</button>
        ${backButton}
      </div>
    </section>
  `;
}

function renderFleetBuildMenu(phase: Extract<AppPhase, { readonly name: 'fleetBuild' | 'networkFleetBuild' }>): string {
  const remaining = getRemainingBudget(phase.fleet, phase.budget);
  const isNetwork = phase.name === 'networkFleetBuild';
  const activeSide = !isNetwork || phase.role === 'host' ? 0 : 1;
  const modeLabel = isNetwork ? 'Multiplayer' : 'Single Player';
  const detail = isNetwork
    ? 'Build your fleet here. For now, Ready launches the first ship as the online starting ship.'
    : 'Add ships to your fleet, then pick your first champion when the battle begins.';
  return `
    <section
      class="fleet-builder-screen"
      style="--fleet-builder-space: url('${legacyAssets.space.url}'); --fleet-builder-space-alt: url('${legacyAssets.space3.url}');"
    >
      <header class="fleet-builder-header">
        <div>
          <p class="menu-kicker">${modeLabel}</p>
          <h2>Build Your Fleet</h2>
          <p>${detail}</p>
        </div>
      </header>
      ${renderFleetBuilderScreen({
        fleet: phase.fleet,
        budget: phase.budget,
        remaining,
        activeSide,
        hideP2: !isNetwork,
        readyLabel: isNetwork ? 'Ready Starting Ship' : 'Ready',
        backLabel: isNetwork ? 'Leave Match' : 'Back',
      })}
    </section>
  `;
}

function renderFleetBuilderScreen(options: {
  readonly fleet: readonly FleetShip[];
  readonly budget: number;
  readonly remaining: number;
  readonly activeSide: 0 | 1;
  readonly hideP2: boolean;
  readonly readyLabel: string;
  readonly backLabel: string;
}): string {
  const fleets: readonly [readonly FleetShip[], readonly FleetShip[]] =
    options.activeSide === 0 ? [options.fleet, []] : [[], options.fleet];
  const pickingSlotIndex =
    fleetBuilderPickingSlotIndex !== null && fleetBuilderPickingSlotIndex === options.fleet.length && options.fleet.length < MAX_FLEET_SLOTS
      ? fleetBuilderPickingSlotIndex
      : null;
  return `
    <div class="fleet-builder-body">
      <div class="fleet-stage" aria-label="Fleet roster">
        ${renderFleetPanel({
          fleet: fleets[0],
          label: 'P1 Fleet',
          isEditable: options.activeSide === 0,
          isHidden: false,
          pickerHtml: pickingSlotIndex !== null && options.activeSide === 0 ? renderFleetShipPicker(options.remaining, pickingSlotIndex) : '',
          controlsHtml:
            options.activeSide === 0
              ? renderFleetCommandBlock(options.remaining, options.fleet.length, options.readyLabel, options.backLabel, pickingSlotIndex)
              : '',
        })}
        ${renderFleetPanel({
          fleet: fleets[1],
          label: 'P2 Fleet',
          isEditable: options.activeSide === 1,
          isHidden: options.hideP2,
          pickerHtml: pickingSlotIndex !== null && options.activeSide === 1 ? renderFleetShipPicker(options.remaining, pickingSlotIndex) : '',
          controlsHtml:
            options.activeSide === 1
              ? renderFleetCommandBlock(options.remaining, options.fleet.length, options.readyLabel, options.backLabel, pickingSlotIndex)
              : '',
        })}
      </div>
    </div>
  `;
}

function renderFleetCommandBlock(
  remaining: number,
  fleetLength: number,
  readyLabel: string,
  backLabel: string,
  pickingSlotIndex: number | null,
): string {
  return `
    <aside class="fleet-command-panel" aria-label="Fleet commands">
      <dl class="fleet-stats">
        <div>
          <dt>Remaining</dt>
          <dd>${remaining}</dd>
        </div>
        <div>
          <dt>Ships</dt>
          <dd>${fleetLength}/${MAX_FLEET_SLOTS}</dd>
        </div>
      </dl>
      ${renderFleetCommandActions(fleetLength, readyLabel, backLabel, pickingSlotIndex)}
    </aside>
  `;
}

function renderFleetCommandActions(fleetLength: number, readyLabel: string, backLabel: string, pickingSlotIndex: number | null): string {
  if (fleetBuilderConfirmingBack) {
    return `
      <div class="fleet-command-actions">
        <button type="button" data-action="fleet-back-cancel" data-fleet-nav="command" data-fleet-nav-index="1">Stay</button>
        <button type="button" class="fleet-danger-button" data-action="fleet-back-confirm" data-fleet-nav="command" data-fleet-nav-index="2">Confirm ${backLabel}</button>
      </div>
    `;
  }

  const note = pickingSlotIndex === null ? '' : `<p class="fleet-command-note">Cancel returns to the fleet.</p>`;
  return `
    <div class="fleet-command-actions">
      <button type="button" data-action="fleet-ready" data-fleet-nav="command" data-fleet-nav-index="0" ${fleetLength === 0 ? 'disabled' : ''}>${readyLabel}</button>
      <button type="button" data-action="fleet-back-request" data-fleet-nav="command" data-fleet-nav-index="1">${backLabel}</button>
    </div>
    ${note}
  `;
}

function renderFleetShipPicker(remaining: number, slotIndex: number): string {
  return `
    <section class="fleet-ship-picker" aria-label="Choose ship for slot ${slotIndex + 1}">
      ${renderShipCatalogGrid(remaining)}
    </section>
  `;
}

function renderFleetPanel(options: {
  readonly fleet: readonly FleetShip[];
  readonly label: string;
  readonly isEditable: boolean;
  readonly isHidden: boolean;
  readonly pickerHtml: string;
  readonly controlsHtml: string;
}): string {
  const hiddenClass = options.isHidden ? ' fleet-console-hidden' : '';
  const editableClass = options.isEditable ? ' fleet-console-active' : '';
  const pickingClass = options.pickerHtml ? ' fleet-console-picking' : '';
  const contentClass = options.controlsHtml ? ' fleet-console-content fleet-console-content-controls' : ' fleet-console-content';
  return `
    <section class="fleet-console${editableClass}${hiddenClass}${pickingClass}" aria-label="${options.label}" ${options.isHidden ? 'aria-hidden="true"' : ''}>
      ${
        options.pickerHtml
          ? `
            <div class="${contentClass}">
              <div class="fleet-picker-frame">${options.pickerHtml}</div>
              ${options.controlsHtml}
            </div>
          `
          : `
            <div class="fleet-console-title">
              <h3>${options.label}</h3>
            </div>
            <div class="${contentClass}">
              <div class="fleet-roster-frame">
                ${renderFleetSlots(options.fleet, options.isEditable)}
              </div>
              ${options.controlsHtml}
            </div>
          `
      }
    </section>
  `;
}

function renderFleetSlots(fleet: readonly FleetShip[], isEditable: boolean): string {
  const slots = Array.from({ length: MAX_FLEET_SLOTS }, (_, index) => renderFleetSlot(index, fleet[index], isEditable, fleet.length));
  return `<div class="fleet-slot-grid">${slots.join('')}</div>`;
}

function renderFleetSlot(index: number, fleetShip: FleetShip | undefined, isEditable: boolean, fleetLength: number): string {
  if (!fleetShip) {
    const isNextOpenSlot = isEditable && index === fleetLength && fleetLength < MAX_FLEET_SLOTS;
    if (isNextOpenSlot) {
      return `
        <button
          type="button"
          class="fleet-slot fleet-slot-empty fleet-slot-open"
          data-action="fleet-slot-pick"
          data-fleet-slot-index="${index}"
          data-fleet-nav="slot"
          data-fleet-nav-index="${index}"
          aria-label="Choose ship for empty slot ${index + 1}"
        >
          <span>${index + 1}</span>
        </button>
      `;
    }

    return `
      <div class="fleet-slot fleet-slot-empty" aria-label="Empty fleet slot ${index + 1}">
        <span>${index + 1}</span>
      </div>
    `;
  }

  const ship = getShipCatalogEntry(fleetShip.catalogId);
  if (!isEditable) {
    return `
      <div class="fleet-slot fleet-slot-filled fleet-slot-readonly" aria-label="${ship.name} in slot ${index + 1}">
        <span class="fleet-slot-number">${index + 1}</span>
        ${renderShipThumb(fleetShip.catalogId, 'fleet-slot-ship')}
        <span class="fleet-slot-name">${ship.name}</span>
        <span class="fleet-slot-cost">${ship.cost}</span>
      </div>
    `;
  }

  return `
    <button
      type="button"
      class="fleet-slot fleet-slot-filled"
      data-action="fleet-remove"
      data-fleet-uid="${fleetShip.uid}"
      data-fleet-nav="slot"
      data-fleet-nav-index="${index}"
      aria-label="Remove ${ship.name} from slot ${index + 1}"
    >
      <span class="fleet-slot-number">${index + 1}</span>
      ${renderShipThumb(fleetShip.catalogId, 'fleet-slot-ship')}
      <span class="fleet-slot-name">${ship.name}</span>
      <span class="fleet-slot-cost">${ship.cost}</span>
    </button>
  `;
}

function renderShipCatalogGrid(remaining: number): string {
  return `
    <div class="fleet-catalog-grid">
      ${SHIP_CATALOG.map((ship, index) => renderCatalogCard(ship.id, remaining, index)).join('')}
    </div>
  `;
}

function renderCatalogCard(shipId: ShipCatalogId, remaining: number, catalogIndex = 0): string {
  const ship = getShipCatalogEntry(shipId);
  const disabled = ship.cost > remaining ? 'disabled' : '';
  return `
    <button
      type="button"
      class="fleet-picker-ship"
      data-action="fleet-pick-ship"
      data-ship-id="${ship.id}"
      data-fleet-nav="picker"
      data-fleet-nav-index="${catalogIndex}"
      ${disabled}
    >
      ${renderShipThumb(ship.id, 'fleet-catalog-ship')}
      <div>
        <h3>${ship.name}</h3>
        <p>${ship.cost} pts</p>
      </div>
    </button>
  `;
}

function renderShipThumb(shipId: ShipCatalogId, className: string): string {
  const ship = getShipCatalogEntry(shipId);
  const overlay = ship.hud.shipOverlayKey
    ? `<img class="fleet-ship-overlay" src="${legacyAssets[ship.hud.shipOverlayKey].url}" alt="" aria-hidden="true" />`
    : '';
  return `
    <div class="fleet-ship-thumb ${className}" style="--fleet-ship-scale: ${ship.hud.shipScale};">
      <img src="${legacyAssets[ship.hud.shipKey].url}" alt="${ship.name} ship" />
      ${overlay}
    </div>
  `;
}

function isFleetBuilderPhase(): boolean {
  return appPhase.name === 'fleetBuild' || appPhase.name === 'networkFleetBuild';
}

function handleFleetBuilderKeyboardNav(event: KeyboardEvent): boolean {
  if (!isFleetBuilderPhase()) {
    return false;
  }

  const direction = readFleetBuilderKeyboardDirection(event.code);
  if (direction) {
    event.preventDefault();
    focusFleetBuilderNav(direction);
    return true;
  }

  if (event.code === 'Space' || event.code === 'Enter' || event.code === 'NumpadEnter') {
    event.preventDefault();
    activateFleetBuilderFocusedControl();
    return true;
  }

  if (event.code === 'KeyE' || event.code === 'KeyO' || event.code === 'Escape') {
    event.preventDefault();
    activateFleetBuilderBackControl();
    return true;
  }

  return false;
}

function updateFleetBuilderGamepadNav(): void {
  if (!isFleetBuilderPhase()) {
    previousFleetBuilderInput = 0;
    fleetBuilderNavRepeatFrames = 0;
    return;
  }

  const input = readGamepadMenuInput(0);
  const pressed = input & ~previousFleetBuilderInput;
  if (fleetBuilderNavRepeatFrames > 0) {
    fleetBuilderNavRepeatFrames -= 1;
  }

  const direction = readFleetBuilderInputDirection(pressed) ?? (fleetBuilderNavRepeatFrames === 0 ? readFleetBuilderInputDirection(input) : null);
  if (direction) {
    focusFleetBuilderNav(direction);
    fleetBuilderNavRepeatFrames = FLEET_NAV_REPEAT_FRAMES;
  } else if (input === 0) {
    fleetBuilderNavRepeatFrames = 0;
  }

  if ((pressed & MenuInputBits.Primary) !== 0) {
    activateFleetBuilderFocusedControl();
  } else if ((pressed & MenuInputBits.Secondary) !== 0) {
    activateFleetBuilderBackControl();
  }

  previousFleetBuilderInput = input;
}

function readFleetBuilderKeyboardDirection(code: string): FleetBuilderNavDirection | null {
  switch (code) {
    case 'ArrowUp':
    case 'KeyW':
      return 'up';
    case 'ArrowDown':
    case 'KeyS':
      return 'down';
    case 'ArrowLeft':
    case 'KeyA':
      return 'left';
    case 'ArrowRight':
    case 'KeyD':
      return 'right';
    default:
      return null;
  }
}

function readFleetBuilderInputDirection(input: number): FleetBuilderNavDirection | null {
  if ((input & MenuInputBits.Up) !== 0) {
    return 'up';
  }
  if ((input & MenuInputBits.Down) !== 0) {
    return 'down';
  }
  if ((input & MenuInputBits.Left) !== 0) {
    return 'left';
  }
  if ((input & MenuInputBits.Right) !== 0) {
    return 'right';
  }

  return null;
}

function queueFleetBuilderFocusRestore(): void {
  window.setTimeout(() => {
    if (isFleetBuilderPhase()) {
      restoreFleetBuilderFocus();
    }
  }, 0);
}

function restoreFleetBuilderFocus(): HTMLButtonElement | null {
  const activeButton = getActiveFleetBuilderButton();
  if (activeButton) {
    rememberFleetBuilderNavTarget(activeButton);
    return activeButton;
  }

  const buttons = getFleetBuilderNavButtons();
  const previousTarget = fleetBuilderNavTarget;
  const targetButton =
    (previousTarget
      ? buttons.find((button) => button.dataset.fleetNav === previousTarget.nav && Number(button.dataset.fleetNavIndex) === previousTarget.index)
      : null) ??
    buttons.find((button) => button.dataset.fleetNav === 'picker') ??
    buttons.find((button) => button.dataset.fleetNav === 'slot') ??
    buttons[0] ??
    null;

  targetButton?.focus();
  if (targetButton) {
    rememberFleetBuilderNavTarget(targetButton);
  }
  return targetButton;
}

function focusFleetBuilderNav(direction: FleetBuilderNavDirection): void {
  const buttons = getFleetBuilderNavButtons();
  const current = getActiveFleetBuilderButton() ?? restoreFleetBuilderFocus();
  if (!current) {
    return;
  }

  const currentRect = current.getBoundingClientRect();
  const currentCenter = getRectCenter(currentRect);
  let bestButton: HTMLButtonElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of buttons) {
    if (candidate === current) {
      continue;
    }

    const candidateRect = candidate.getBoundingClientRect();
    const candidateCenter = getRectCenter(candidateRect);
    const dx = candidateCenter.x - currentCenter.x;
    const dy = candidateCenter.y - currentCenter.y;
    const primaryDistance = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy);
    const secondaryDistance = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);

    if (!isCandidateInDirection(direction, dx, dy)) {
      continue;
    }

    const score = primaryDistance * 1.4 + secondaryDistance;
    if (score < bestScore) {
      bestScore = score;
      bestButton = candidate;
    }
  }

  if (bestButton) {
    bestButton.focus();
    rememberFleetBuilderNavTarget(bestButton);
  }
}

function activateFleetBuilderFocusedControl(): void {
  const button = getActiveFleetBuilderButton() ?? restoreFleetBuilderFocus();
  button?.click();
}

function activateFleetBuilderBackControl(): void {
  if (fleetBuilderPickingSlotIndex !== null) {
    cancelFleetBuilderShipPicker();
    return;
  }

  if (fleetBuilderConfirmingBack) {
    cancelFleetBuilderBackConfirmation();
    return;
  }

  const backButton = menuOverlay.querySelector<HTMLButtonElement>('button[data-action="fleet-back-request"]');
  backButton?.click();
}

function getActiveFleetBuilderButton(): HTMLButtonElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLButtonElement) || !menuOverlay.contains(active) || !active.dataset.fleetNav || active.disabled) {
    return null;
  }

  return active;
}

function getFleetBuilderNavButtons(): HTMLButtonElement[] {
  return Array.from(menuOverlay.querySelectorAll<HTMLButtonElement>('button[data-fleet-nav]')).filter((button) => !button.disabled);
}

function rememberFleetBuilderNavTarget(button: HTMLButtonElement): void {
  const index = Number(button.dataset.fleetNavIndex);
  fleetBuilderNavTarget = {
    nav: button.dataset.fleetNav ?? 'catalog',
    index: Number.isFinite(index) ? index : 0,
  };
}

function getRectCenter(rect: DOMRect): { readonly x: number; readonly y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function isCandidateInDirection(direction: FleetBuilderNavDirection, dx: number, dy: number): boolean {
  const threshold = 4;
  switch (direction) {
    case 'up':
      return dy < -threshold;
    case 'down':
      return dy > threshold;
    case 'left':
      return dx < -threshold;
    case 'right':
      return dx > threshold;
  }
}

function selectFleetBuilderSlot(slotIndex: number): void {
  if (appPhase.name !== 'fleetBuild' && appPhase.name !== 'networkFleetBuild') {
    return;
  }

  if (slotIndex !== appPhase.fleet.length || appPhase.fleet.length >= MAX_FLEET_SLOTS) {
    return;
  }

  fleetBuilderPickingSlotIndex = slotIndex;
  fleetBuilderConfirmingBack = false;
  fleetBuilderNavTarget = { nav: 'picker', index: 0 };
  renderMenu();
}

function cancelFleetBuilderShipPicker(): void {
  if (appPhase.name !== 'fleetBuild' && appPhase.name !== 'networkFleetBuild') {
    return;
  }

  const slotIndex = fleetBuilderPickingSlotIndex ?? appPhase.fleet.length;
  fleetBuilderPickingSlotIndex = null;
  fleetBuilderConfirmingBack = false;
  fleetBuilderNavTarget = { nav: 'slot', index: Math.min(slotIndex, MAX_FLEET_SLOTS - 1) };
  renderMenu();
}

function requestFleetBuilderBackConfirmation(): void {
  if (appPhase.name !== 'fleetBuild' && appPhase.name !== 'networkFleetBuild') {
    return;
  }

  fleetBuilderPickingSlotIndex = null;
  fleetBuilderConfirmingBack = true;
  fleetBuilderNavTarget = { nav: 'command', index: 1 };
  renderMenu();
}

function cancelFleetBuilderBackConfirmation(): void {
  if (appPhase.name !== 'fleetBuild' && appPhase.name !== 'networkFleetBuild') {
    return;
  }

  fleetBuilderConfirmingBack = false;
  fleetBuilderNavTarget = { nav: 'command', index: 1 };
  renderMenu();
}

function confirmFleetBuilderBack(): void {
  if (appPhase.name !== 'fleetBuild' && appPhase.name !== 'networkFleetBuild') {
    return;
  }

  fleetBuilderConfirmingBack = false;
  goBack();
}

function renderShipSelectMenu(phase: Extract<AppPhase, { readonly name: 'shipSelect' }>): string {
  const playerFleet = phase.session.fleets[0].filter((ship) => ship.alive);
  return `
    <section class="menu-card menu-card-wide">
      ${renderMenuBrand()}
      <p class="menu-kicker">Choose Your Champion</p>
      <h2>Select Ship</h2>
      <p>${phase.message ?? 'The loser picks a new ship. The winner stays in the arena.'}</p>
      <div class="ship-card-grid">
        ${playerFleet.map((fleetShip) => {
          const ship = getShipCatalogEntry(fleetShip.catalogId);
          return `
            <article class="ship-card">
              <h3>${ship.name}</h3>
              <p>Crew ${ship.crew} | Battery ${ship.battery}</p>
              <button type="button" data-action="ship-pick" data-fleet-uid="${fleetShip.uid}">Fight With ${ship.name}</button>
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderRoundResultMenu(phase: Extract<AppPhase, { readonly name: 'roundResult' }>): string {
  const winnerName = getSideName(phase.winnerId);
  const loserName = getSideName(phase.loserId);
  return `
    <section class="menu-card">
      ${renderMenuBrand()}
      <p class="menu-kicker">Round Complete</p>
      <h2>${winnerName} wins the duel</h2>
      <p>${loserName} lost a ship. Continue to the next matchup.</p>
      <div class="menu-actions">
        <button type="button" data-action="round-continue">Continue</button>
      </div>
    </section>
  `;
}

function renderFinalResultMenu(title: string, detail: string): string {
  return `
    <section class="menu-card">
      ${renderMenuBrand()}
      <p class="menu-kicker">Melee Complete</p>
      <h2>${title}</h2>
      <p>${detail}</p>
      <div class="menu-actions">
        <button type="button" data-action="final-main">Return To Main Menu</button>
      </div>
    </section>
  `;
}

function renderMultiplayerMenu(): string {
  return `
    <section class="menu-card">
      ${renderMenuBrand()}
      <p class="menu-kicker">Multiplayer</p>
      <h2>Find A Fight</h2>
      <p>Create a lobby with a point budget or join a hosted lobby. Fleets are built after the peer connection is ready.</p>
      <div class="menu-actions">
        ${currentUid ? '' : '<button type="button" data-action="sign-in">Sign In Anonymously</button>'}
        <button type="button" data-action="multi-host">Create Hosted Lobby</button>
        <button type="button" data-action="multi-join">Join Hosted Lobby</button>
        <button type="button" data-action="back">Back</button>
      </div>
    </section>
  `;
}

function renderLobbyBrowserMenu(): string {
  const visibleLobbies = getStandardMenuLobbies();
  const authText = currentUid ? 'Choose an open lobby.' : 'Sign in anonymously before joining a lobby.';
  return `
    <section class="menu-card menu-card-wide">
      ${renderMenuBrand()}
      <p class="menu-kicker">Hosted Lobbies</p>
      <h2>Join Multiplayer</h2>
      <p>${authText} You will build your fleet after connecting.</p>
      <div class="lobby-list menu-lobby-list">
        ${visibleLobbies.length === 0 ? '<p>No open lobbies yet.</p>' : visibleLobbies.map(renderMenuLobbyRow).join('')}
      </div>
      <div class="menu-actions">
        ${currentUid ? '' : '<button type="button" data-action="sign-in">Sign In Anonymously</button>'}
        <button type="button" data-action="back">Back</button>
      </div>
    </section>
  `;
}

function renderMenuLobbyRow(lobby: LobbyRecord): string {
  const isOwnLobby = lobby.hostUid === currentUid;
  return `
    <div class="lobby-row">
      <span>${lobby.status} | ${lobby.settings.pointTotal} pts | ${lobby.settings.draftMode}${isOwnLobby ? ' | local test' : ''}</span>
      <button type="button" data-action="join-lobby" data-lobby-id="${lobby.id}" ${!currentUid || lobby.status !== 'open' ? 'disabled' : ''}>Join</button>
    </div>
  `;
}

function pickJoinableDevLobby(openLobbies: readonly LobbyRecord[]): LobbyRecord | null {
  const candidates = openLobbies.filter((lobby) => {
    if (getLobbyKind(lobby) !== 'dev' || lobby.status !== 'open' || lobby.expiresAt <= Date.now()) {
      return false;
    }
    // Skip the lobby this same window is currently hosting (cross-window same-browser
    // testing in incognito uses a different UID, but a single window must not join
    // itself).
    if (currentHostLobbyId === lobby.id) {
      return false;
    }
    return true;
  });
  if (candidates.length === 0) {
    return null;
  }

  // Prefer the freshest lobby. Stale dev lobbies abandoned via the Escape menu can
  // sit in Firebase up to ~5 minutes; without this preference we'd pick the orphan
  // over the host the user just spun up.
  return candidates.reduce((newest, current) =>
    current.expiresAt > newest.expiresAt ? current : newest,
  );
}

function findDevLobby(repository: LobbyRepository, timeoutMs: number): Promise<LobbyRecord | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let cleanup: (() => void) | null = null;

    const finalize = (lobby: LobbyRecord | null): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup?.();
      window.clearTimeout(timeoutId);
      resolve(lobby);
    };

    const timeoutId = window.setTimeout(() => finalize(null), timeoutMs);

    cleanup = repository.observeOpenLobbies((openLobbies) => {
      const match = pickJoinableDevLobby(openLobbies);
      if (match) {
        finalize(match);
      }
    });
  });
}

function renderNetworkConnectingMenu(phase: Extract<AppPhase, { readonly name: 'networkConnecting' }>): string {
  return `
    <section class="menu-card">
      ${renderMenuBrand()}
      <p class="menu-kicker">Multiplayer</p>
      <h2>${phase.role === 'host' ? 'Waiting For Joiner' : 'Joining Lobby'}</h2>
      <p>Lobby ${phase.lobbyId} | ${phase.budget} pts | Peer ${peerConnectionState}</p>
      <div class="menu-actions">
        <button type="button" data-action="back">Leave Lobby</button>
      </div>
    </section>
  `;
}

function renderMenuBrand(): string {
  return `
    <img class="menu-logo" src="${legacyAssets.mainScreen.url}" alt="SkPow" />
  `;
}

function addShipToPlayerFleet(shipId: ShipCatalogId): void {
  if (appPhase.name !== 'fleetBuild' && appPhase.name !== 'networkFleetBuild') {
    return;
  }

  if (appPhase.fleet.length >= MAX_FLEET_SLOTS) {
    return;
  }

  const ship = getShipCatalogEntry(shipId);
  if (ship.cost > getRemainingBudget(appPhase.fleet, appPhase.budget)) {
    return;
  }

  fleetSerial += 1;
  appPhase = {
    ...appPhase,
    fleet: [...appPhase.fleet, { uid: `player-${fleetSerial}`, catalogId: shipId, alive: true }],
  };
  fleetBuilderPickingSlotIndex = null;
  fleetBuilderConfirmingBack = false;
  fleetBuilderNavTarget = { nav: 'slot', index: Math.min(appPhase.fleet.length, MAX_FLEET_SLOTS - 1) };
  renderMenu();
}

function removeShipFromPlayerFleet(uid: string): void {
  if (appPhase.name !== 'fleetBuild' && appPhase.name !== 'networkFleetBuild') {
    return;
  }

  appPhase = {
    ...appPhase,
    fleet: appPhase.fleet.filter((ship) => ship.uid !== uid),
  };
  fleetBuilderPickingSlotIndex = null;
  fleetBuilderConfirmingBack = false;
  renderMenu();
}

function startSinglePlayerRun(): void {
  if (appPhase.name !== 'fleetBuild' || appPhase.fleet.length === 0) {
    return;
  }

  const aiFleet = generateRandomFleet(appPhase.budget, 'ai');
  const aiShip = chooseRandomLivingShip(aiFleet);
  if (!aiShip) {
    appPhase = { name: 'finalResult', title: 'Player wins', detail: 'The AI could not field a ship.' };
    renderMenu();
    return;
  }

  const session: BattleSession = {
    budget: appPhase.budget,
    fleets: [appPhase.fleet, aiFleet],
    selectedShipUids: [null, aiShip.uid],
  };
  appPhase = { name: 'shipSelect', session, message: 'Pick the first ship for your fleet.' };
  renderMenu();
}

function readyNetworkFleet(): void {
  if (appPhase.name !== 'networkFleetBuild' || appPhase.fleet.length === 0) {
    return;
  }

  const selectedShip = appPhase.fleet[0].catalogId;
  const selectedName = getShipCatalogEntry(selectedShip).name;
  const { role, budget, lobbyId } = appPhase;

  if (role === 'joiner') {
    currentLoadout = [DEFAULT_MATCH_SHIPS[0], selectedShip];
    renderer.setShipLoadout(currentLoadout);
    renderHud(currentLoadout);
    networkMatch = new NetworkMatchSession('joiner', { readyImmediately: true });
    networkMatchStatus = networkMatch.status;
    presentationCorrection = null;
    if (!peerSession?.sendControlMessage(`selectedShip:${selectedShip}`)) {
      log('Could not send selected ship to host yet.');
    }
    log(`Ready with ${selectedName}. Waiting for host config...`);
    appPhase = { name: 'networkConnecting', role, budget, lobbyId };
    renderMenu();
    return;
  }

  pendingHostShip = selectedShip;
  log(`Ready with ${selectedName}. Waiting for joiner...`);
  appPhase = { name: 'networkConnecting', role, budget, lobbyId };
  renderMenu();
  startNetworkMatchWhenReady(role, budget, lobbyId);
}

function autoReadyAiJoiner(budget: number, lobbyId: string): void {
  const selectedShip = chooseRandomCatalogShip();
  currentLoadout = [DEFAULT_MATCH_SHIPS[0], selectedShip];
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
  networkMatch = new NetworkMatchSession('joiner', { readyImmediately: true });
  networkMatchStatus = networkMatch.status;
  presentationCorrection = null;
  if (!peerSession?.sendControlMessage(`selectedShip:${selectedShip}`)) {
    log('Could not send AI joiner selected ship to host yet.');
  }
  appPhase = { name: 'networkConnecting', role: 'joiner', budget, lobbyId };
  renderMenu();
  log(`AI joiner auto-ready with ${getShipCatalogEntry(selectedShip).name}. Waiting for host config...`);
}

function choosePlayerShip(uid: string): void {
  if (appPhase.name !== 'shipSelect') {
    return;
  }

  const session = withSelectedShip(appPhase.session, 0, uid);
  const aiSelectedUid = session.selectedShipUids[1] ?? chooseRandomLivingShip(session.fleets[1])?.uid ?? null;
  if (!aiSelectedUid) {
    appPhase = { name: 'finalResult', title: 'Player wins', detail: 'The enemy has no ships remaining.' };
    renderMenu();
    return;
  }

  startLocalFight(withSelectedShip(session, 1, aiSelectedUid));
}

function startLocalFight(session: BattleSession): void {
  const playerShip = getSelectedFleetShip(session, 0);
  const opponentShip = getSelectedFleetShip(session, 1);
  if (!playerShip || !opponentShip) {
    appPhase = { name: 'shipSelect', session, message: 'Pick a living ship before fighting.' };
    renderMenu();
    return;
  }

  closePeer();
  currentLoadout = [playerShip.catalogId, opponentShip.catalogId];
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
  state = createInitialState(Date.now() >>> 0, currentLoadout);
  appPhase = { name: 'fighting', session, handledWinnerId: null };
  renderMenu();
}

function resolveLocalRound(session: BattleSession, winnerId: number): void {
  const loserId = winnerId === 0 ? 1 : 0;
  const loserShipUid = session.selectedShipUids[loserId];
  const nextFleets = session.fleets.map((fleet, sideId) =>
    sideId === loserId ? fleet.map((ship) => (ship.uid === loserShipUid ? { ...ship, alive: false } : ship)) : fleet,
  ) as [readonly FleetShip[], readonly FleetShip[]];
  const nextSession: BattleSession = {
    ...session,
    fleets: nextFleets,
    selectedShipUids: loserId === 0 ? [null, session.selectedShipUids[1]] : [session.selectedShipUids[0], null],
  };

  if (!hasLivingShips(nextSession.fleets[loserId])) {
    appPhase = {
      name: 'finalResult',
      title: `${getSideName(winnerId)} wins`,
      detail: `${getSideName(loserId)} has no ships remaining.`,
    };
  } else {
    appPhase = { name: 'roundResult', session: nextSession, winnerId, loserId };
  }
  renderMenu();
}

function resolveLocalMutualDestruction(session: BattleSession): void {
  const eliminated = new Set(session.selectedShipUids.filter((uid): uid is string => uid !== null));
  const nextFleets: [readonly FleetShip[], readonly FleetShip[]] = [
    session.fleets[0].map((ship) => (eliminated.has(ship.uid) ? { ...ship, alive: false } : ship)),
    session.fleets[1].map((ship) => (eliminated.has(ship.uid) ? { ...ship, alive: false } : ship)),
  ];
  const nextSession: BattleSession = {
    ...session,
    fleets: nextFleets,
    selectedShipUids: [null, null],
  };
  const playerAlive = hasLivingShips(nextSession.fleets[0]);
  const aiAlive = hasLivingShips(nextSession.fleets[1]);

  if (!playerAlive && !aiAlive) {
    appPhase = { name: 'finalResult', title: 'Draw', detail: 'Both fleets were destroyed.' };
  } else if (!playerAlive) {
    appPhase = { name: 'finalResult', title: 'AI wins', detail: 'Both ships were destroyed, and you have no ships remaining.' };
  } else if (!aiAlive) {
    appPhase = { name: 'finalResult', title: 'Player wins', detail: 'Both ships were destroyed, and the AI has no ships remaining.' };
  } else {
    appPhase = { name: 'shipSelect', session: nextSession, message: 'Both ships were destroyed. Pick a new ship.' };
  }

  renderMenu();
}

function continueAfterRound(): void {
  if (appPhase.name !== 'roundResult') {
    return;
  }

  if (appPhase.loserId === 0) {
    appPhase = {
      name: 'shipSelect',
      session: appPhase.session,
      message: 'You lost that ship. Pick a new one to challenge the winner.',
    };
    renderMenu();
    return;
  }

  const nextAiShip = chooseRandomLivingShip(appPhase.session.fleets[1]);
  if (!nextAiShip) {
    appPhase = { name: 'finalResult', title: 'Player wins', detail: 'The AI has no ships remaining.' };
    renderMenu();
    return;
  }

  startLocalFight(withSelectedShip(appPhase.session, 1, nextAiShip.uid));
}

function startAiDemoRound(round: number): void {
  closePeer();
  currentLoadout = [chooseRandomCatalogShip(), chooseRandomCatalogShip()];
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
  state = createInitialState(Date.now() >>> 0, currentLoadout);
  appPhase = { name: 'aiDemo', round };
  log(`Attract Mode round ${round}: ${getShipCatalogEntry(currentLoadout[0]).name} vs ${getShipCatalogEntry(currentLoadout[1]).name}`);
  renderMenu();
}

function isAiDemoRoundComplete(nextState: GameState): boolean {
  return getMatchOutcome(nextState).kind !== 'active' || nextState.frame >= AI_DEMO_ROUND_FRAMES;
}

function getMatchOutcome(nextState: GameState | null): MatchOutcome {
  if (!nextState) {
    return { kind: 'active' };
  }

  if (nextState.winnerId !== null) {
    return { kind: 'winner', winnerId: nextState.winnerId };
  }

  return nextState.ships.every((ship) => !ship.alive) ? { kind: 'draw' } : { kind: 'active' };
}

function chooseRandomCatalogShip(): ShipCatalogId {
  return SHIP_CATALOG[Math.floor(Math.random() * SHIP_CATALOG.length)].id;
}

function chooseRandomNetworkAiLoadout(): MatchLoadout {
  return [chooseRandomCatalogShip(), chooseRandomCatalogShip()];
}

function generateRandomFleet(budget: number, prefix: string): readonly FleetShip[] {
  const fleet: FleetShip[] = [];
  let remaining = budget;
  let safety = 100;

  while (safety > 0) {
    safety -= 1;
    const affordable = SHIP_CATALOG.filter((ship) => ship.cost <= remaining);
    if (affordable.length === 0) {
      break;
    }

    const ship = affordable[Math.floor(Math.random() * affordable.length)];
    fleetSerial += 1;
    fleet.push({ uid: `${prefix}-${fleetSerial}`, catalogId: ship.id, alive: true });
    remaining -= ship.cost;
  }

  return fleet;
}

async function startLaggyMpHost(): Promise<void> {
  if (!ensureMultiplayerReady('Cannot start Laggy MP Host right now.')) {
    return;
  }

  networkDebugSettings = { ...networkDebugSettings, aiHost: true, aiJoiner: false };
  maybeApplyMpAiImpairmentDefaults(true);

  try {
    await createHostLobby(currentUid as string, lobbyRepository as LobbyRepository, LAGGY_MP_BUDGET, 'dev');
  } catch (error) {
    const detail = readError(error);
    log(`Failed to create Laggy MP Host lobby: ${detail}`);
    showPopup('Could Not Start Laggy MP Host', `Lobby creation failed: ${detail}`);
  }
}

async function startLaggyMpClient(): Promise<void> {
  if (!ensureMultiplayerReady('Cannot start Laggy MP Client right now.')) {
    return;
  }

  laggyMpClientButton.disabled = true;
  try {
    const repository = lobbyRepository as LobbyRepository;
    const target = pickJoinableDevLobby(lobbies) ?? (await findDevLobby(repository, LAGGY_MP_FIND_TIMEOUT_MS));
    if (!target) {
      showPopup(
        'No Laggy MP Host Found',
        'Open another window, click Laggy MP Host first, then try Laggy MP Client.',
      );
      return;
    }

    networkDebugSettings = { ...networkDebugSettings, aiHost: false, aiJoiner: true };
    maybeApplyMpAiImpairmentDefaults(true);

    try {
      await joinLobby(target.id, currentUid as string, repository);
    } catch (error) {
      const detail = readError(error);
      log(`Failed to join Laggy MP Host lobby: ${detail}`);
      showPopup('Could Not Join Laggy MP Host', `Joining the dev lobby failed: ${detail}`);
    }
  } finally {
    laggyMpClientButton.disabled = false;
  }
}

async function hostLobbyFromMenu(budget: number): Promise<void> {
  if (!ensureMultiplayerReady('Cannot create a hosted lobby right now.')) {
    return;
  }

  clearAiOverrides();

  try {
    await createHostLobby(currentUid as string, lobbyRepository as LobbyRepository, budget);
  } catch (error) {
    const detail = readError(error);
    log(`Failed to create lobby: ${detail}`);
    showPopup('Could Not Create Lobby', `Lobby creation failed: ${detail}`);
  }
}

async function joinLobbyFromMenu(lobbyId: string): Promise<void> {
  if (!ensureMultiplayerReady('Cannot join a hosted lobby right now.')) {
    return;
  }

  clearAiOverrides();

  try {
    await joinLobby(lobbyId, currentUid as string, lobbyRepository as LobbyRepository);
  } catch (error) {
    const detail = readError(error);
    log(`Failed to join lobby: ${detail}`);
    showPopup('Could Not Join Lobby', `Joining the lobby failed: ${detail}`);
  }
}

function clearAiOverrides(): void {
  if (!networkDebugSettings.aiHost && !networkDebugSettings.aiJoiner) {
    return;
  }
  networkDebugSettings = { ...networkDebugSettings, aiHost: false, aiJoiner: false };
}

function ensureMultiplayerReady(actionDescription: string): boolean {
  if (!isFirebaseConfigured() || !lobbyRepository) {
    showPopup(
      'Multiplayer Unavailable',
      `${actionDescription} Firebase is not configured for this build, so online lobbies are disabled.`,
    );
    return false;
  }

  if (!currentUid) {
    showPopup(
      'Sign In Required',
      `${actionDescription} Sign in anonymously from the multiplayer menu and try again.`,
    );
    return false;
  }

  return true;
}

function renderLobbies(): void {
  lobbyList.innerHTML = '';

  if (!lobbyRepository) {
    return;
  }

  const visibleLobbies = getDevPanelLobbies();
  if (visibleLobbies.length === 0) {
    lobbyList.textContent = 'No open lobbies yet.';
    return;
  }

  for (const lobby of visibleLobbies) {
    const row = document.createElement('div');
    row.className = 'lobby-row';
    const label = document.createElement('span');
    const isOwnLobby = lobby.hostUid === currentUid;
    const kindBadge = formatLobbyKindBadge(getLobbyKind(lobby));
    label.textContent = `${kindBadge} | ${lobby.status} | ${lobby.settings.pointTotal} pts | ${lobby.settings.draftMode}${isOwnLobby ? ' | local test' : ''}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Join';
    button.disabled = !currentUid || lobby.status !== 'open';
    button.addEventListener('click', () => {
      if (currentUid) {
        void joinLobby(lobby.id, currentUid, lobbyRepository);
      }
    });
    row.append(label, button);
    lobbyList.append(row);
  }
}

function updateLobbyObserver(): void {
  const shouldObserve = appPhase.name === 'lobbyBrowser' && currentUid !== null && lobbyRepository !== null;

  if (!shouldObserve) {
    if (cleanupLobbyObserver) {
      cleanupLobbyObserver();
      cleanupLobbyObserver = null;
      lobbies = [];
      renderLobbies();
    }
    return;
  }

  if (cleanupLobbyObserver) {
    return;
  }

  cleanupLobbyObserver = (lobbyRepository as LobbyRepository).observeOpenLobbies((nextLobbies) => {
    lobbies = nextLobbies;
    renderLobbies();
    renderMenu();
  });
}

async function createHostLobby(
  uid: string,
  repository: LobbyRepository,
  budget: number,
  kind: LobbyKind = 'standard',
): Promise<void> {
  cleanupHostLobbyIfOwned();
  const lobbyId = await repository.createLobby(uid, { pointTotal: budget, draftMode: 'open', kind });
  currentHostLobbyId = lobbyId;
  log(`Created ${kind} lobby ${lobbyId}. Waiting for a joiner...`);
  if (peerSession) {
    suppressPeerDisconnectPopup = true;
    peerSession.close();
  }
  networkMatch = null;
  networkMatchStatus = null;
  pendingHostShip = null;
  pendingJoinerShip = null;
  suppressPeerDisconnectPopup = false;
  peerSession = createPeerSession('host', lobbyId, repository, budget);
  appPhase = { name: 'networkConnecting', role: 'host', budget, lobbyId };
  renderMenu();
  await peerSession.start();
}

async function joinLobby(lobbyId: string, uid: string, repository: LobbyRepository): Promise<void> {
  const lobby = lobbies.find((item) => item.id === lobbyId);
  const budget = lobby?.settings.pointTotal ?? 100;
  log(`Joining lobby ${lobbyId}...`);
  const claim = await repository.claimLobby(lobbyId, uid);
  if (!claim.success) {
    const detail = claim.detail ? ` (${claim.detail})` : '';
    log(`Could not claim lobby ${lobbyId}: ${claim.reason}${detail}`);
    if (claim.observedLobby !== undefined) {
      log(`Observed lobby state: ${JSON.stringify(claim.observedLobby)}`);
    }
    if (claim.committedSnapshot !== undefined) {
      log(`Post-transaction snapshot: ${JSON.stringify(claim.committedSnapshot)}`);
    }
    showPopup('Lobby Unavailable', `Could not claim lobby (${claim.reason}). See debug log for details.`);
    return;
  }

  if (peerSession) {
    suppressPeerDisconnectPopup = true;
    peerSession.close();
  }
  networkMatch = null;
  networkMatchStatus = null;
  suppressPeerDisconnectPopup = false;
  peerSession = createPeerSession('joiner', lobbyId, repository, budget);
  appPhase = { name: 'networkConnecting', role: 'joiner', budget, lobbyId };
  renderMenu();
  await peerSession.start();
}

function createPeerSession(
  role: ConnectionRole,
  lobbyId: string,
  repository: LobbyRepository,
  budget: number,
): PeerConnectionSession {
  let session: PeerConnectionSession;
  const isStale = (): boolean => peerSession !== session;

  session = new PeerConnectionSession(role, lobbyId, repository, {
    onStateChange: (connectionState: ConnectionState) => {
      if (isStale()) {
        return;
      }

      peerConnectionState = connectionState;
      if (connectionState === 'connected' && !networkMatch) {
        startNetworkMatchWhenReady(role, budget, lobbyId);
      }

      if (connectionState === 'closed' || connectionState === 'failed') {
        const wasInActiveFlow =
          appPhase.name === 'networkFight' ||
          appPhase.name === 'networkConnecting' ||
          appPhase.name === 'networkFleetBuild';
        networkMatch = null;
        networkMatchStatus = null;
        if (wasInActiveFlow) {
          appPhase = { name: 'multiplayerMenu' };
        }

        if (wasInActiveFlow && !suppressPeerDisconnectPopup) {
          if (connectionState === 'failed') {
            showPopup(
              'Connection Failed',
              'The peer connection failed before the match could continue. Returning to the multiplayer menu.',
            );
          } else {
            showPopup(
              'Connection Closed',
              'The peer connection closed unexpectedly. Returning to the multiplayer menu.',
            );
          }
        }
      }

      updatePeerStatus();
      renderMenu();
      log(`Peer state changed to ${connectionState}.`);
    },
    onControlMessage: (message) => {
      if (isStale()) {
        return;
      }
      handleNetworkControlMessage(role, budget, lobbyId, message);
    },
    onGameplayMessage: (message) => {
      if (isStale()) {
        return;
      }
      if (!networkMatch) {
        log('Received gameplay packet before match session was ready.');
        return;
      }

      try {
        const isSessionConfig = message[1] === GameplayPacketType.SessionConfig;
        if (isSessionConfig) {
          clearPendingGameplayPackets();
        }
        const previousState = networkMatch.currentState;
        networkMatchStatus = networkMatch.receiveGameplayMessage(message);
        maybeStartPresentationCorrection(previousState, networkMatch);
        sendGameplayPackets(networkMatch.takeOutgoingPackets());
        networkMatchStatus = networkMatch.status;
        syncNetworkLoadoutFromMatch();
        if (isSessionConfig) {
          appPhase = { name: 'networkFight', handledWinnerId: null };
          renderMenu();
        }
        updatePeerStatus();
      } catch (error) {
        log(`Gameplay packet failed: ${readError(error)}`);
      }
    },
  });
  return session;
}

function startNetworkMatchWhenReady(role: ConnectionRole, budget: number, lobbyId: string): void {
  if (networkMatch) {
    return;
  }

  if (role === 'joiner') {
    if (networkDebugSettings.aiJoiner) {
      autoReadyAiJoiner(budget, lobbyId);
      return;
    }
    if (appPhase.name !== 'networkFleetBuild') {
      appPhase = { name: 'networkFleetBuild', role, budget, lobbyId, fleet: [] };
      renderMenu();
    }
    log(`Network match using ${budget} point lobby budget. Build your fleet, then ready up.`);
    return;
  }

  const aiHost = networkDebugSettings.aiHost;
  if (!aiHost && !pendingHostShip) {
    if (appPhase.name !== 'networkFleetBuild') {
      appPhase = { name: 'networkFleetBuild', role, budget, lobbyId, fleet: [] };
      renderMenu();
    }
    log(`Network match using ${budget} point lobby budget. Build your fleet, then wait for both players to ready up.`);
    return;
  }

  if (!aiHost && !pendingJoinerShip) {
    log(`Network match using ${budget} point lobby budget. Waiting for joiner's fleet...`);
    return;
  }

  log(`Network match using ${budget} point lobby budget.`);
  networkAiRound = 0;
  currentLoadout = aiHost ? chooseRandomNetworkAiLoadout() : [pendingHostShip ?? DEFAULT_MATCH_SHIPS[0], pendingJoinerShip ?? DEFAULT_MATCH_SHIPS[1]];
  const seed = Date.now() >>> 0;
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
  state = createInitialState(seed, currentLoadout);
  networkMatch = new NetworkMatchSession('host', {
    roundId: networkAiRound,
    seed,
    loadout: currentLoadout,
    aiDemo: aiHost,
    readyImmediately: true,
  });
  presentationCorrection = null;
  sendGameplayPackets(networkMatch.takeOutgoingPackets());
  networkMatchStatus = networkMatch.status;
  appPhase = { name: 'networkFight', handledWinnerId: null };
  renderMenu();
  log(`Network debug: ${formatNetworkDebugSettings(role)}`);
  log(`Network loadout: ${getShipCatalogEntry(currentLoadout[0]).name} vs ${getShipCatalogEntry(currentLoadout[1]).name}`);
}

function handleNetworkControlMessage(role: ConnectionRole, budget: number, lobbyId: string, message: string): void {
  const selectedShipPrefix = 'selectedShip:';
  if (role === 'host' && message.startsWith(selectedShipPrefix)) {
    const shipId = message.slice(selectedShipPrefix.length);
    if (isShipCatalogId(shipId)) {
      pendingJoinerShip = shipId;
      log(`Joiner selected ${getShipCatalogEntry(shipId).name}.`);
      startNetworkMatchWhenReady(role, budget, lobbyId);
      return;
    }
  }

  log(`Control message: ${message}`);
}

function closePeer(): void {
  clearPendingGameplayPackets();
  presentationCorrection = null;
  const hadPeer = peerSession !== null;
  if (hadPeer) {
    suppressPeerDisconnectPopup = true;
  }
  peerSession?.close();
  peerSession = null;
  networkMatch = null;
  networkMatchStatus = null;
  pendingHostShip = null;
  pendingJoinerShip = null;
  if (hadPeer) {
    peerConnectionState = 'closed';
  }
  suppressPeerDisconnectPopup = false;
  updatePeerStatus();
}

function sendGameplayPackets(packets: readonly Uint8Array[]): void {
  for (const packet of packets) {
    sendGameplayPacket(packet);
  }
}

function sendGameplayPacket(packet: Uint8Array): void {
  const activePeer = peerSession;
  if (!activePeer) {
    return;
  }

  if (packet[1] === GameplayPacketType.SessionConfig) {
    activePeer.sendGameplayMessage(packet);
    return;
  }

  const settings = getPacketImpairmentSettings();
  if (!settings || !shouldImpairPacket(settings)) {
    activePeer.sendGameplayMessage(packet);
    return;
  }

  if (settings.dropPct > 0 && Math.random() * 100 < settings.dropPct) {
    return;
  }

  const delayMs = settings.delayMs + (settings.jitterMs > 0 ? Math.round(Math.random() * settings.jitterMs) : 0);
  if (delayMs <= 0) {
    activePeer.sendGameplayMessage(packet);
    return;
  }

  const timerId = window.setTimeout(() => {
    pendingGameplayTimers.delete(timerId);
    activePeer.sendGameplayMessage(packet);
  }, delayMs);
  pendingGameplayTimers.add(timerId);
}

function getPacketImpairmentSettings(): PacketImpairmentSettings | null {
  return networkMatch ? networkDebugSettings.localImpairment : null;
}

function shouldImpairPacket(settings: PacketImpairmentSettings): boolean {
  return settings.delayMs > 0 || settings.jitterMs > 0 || settings.dropPct > 0;
}

function clearPendingGameplayPackets(): void {
  for (const timerId of pendingGameplayTimers) {
    window.clearTimeout(timerId);
  }
  pendingGameplayTimers.clear();
}

function log(message: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  debugLog.textContent = `${line}\n${debugLog.textContent ?? ''}`.slice(0, 4000);
}

function formatNetworkDebugSettings(_role: ConnectionRole): string {
  const impairment = networkDebugSettings.localImpairment;
  const aiText = `AI host ${networkDebugSettings.aiHost ? 'on' : 'off'}, AI joiner ${networkDebugSettings.aiJoiner ? 'on' : 'off'}`;
  return `${aiText}; outgoing ${formatPacketImpairment(impairment)}`;
}

function formatPacketImpairment(settings: PacketImpairmentSettings): string {
  return `${settings.delayMs}ms delay + ${settings.jitterMs}ms jitter, ${settings.dropPct}% drop`;
}

function updateInputStatus(): void {
  const status = readInputDeviceStatus();
  const gamepadText =
    status.gamepads.length > 0
      ? status.gamepads.map((gamepad, index) => formatGamepadStatus(gamepad, index)).join(' | ')
      : 'No controller detected';
  const keyboardText = status.keyboardActive ? 'Keyboard active' : 'Keyboard idle';
  const nextText = `${keyboardText} | ${gamepadText}`;
  const nextDebugText = status.gamepads.length > 0 ? gamepadText : '';

  if (nextText !== lastInputStatusText) {
    lastInputStatusText = nextText;
    inputStatus.textContent = nextText;
  }

  if (nextDebugText && nextDebugText !== lastInputDebugText) {
    lastInputDebugText = nextDebugText;
    log(`Input debug: ${nextDebugText}`);
  }
}

function maybeUpdateInputStatus(): void {
  inputStatusRenderTick = (inputStatusRenderTick + 1) % 15;
  if (inputStatusRenderTick === 0) {
    updateInputStatus();
  }
}

function formatGamepadStatus(
  gamepad: ReturnType<typeof readInputDeviceStatus>['gamepads'][number],
  index: number,
): string {
  const buttonText =
    gamepad.pressedButtons.length > 0
      ? gamepad.pressedButtons.map(formatPressedButton).join(', ')
      : 'none';

  return `Controller ${index + 1}: ${gamepad.id} | buttons pressed: ${buttonText}`;
}

function formatPressedButton(button: ReturnType<typeof readInputDeviceStatus>['gamepads'][number]['pressedButtons'][number]): string {
  return `${button.index} ${button.label}=${button.value.toFixed(2)}`;
}

function updatePeerStatus(): void {
  peerSummary.textContent = formatPeerSummary(peerConnectionState, networkMatchStatus);
  peerStatus.textContent = formatPeerStatus(peerConnectionState, networkMatchStatus);
  updateNetworkRecoveryOverlay();
}

function updateNetworkRecoveryOverlay(): void {
  const shouldShow = appPhase.name === 'networkFight' && networkMatchStatus?.paused === true;
  networkRecoveryOverlay.classList.toggle('network-recovery-overlay-hidden', !shouldShow);
  if (shouldShow) {
    networkRecoveryMessage.textContent = networkMatchStatus?.recoveryWaitingForPeer
      ? 'Snapshots reconciled. Waiting for the peer to finish resync...'
      : 'Connection recovered or stalled. Exchanging snapshots before play resumes...';
  }
}

function updateArenaHint(): void {
  const hintText = getArenaHintText();
  arenaHint.classList.toggle('arena-hint-hidden', hintText === null);
  if (hintText !== null) {
    arenaHint.textContent = hintText;
  }
}

function getArenaHintText(): string | null {
  if (appPhase.name === 'aiDemo' || appPhase.name === 'fighting' || appPhase.name === 'networkFight') {
    return 'ESC for menu';
  }

  return null;
}

function showPopup(title: string, message: string): void {
  popupTitle.textContent = title;
  popupMessage.textContent = message;
  popupOverlay.classList.remove('popup-overlay-hidden');
  window.setTimeout(() => popupDismissButton.focus(), 0);
}

function hidePopup(): void {
  popupOverlay.classList.add('popup-overlay-hidden');
}

function isPauseMenuAvailable(): boolean {
  return appPhase.name !== 'loading' && appPhase.name !== 'mainMenu';
}

function openPauseMenu(): void {
  if (!isPauseMenuAvailable() || pauseMenuOpen) {
    return;
  }
  pauseMenuOpen = true;
  pauseOverlay.classList.remove('pause-overlay-hidden');
  window.setTimeout(() => pauseResumeButton.focus(), 0);
}

function closePauseMenu(): void {
  if (!pauseMenuOpen) {
    return;
  }
  pauseMenuOpen = false;
  pauseOverlay.classList.add('pause-overlay-hidden');
}

function togglePauseMenu(): void {
  if (pauseMenuOpen) {
    closePauseMenu();
    return;
  }
  openPauseMenu();
}

function cleanupHostLobbyIfOwned(): void {
  const lobbyId = currentHostLobbyId;
  currentHostLobbyId = null;
  if (!lobbyId || !lobbyRepository) {
    return;
  }
  void lobbyRepository
    .deleteLobby(lobbyId)
    .catch((error) => log(`Could not delete abandoned lobby ${lobbyId}: ${readError(error)}`));
}

function quitToMainMenu(): void {
  closePauseMenu();
  cleanupHostLobbyIfOwned();
  closePeer();
  currentLoadout = DEFAULT_MATCH_SHIPS;
  state = createInitialState(undefined, currentLoadout);
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
  appPhase = { name: 'mainMenu' };
  renderMenu();
}

function leaveLobby(): void {
  if (appPhase.name !== 'networkConnecting') {
    return;
  }

  cleanupHostLobbyIfOwned();
  closePeer();
  appPhase = { name: 'multiplayerMenu' };
  renderMenu();
}

function leaveMatch(): void {
  if (appPhase.name !== 'networkFleetBuild') {
    return;
  }

  closePeer();
  appPhase = { name: 'multiplayerMenu' };
  renderMenu();
}

function goBack(): void {
  switch (appPhase.name) {
    case 'singleBudget':
      appPhase = { name: 'mainMenu' };
      break;
    case 'fleetBuild':
      appPhase = { name: 'singleBudget' };
      break;
    case 'multiplayerMenu':
      appPhase = { name: 'mainMenu' };
      break;
    case 'hostSetup':
    case 'lobbyBrowser':
      appPhase = { name: 'multiplayerMenu' };
      break;
    case 'networkConnecting':
      leaveLobby();
      return;
    case 'networkFleetBuild':
      leaveMatch();
      return;
    default:
      return;
  }
  renderMenu();
}

function formatPeerSummary(connectionState: ConnectionState, status: NetworkMatchStatus | null): string {
  if (!status) {
    return `Peer: ${connectionState}`;
  }

  const readyState = status.ready ? 'ready' : 'handshaking';
  const ownerState = status.lastOwnerStateFrame === null ? 'owner pending' : `owner ${status.lastOwnerStateFrame}`;
  if (status.paused) {
    if (status.recoveryWaitingForPeer) {
      return `Peer: ${connectionState} | ${readyState} | Recovery finishing | ${ownerState}`;
    }
    return `Peer: ${connectionState} | ${readyState} | Network recovery paused | ${ownerState}`;
  }
  return `Peer: ${connectionState} | ${readyState} | ${ownerState}`;
}

function formatMatchStatus(renderState: GameState): string {
  if (appPhase.name !== 'fighting' && appPhase.name !== 'networkFight' && appPhase.name !== 'aiDemo') {
    return formatPhaseStatus();
  }

  if (getMatchOutcome(renderState).kind === 'draw') {
    return 'Both ships destroyed';
  }

  if (renderState.winnerId === null) {
    if (appPhase.name === 'networkFight') {
      if (networkMatchStatus?.paused) {
        if (networkMatchStatus.recoveryWaitingForPeer) {
          return 'Network recovery finishing';
        }
        return 'Network recovery paused';
      }
      return 'Online match active';
    }
    if (appPhase.name === 'aiDemo') {
      const remainingSeconds = Math.max(0, Math.ceil((AI_DEMO_ROUND_FRAMES - renderState.frame) / SIM_FPS));
      return `Attract Mode round ${appPhase.round} | ${remainingSeconds}s until reroll`;
    }
    return 'Match active';
  }

  return `Match over | Player ${renderState.winnerId + 1} wins`;
}

function formatPhaseStatus(): string {
  switch (appPhase.name) {
    case 'loading':
      return 'Loading assets';
    case 'mainMenu':
      return 'Main menu';
    case 'singleBudget':
    case 'fleetBuild':
    case 'shipSelect':
      return 'Single player setup';
    case 'roundResult':
    case 'finalResult':
    case 'networkResult':
      return 'Match complete';
    case 'multiplayerMenu':
    case 'hostSetup':
    case 'lobbyBrowser':
    case 'networkConnecting':
    case 'networkFleetBuild':
      return 'Multiplayer setup';
    case 'fighting':
    case 'aiDemo':
    case 'networkFight':
      return 'Match active';
  }
}

function isCombatPhase(): boolean {
  return appPhase.name === 'fighting' || appPhase.name === 'networkFight' || appPhase.name === 'aiDemo';
}

function clearCanvas(): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
}

function renderHud(loadout: MatchLoadout): void {
  hudContainers.forEach((container, index) => {
    const playerIndex = index as 0 | 1;
    container.innerHTML = renderPilotHud(loadout[playerIndex], playerIndex);
  });
}

function renderPilotHud(shipId: ShipCatalogId, playerIndex: 0 | 1): string {
  const ship = getShipCatalogEntry(shipId);
  const portraitClass = ship.hud.flippedPortrait && playerIndex === 0 ? ' captain-portrait-flipped' : '';
  const shipOverlay = ship.hud.shipOverlayKey
    ? `<img class="hud-ship-icon hud-ship-overlay" src="${legacyAssets[ship.hud.shipOverlayKey].url}" alt="" aria-hidden="true" />`
    : '';

  return `
    <section
      class="legacy-hud player-hud player-hud-${playerIndex + 1}"
      style="
        --hud-back: url('${legacyAssets.hudBack.url}');
        --portrait-border: url('${legacyAssets.portraitBorder.url}');
        --name-bar: url('${legacyAssets.nameBar.url}');
        --name-glass: url('${legacyAssets.nameGlass.url}');
        --bar-glass: url('${legacyAssets.barGlass.url}');
        --pow-bot: url('${legacyAssets.powBot.url}');
        --pow-mid: url('${legacyAssets.powMid.url}');
        --pow-top: url('${legacyAssets.powTop.url}');
        --ship-hud-scale: ${ship.hud.shipScale};
      "
    >
      <div class="hud-nameplate">
        <img class="hud-name-image" src="${legacyAssets[ship.hud.nameKey].url}" alt="${ship.name}" />
      </div>
      <div class="hud-meters">
        ${renderMeter('battery', playerIndex, ship.battery)}
        <div class="hud-ship">
          <img class="hud-ship-icon" src="${legacyAssets[ship.hud.shipKey].url}" alt="${ship.name} ship" />
          ${shipOverlay}
        </div>
        ${renderMeter('crew', playerIndex, ship.crew)}
      </div>
      <div class="hud-portrait-frame">
        <img
          class="captain-portrait${portraitClass}"
          src="${legacyAssets[ship.hud.portraitKey].url}"
          alt="${ship.name} portrait"
          data-portrait="${playerIndex}"
          data-default-src="${legacyAssets[ship.hud.portraitKey].url}"
        />
      </div>
    </section>
  `;
}

function renderMeter(type: 'battery' | 'crew', playerIndex: number, maxValue: number): string {
  const slotCount = Math.ceil(maxValue / 2);
  const stackTop = 314 - (slotCount * 12 - 5);
  const stackHeight = 333 - stackTop;
  const pipTop = 313 - 12 * (slotCount - 1) - stackTop;
  const pipBottom = 333 - (313 + 11);
  const pipUrl = type === 'crew' ? legacyAssets.crewPip.url : legacyAssets.powPip.url;
  const pips = renderPips(pipUrl, `${type} pip`, maxValue);
  const slots = Array.from({ length: slotCount + 1 }, (_, index) => {
    const slotType = index === 0 ? 'bottom' : index === slotCount ? 'top' : 'middle';
    const offset = index === slotCount ? index * 12 - 5 : index * 12;
    const height = slotType === 'bottom' ? 19 : slotType === 'top' ? 16 : 12;
    return `<span class="meter-slot meter-slot-${slotType}" style="--slot-bottom: ${(offset / stackHeight) * 100}%; --slot-height: ${(height / stackHeight) * 100}%"></span>`;
  }).join('');

  return `
    <div
      class="hud-meter ${type}-meter"
      data-${type === 'crew' ? 'crew' : 'battery'}-meter="${playerIndex}"
      style="
        --meter-top: ${(stackTop / 720) * 100}%;
        --meter-height: ${(stackHeight / 720) * 100}%;
        --pip-top: ${(pipTop / stackHeight) * 100}%;
        --pip-bottom: ${(pipBottom / stackHeight) * 100}%;
      "
    >
      <div class="meter-slots" aria-hidden="true">
        ${slots}
      </div>
      <div class="meter-pips" aria-label="${type}">${pips}</div>
      <div class="meter-glass" aria-hidden="true"></div>
    </div>
  `;
}

function renderPips(src: string, alt: string, count: number): string {
  const rows: string[] = [];

  for (let index = 0; index < count; index += 2) {
    const rowPips = [index, index + 1]
      .filter((pipIndex) => pipIndex < count)
      .map(() => `<img src="${src}" alt="${alt}" />`)
      .join('');
    rows.push(`<span class="meter-pip-row">${rowPips}</span>`);
  }

  return rows.join('');
}

interface DamageTrackerSnapshot {
  readonly frame: number;
  readonly state: GameState;
}

let damageTrackerSnapshot: DamageTrackerSnapshot | null = null;

function trackDamage(state: GameState): void {
  if (!damageTrackerSnapshot) {
    logBattleStart(state);
    damageTrackerSnapshot = { frame: state.frame, state };
    return;
  }

  const previous = damageTrackerSnapshot;

  if (state.frame < previous.frame) {
    logBattleEnd(previous.state, 'round reset');
    logBattleStart(state);
    damageTrackerSnapshot = { frame: state.frame, state };
    return;
  }

  if (previous.frame === state.frame) {
    return;
  }

  const previousState = previous.state;
  const previousProjectiles = new Map(previousState.projectiles.map((projectile) => [projectile.id, projectile]));
  const currentProjectileIds = new Set(state.projectiles.map((projectile) => projectile.id));

  state.ships.forEach((ship, index) => {
    const previousShip = previousState.ships[index];
    if (!previousShip) {
      return;
    }

    if (ship.crew >= previousShip.crew) {
      return;
    }

    const lost = previousShip.crew - ship.crew;
    const candidates: string[] = [];

    previousProjectiles.forEach((projectile) => {
      if (!projectile.active || currentProjectileIds.has(projectile.id)) {
        return;
      }
      const ownerLabel = projectile.ownerId === index ? `self#${projectile.ownerId}` : `owner=${projectile.ownerId}`;
      candidates.push(`${projectile.kind}#${projectile.id}(${ownerLabel},dmg=${projectile.damage})`);
    });

    state.ships.forEach((other) => {
      if (other.id === index) {
        return;
      }
      const previousOther = previousState.ships[other.id];
      if (!previousOther) {
        return;
      }

      if (other.shipId === 'pscout') {
        const previousBeam = previousOther.custom.pscoutBeamFrames ?? 0;
        const currentBeam = other.custom.pscoutBeamFrames ?? 0;
        if (previousBeam === 50 && currentBeam === 49) {
          candidates.push(`pscoutBeam(owner=${other.id},strength=${other.custom.pscoutBeamStrength ?? 0})`);
        }
      }

      if (
        other.shipId === 'kron' &&
        other.alive &&
        other.primaryCooldown > previousOther.primaryCooldown &&
        isKronBeamHitting(previousOther.x, previousOther.y, previousOther.angle, previousShip, previousState)
      ) {
        candidates.push(`kronBeam(owner=${other.id})`);
      }
    });

    const sourceLabel = candidates.length > 0 ? candidates.join(', ') : 'unknown';
    console.log(
      `[damage] f=${state.frame} ship=${index}(${ship.shipId}) crew ${previousShip.crew}->${ship.crew} (-${lost}) source=${sourceLabel}`,
    );
  });

  const justDied = state.ships.some((ship, index) => {
    const previousShip = previousState.ships[index];
    return Boolean(previousShip?.alive) && !ship.alive;
  });
  if (justDied) {
    logBattleEnd(state, 'ship destroyed');
  }

  damageTrackerSnapshot = { frame: state.frame, state };
}

function logBattleStart(state: GameState): void {
  const summary = state.ships.map(formatShipSummary).join(' vs ');
  console.log(`[damage] battle start f=${state.frame} ${summary}`);
}

function logBattleEnd(state: GameState, reason: string): void {
  const summary = state.ships
    .map((ship) => `${formatShipSummary(ship)} ${ship.alive ? 'alive' : 'destroyed'}`)
    .join(' | ');
  console.log(`[damage] battle end (${reason}) f=${state.frame} ${summary}`);
}

function formatShipSummary(ship: GameState['ships'][number]): string {
  const displayName = getShipCatalogEntry(ship.shipId).name;
  return `${displayName}#${ship.id}(${ship.shipId}) crew=${ship.crew}/${ship.maxCrew} batt=${ship.battery}/${ship.maxBattery}`;
}

function updateLegacyHud(renderState: GameState): void {
  const crewMeters = Array.from(document.querySelectorAll<HTMLElement>('[data-crew-meter]'));
  const batteryMeters = Array.from(document.querySelectorAll<HTMLElement>('[data-battery-meter]'));
  const portraits = Array.from(document.querySelectorAll<HTMLImageElement>('[data-portrait]'));

  for (const ship of renderState.ships) {
    const crewValue = ship.alive ? ship.crew : 0;
    const batteryValue = ship.alive ? ship.battery : 0;
    setMeterValue(crewMeters[ship.id], crewValue);
    setMeterValue(batteryMeters[ship.id], batteryValue);
    updatePortrait(portraits[ship.id], ship);
  }
}

function updatePortrait(portrait: HTMLImageElement | undefined, ship: GameState['ships'][number]): void {
  if (!portrait) {
    return;
  }

  if (ship.shipId !== 'pscout') {
    return;
  }

  const beamFrames = ship.custom.pscoutBeamFrames ?? 0;
  let nextSrc = portrait.dataset.defaultSrc ?? portrait.src;
  let jitterY = 0;

  if (beamFrames > 100) {
    nextSrc = legacyAssets.pscoutPortraitAdmiral.url;
  } else if (beamFrames > 0) {
    nextSrc = legacyAssets.pscoutPortraitYgun.url;
    jitterY = Math.floor(Math.random() * 3) - 1;
  }

  if (portrait.src !== nextSrc) {
    portrait.src = nextSrc;
  }

  const flipped = portrait.classList.contains('captain-portrait-flipped');
  const baseTransform = flipped ? 'scaleX(-1)' : '';
  const jitter = jitterY === 0 ? '' : `translateY(${jitterY}px)`;
  const transform = [baseTransform, jitter].filter(Boolean).join(' ');
  if (portrait.style.transform !== transform) {
    portrait.style.transform = transform;
  }
}

function setMeterValue(meter: HTMLElement | undefined, value: number): void {
  if (!meter) {
    return;
  }

  const pips = Array.from(meter.querySelectorAll<HTMLImageElement>('.meter-pips img'));
  pips.forEach((pip, index) => {
    pip.classList.toggle('meter-pip-empty', index >= value);
  });
}

function getRemainingBudget(fleet: readonly FleetShip[], budget: number): number {
  return budget - fleet.reduce((total, ship) => total + getShipCatalogEntry(ship.catalogId).cost, 0);
}

function withSelectedShip(session: BattleSession, sideId: 0 | 1, uid: string): BattleSession {
  return {
    ...session,
    selectedShipUids: sideId === 0 ? [uid, session.selectedShipUids[1]] : [session.selectedShipUids[0], uid],
  };
}

function getSelectedFleetShip(session: BattleSession, sideId: 0 | 1): FleetShip | null {
  const uid = session.selectedShipUids[sideId];
  return session.fleets[sideId].find((ship) => ship.uid === uid && ship.alive) ?? null;
}

function chooseRandomLivingShip(fleet: readonly FleetShip[]): FleetShip | null {
  const living = fleet.filter((ship) => ship.alive);
  return living.length > 0 ? living[Math.floor(Math.random() * living.length)] : null;
}

function hasLivingShips(fleet: readonly FleetShip[]): boolean {
  return fleet.some((ship) => ship.alive);
}

function getSideName(sideId: number): string {
  return sideId === 0 ? 'Player' : 'AI';
}

function getStandardMenuLobbies(): readonly LobbyRecord[] {
  const standard = lobbies.filter((lobby) => getLobbyKind(lobby) === 'standard');
  return showOwnLobbiesCheckbox.checked ? standard : standard.filter((lobby) => lobby.hostUid !== currentUid);
}

function getDevPanelLobbies(): readonly LobbyRecord[] {
  return showOwnLobbiesCheckbox.checked ? lobbies : lobbies.filter((lobby) => lobby.hostUid !== currentUid);
}

function formatLobbyKindBadge(kind: LobbyKind): string {
  return kind === 'dev' ? 'DEV' : 'standard';
}

function readBudget(button: HTMLButtonElement): number {
  if (button.dataset.budgetSource === 'custom') {
    const input = menuOverlay.querySelector<HTMLInputElement>('[data-budget-input]');
    return clampBudget(Number(input?.value ?? 100));
  }

  return clampBudget(Number(button.dataset.budget ?? 100));
}

function updateFakeLagSetting(input: HTMLInputElement): void {
  const field = input.dataset.fakeLagField;
  if (!isFakeLagField(field)) {
    return;
  }

  const nextValue = readFakeLagNumber(input, field);
  networkDebugSettings = {
    ...networkDebugSettings,
    localImpairment: {
      ...networkDebugSettings.localImpairment,
      [field]: nextValue,
    },
  };

  input.value = String(nextValue);
}

function maybeApplyMpAiImpairmentDefaults(enabled: boolean): void {
  if (!enabled || shouldImpairPacket(networkDebugSettings.localImpairment)) {
    return;
  }

  networkDebugSettings = {
    ...networkDebugSettings,
    localImpairment: MP_AI_IMPAIRMENT_DEFAULTS,
  };
  syncFakeLagInputs();
}

function syncFakeLagInputs(): void {
  for (const input of fakeLagInputs) {
    const field = input.dataset.fakeLagField;
    if (!isFakeLagField(field)) {
      continue;
    }

    input.value = String(networkDebugSettings.localImpairment[field]);
  }
}

function readFakeLagNumber(input: HTMLInputElement, field: keyof PacketImpairmentSettings): number {
  const value = Number(input.value);
  switch (field) {
    case 'delayMs':
    case 'jitterMs':
      return clampInteger(value, 0, 5000, 0);
    case 'dropPct':
      return clampInteger(value, 0, 100, 0);
  }
}

function isFakeLagField(value: string | undefined): value is keyof PacketImpairmentSettings {
  return value === 'delayMs' || value === 'jitterMs' || value === 'dropPct';
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampBudget(value: number): number {
  if (!Number.isFinite(value)) {
    return 100;
  }

  return Math.max(40, Math.min(999, Math.round(value)));
}

function readShipId(button: HTMLButtonElement): ShipCatalogId {
  const shipId = button.dataset.shipId;
  if (!isShipCatalogId(shipId)) {
    throw new Error(`Invalid ship id: ${shipId}`);
  }

  return shipId;
}

function isShipCatalogId(shipId: string | undefined): shipId is ShipCatalogId {
  return SHIP_CATALOG.some((ship) => ship.id === shipId);
}

function readFleetUid(button: HTMLButtonElement): string {
  const uid = button.dataset.fleetUid;
  if (!uid) {
    throw new Error('Missing fleet ship id.');
  }

  return uid;
}

function readFleetSlotIndex(button: HTMLButtonElement): number {
  const index = Number(button.dataset.fleetSlotIndex);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_FLEET_SLOTS) {
    throw new Error(`Invalid fleet slot index: ${button.dataset.fleetSlotIndex}`);
  }

  return index;
}

function readLobbyId(button: HTMLButtonElement): string {
  const lobbyId = button.dataset.lobbyId;
  if (!lobbyId) {
    throw new Error('Missing lobby id.');
  }

  return lobbyId;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}
