import './style.css';

import { bindKeyboard, readInputDeviceStatus, readLocalInputs } from './input';
import { createFixedLoop, SIM_FPS } from './loop';
import { getFirebaseClient, isFirebaseConfigured, observeAnonymousUser, signInWithAnonymousAuth } from './net/firebase';
import { LobbyRepository, type LobbyRecord } from './net/lobby';
import { NetworkMatchSession, type NetworkMatchStatus } from './net/matchSession';
import { formatPeerStatus } from './net/peerStatus';
import { PeerConnectionSession, type ConnectionRole, type ConnectionState } from './net/webrtc';
import { CanvasRenderer } from './render/canvasRenderer';
import { LegacyImageStore, type LegacyImageLoadingProgress, legacyAssets } from './render/legacyAssets';
import { DEFAULT_MATCH_SHIPS, SHIP_CATALOG, getShipCatalogEntry, type ShipCatalogId } from './ships';
import { getAiInput, getAiMovementMode, type AiMovementMode } from './sim/ai';
import { hashState } from './sim/hash';
import { createInitialState } from './sim/state';
import { stepGame } from './sim/step';
import type { GameState } from './sim/types';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Could not find #app element.');
}

const BUDGET_PRESETS = [100, 150, 200] as const;
const AI_DEMO_ROUND_FRAMES = 30 * SIM_FPS;

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
  | { readonly name: 'networkFight'; readonly handledWinnerId: number | null }
  | { readonly name: 'networkResult'; readonly winnerId: number };

type MatchLoadout = readonly [ShipCatalogId, ShipCatalogId];

let appPhase: AppPhase = { name: 'loading' };
let state: GameState = createInitialState();
let currentLoadout: MatchLoadout = DEFAULT_MATCH_SHIPS;
let currentUid: string | null = null;
let lobbies: readonly LobbyRecord[] = [];
let peerSession: PeerConnectionSession | null = null;
let peerConnectionState: ConnectionState = 'idle';
let networkMatch: NetworkMatchSession | null = null;
let networkMatchStatus: NetworkMatchStatus | null = null;
let lastInputStatusText = '';
let lastInputDebugText = '';
let cleanupLobbyObserver: (() => void) | null = null;
let fleetSerial = 0;
let loadingProgress: LegacyImageLoadingProgress = { loaded: 0, failed: 0, total: Object.keys(legacyAssets).length };

app.innerHTML = `
  <main class="legacy-screen">
    <aside class="left-panel legacy-panel" data-player-hud="0"></aside>
    <section class="game-panel" aria-label="SkPow legacy arena">
      <div class="arena-frame">
        <canvas class="game-canvas" data-game-canvas aria-label="SkPow prototype arena"></canvas>
        <div class="menu-overlay" data-menu-overlay></div>
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
  shouldCapture: () => appPhase.name === 'fighting' || appPhase.name === 'networkFight',
});
window.addEventListener('beforeunload', cleanupKeyboard);
window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && appPhase.name === 'aiDemo') {
    appPhase = { name: 'mainMenu' };
    renderMenu();
  }
});

createFixedLoop(
  () => {
    if (appPhase.name === 'fighting') {
      const localInputs = readLocalInputs();
      state = stepGame(state, [localInputs[0], getAiInput(state, 1)]);
      if (state.winnerId !== null && appPhase.handledWinnerId !== state.winnerId) {
        resolveLocalRound(appPhase.session, state.winnerId);
      }
      return;
    }

    if (appPhase.name === 'aiDemo') {
      state = stepGame(state, [getAiInput(state, 0), getAiInput(state, 1)]);
      if (state.winnerId !== null || state.frame >= AI_DEMO_ROUND_FRAMES) {
        startAiDemoRound(appPhase.round + 1);
      }
      return;
    }

    if (appPhase.name === 'networkFight' && networkMatch && peerConnectionState === 'connected') {
      const inputs = readLocalInputs();
      const localInput = inputs[networkMatch.status.localPlayerIndex];
      const result = networkMatch.step(localInput);
      networkMatchStatus = result.status;
      sendGameplayPackets(result.packets);
      updatePeerStatus();
      const winnerId = result.state?.winnerId ?? networkMatch.currentState?.winnerId ?? null;
      if (winnerId !== null && appPhase.handledWinnerId !== winnerId) {
        appPhase = { name: 'networkResult', winnerId };
        renderMenu();
      }
    }
  },
  () => {
    if (!isCombatPhase()) {
      clearCanvas();
      gameStatus.textContent = 'Menu';
      matchStatus.textContent = formatPhaseStatus();
      return;
    }

    const renderState = networkMatch?.currentState ?? state;
    renderer.setAiDebugModes(getAiDebugModes(renderState));
    renderer.render(renderState);
    gameStatus.textContent = `Frame ${renderState.frame} | Hash ${hashState(renderState).toString(16).padStart(8, '0')}`;
    matchStatus.textContent = formatMatchStatus(renderState);
    updateLegacyHud(renderState);
    if (renderState.frame % 15 === 0) {
      updateInputStatus();
    }
  },
).start();

function getAiDebugModes(renderState: GameState): readonly (AiMovementMode | null)[] {
  if (appPhase.name === 'aiDemo') {
    return renderState.ships.map((ship) => getAiMovementMode(renderState, ship.id));
  }

  if (appPhase.name === 'fighting') {
    return renderState.ships.map((ship) => (ship.id === 1 ? getAiMovementMode(renderState, ship.id) : null));
  }

  return [];
}

if (!isFirebaseConfigured() || !firebase || !lobbyRepository) {
  firebaseStatus.textContent = 'Firebase env values are missing. Local prototype is still playable.';
  signInButton.disabled = true;
  createLobbyButton.disabled = true;
} else {
  firebaseStatus.textContent = 'Firebase configured. Sign in to create or join lobbies.';
  createLobbyButton.disabled = true;
  observeAnonymousUser((user) => {
    currentUid = user?.uid ?? null;
    createLobbyButton.disabled = !currentUid;
    firebaseStatus.textContent = currentUid ? `Signed in anonymously: ${currentUid}` : 'Not signed in.';
    updateLobbyObserver();
    renderLobbies();
    renderMenu();
  });
}

menuOverlay.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) {
    return;
  }

  handleMenuAction(button);
});

signInButton.addEventListener('click', () => {
  void signInWithAnonymousAuth().catch((error) => log(`Anonymous auth failed: ${readError(error)}`));
});

createLobbyButton.addEventListener('click', () => {
  if (!currentUid || !lobbyRepository) {
    return;
  }

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
    case 'back-main':
      closePeer();
      appPhase = { name: 'mainMenu' };
      break;
    case 'choose-budget':
      appPhase = { name: 'fleetBuild', budget: readBudget(button), fleet: [] };
      break;
    case 'fleet-add':
      addShipToPlayerFleet(readShipId(button));
      return;
    case 'fleet-remove':
      removeShipFromPlayerFleet(readFleetUid(button));
      return;
    case 'fleet-ready':
      startSinglePlayerRun();
      return;
    case 'ship-pick':
      choosePlayerShip(readFleetUid(button));
      return;
    case 'round-continue':
      continueAfterRound();
      return;
    case 'final-main':
      closePeer();
      currentLoadout = DEFAULT_MATCH_SHIPS;
      state = createInitialState(undefined, currentLoadout);
      renderer.setShipLoadout(currentLoadout);
      renderHud(currentLoadout);
      appPhase = { name: 'mainMenu' };
      break;
    case 'multi-host':
      appPhase = { name: 'hostSetup' };
      break;
    case 'multi-join':
      appPhase = { name: 'lobbyBrowser' };
      updateLobbyObserver();
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
  const combatPhase = isCombatPhase();
  legacyScreen.classList.toggle('legacy-screen-menu-active', !combatPhase);
  arenaFrame.classList.toggle('arena-frame-menu-active', !combatPhase);
  menuOverlay.classList.toggle('menu-overlay-hidden', combatPhase);

  switch (appPhase.name) {
    case 'loading':
      menuOverlay.innerHTML = renderLoadingMenu();
      break;
    case 'mainMenu':
      menuOverlay.innerHTML = renderMainMenu();
      break;
    case 'singleBudget':
      menuOverlay.innerHTML = renderBudgetMenu('Build Single Player Fleet', 'choose-budget', 'Pick a point budget for your side.');
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
      menuOverlay.innerHTML = renderBudgetMenu('Create Hosted Lobby', 'host-lobby', 'Choose the point budget advertised to joiners.');
      break;
    case 'lobbyBrowser':
      menuOverlay.innerHTML = renderLobbyBrowserMenu();
      break;
    case 'networkConnecting':
      menuOverlay.innerHTML = renderNetworkConnectingMenu(appPhase);
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
        <button type="button" data-action="main-ai-demo">AI vs AI Test</button>
        <button type="button" data-action="main-multi">Multiplayer</button>
      </div>
    </section>
  `;
}

function renderBudgetMenu(title: string, action: string, detail: string): string {
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
        <button type="button" data-action="back-main">Back</button>
      </div>
    </section>
  `;
}

function renderFleetBuildMenu(phase: Extract<AppPhase, { readonly name: 'fleetBuild' }>): string {
  const remaining = getRemainingBudget(phase.fleet, phase.budget);
  return `
    <section class="menu-card menu-card-wide">
      ${renderMenuBrand()}
      <p class="menu-kicker">Single Player</p>
      <h2>Build Your Fleet</h2>
      <p>${remaining} / ${phase.budget} points remaining. Costs are placeholders for now.</p>
      <div class="ship-card-grid">
        ${SHIP_CATALOG.map((ship) => renderCatalogCard(ship.id, remaining)).join('')}
      </div>
      <h3>Your Fleet</h3>
      <div class="fleet-list">
        ${phase.fleet.length === 0 ? '<p>No ships selected yet.</p>' : phase.fleet.map(renderFleetRow).join('')}
      </div>
      <div class="menu-actions">
        <button type="button" data-action="fleet-ready" ${phase.fleet.length === 0 ? 'disabled' : ''}>Ready</button>
        <button type="button" data-action="back-main">Back</button>
      </div>
    </section>
  `;
}

function renderCatalogCard(shipId: ShipCatalogId, remaining: number): string {
  const ship = getShipCatalogEntry(shipId);
  const disabled = ship.cost > remaining ? 'disabled' : '';
  return `
    <article class="ship-card">
      <h3>${ship.name}</h3>
      <p>${ship.cost} pts | Crew ${ship.crew} | Battery ${ship.battery}</p>
      <button type="button" data-action="fleet-add" data-ship-id="${ship.id}" ${disabled}>Add Ship</button>
    </article>
  `;
}

function renderFleetRow(fleetShip: FleetShip): string {
  const ship = getShipCatalogEntry(fleetShip.catalogId);
  return `
    <div class="fleet-row">
      <span>${ship.name} | ${ship.cost} pts</span>
      <button type="button" data-action="fleet-remove" data-fleet-uid="${fleetShip.uid}">Remove</button>
    </div>
  `;
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
      <p>Create a lobby with a point budget or join a hosted lobby.</p>
      <div class="menu-actions">
        ${currentUid ? '' : '<button type="button" data-action="sign-in">Sign In Anonymously</button>'}
        <button type="button" data-action="multi-host">Create Hosted Lobby</button>
        <button type="button" data-action="multi-join">Join Hosted Lobby</button>
        <button type="button" data-action="back-main">Back</button>
      </div>
    </section>
  `;
}

function renderLobbyBrowserMenu(): string {
  const visibleLobbies = getVisibleLobbies();
  const authText = currentUid ? 'Choose an open lobby.' : 'Sign in anonymously before joining a lobby.';
  return `
    <section class="menu-card menu-card-wide">
      ${renderMenuBrand()}
      <p class="menu-kicker">Hosted Lobbies</p>
      <h2>Join Multiplayer</h2>
      <p>${authText}</p>
      <div class="lobby-list menu-lobby-list">
        ${visibleLobbies.length === 0 ? '<p>No open lobbies yet.</p>' : visibleLobbies.map(renderMenuLobbyRow).join('')}
      </div>
      <div class="menu-actions">
        ${currentUid ? '' : '<button type="button" data-action="sign-in">Sign In Anonymously</button>'}
        <button type="button" data-action="back-main">Back</button>
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

function renderNetworkConnectingMenu(phase: Extract<AppPhase, { readonly name: 'networkConnecting' }>): string {
  return `
    <section class="menu-card">
      ${renderMenuBrand()}
      <p class="menu-kicker">Multiplayer</p>
      <h2>${phase.role === 'host' ? 'Waiting For Joiner' : 'Joining Lobby'}</h2>
      <p>Lobby ${phase.lobbyId} | ${phase.budget} pts | Peer ${peerConnectionState}</p>
      <div class="menu-actions">
        <button type="button" data-action="back-main">Cancel</button>
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
  if (appPhase.name !== 'fleetBuild') {
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
  renderMenu();
}

function removeShipFromPlayerFleet(uid: string): void {
  if (appPhase.name !== 'fleetBuild') {
    return;
  }

  appPhase = {
    ...appPhase,
    fleet: appPhase.fleet.filter((ship) => ship.uid !== uid),
  };
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
  log(`AI vs AI round ${round}: ${getShipCatalogEntry(currentLoadout[0]).name} vs ${getShipCatalogEntry(currentLoadout[1]).name}`);
  renderMenu();
}

function chooseRandomCatalogShip(): ShipCatalogId {
  return SHIP_CATALOG[Math.floor(Math.random() * SHIP_CATALOG.length)].id;
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

async function hostLobbyFromMenu(budget: number): Promise<void> {
  if (!currentUid || !lobbyRepository) {
    log('Sign in and configure Firebase before creating a hosted lobby.');
    return;
  }

  await createHostLobby(currentUid, lobbyRepository, budget);
}

async function joinLobbyFromMenu(lobbyId: string): Promise<void> {
  if (!currentUid || !lobbyRepository) {
    log('Sign in and configure Firebase before joining a lobby.');
    return;
  }

  await joinLobby(lobbyId, currentUid, lobbyRepository);
}

function renderLobbies(): void {
  lobbyList.innerHTML = '';

  if (!lobbyRepository) {
    return;
  }

  const visibleLobbies = getVisibleLobbies();
  if (visibleLobbies.length === 0) {
    lobbyList.textContent = 'No open lobbies yet.';
    return;
  }

  for (const lobby of visibleLobbies) {
    const row = document.createElement('div');
    row.className = 'lobby-row';
    const label = document.createElement('span');
    const isOwnLobby = lobby.hostUid === currentUid;
    label.textContent = `${lobby.status} | ${lobby.settings.pointTotal} pts | ${lobby.settings.draftMode}${isOwnLobby ? ' | local test' : ''}`;
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
  cleanupLobbyObserver?.();
  cleanupLobbyObserver = null;
  lobbies = [];

  if (!currentUid || !lobbyRepository) {
    return;
  }

  cleanupLobbyObserver = lobbyRepository.observeOpenLobbies((nextLobbies) => {
    lobbies = nextLobbies;
    renderLobbies();
    renderMenu();
  });
}

async function createHostLobby(uid: string, repository: LobbyRepository, budget: number): Promise<void> {
  const lobbyId = await repository.createLobby(uid, { pointTotal: budget, draftMode: 'open' });
  log(`Created lobby ${lobbyId}. Waiting for a joiner...`);
  peerSession?.close();
  networkMatch = null;
  networkMatchStatus = null;
  peerSession = createPeerSession('host', lobbyId, repository, budget);
  appPhase = { name: 'networkConnecting', role: 'host', budget, lobbyId };
  renderMenu();
  await peerSession.start();
}

async function joinLobby(lobbyId: string, uid: string, repository: LobbyRepository): Promise<void> {
  const lobby = lobbies.find((item) => item.id === lobbyId);
  const budget = lobby?.settings.pointTotal ?? 100;
  log(`Joining lobby ${lobbyId}...`);
  const claimed = await repository.claimLobby(lobbyId, uid);
  if (!claimed) {
    log('Could not claim lobby. It may already be connecting or expired.');
    return;
  }

  peerSession?.close();
  networkMatch = null;
  networkMatchStatus = null;
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
  return new PeerConnectionSession(role, lobbyId, repository, {
    onStateChange: (connectionState: ConnectionState) => {
      peerConnectionState = connectionState;
      if (connectionState === 'connected' && !networkMatch) {
        log(`Network match using ${budget} point lobby budget.`);
        currentLoadout = DEFAULT_MATCH_SHIPS;
        renderer.setShipLoadout(currentLoadout);
        renderHud(currentLoadout);
        state = createInitialState();
        networkMatch = new NetworkMatchSession(role);
        sendGameplayPackets(networkMatch.takeOutgoingPackets());
        networkMatchStatus = networkMatch.status;
        appPhase = { name: 'networkFight', handledWinnerId: null };
      }

      if (connectionState === 'closed' || connectionState === 'failed') {
        networkMatch = null;
        networkMatchStatus = null;
        if (appPhase.name === 'networkFight' || appPhase.name === 'networkConnecting') {
          appPhase = { name: 'multiplayerMenu' };
        }
      }

      updatePeerStatus();
      renderMenu();
      log(`Peer state changed to ${connectionState}.`);
    },
    onControlMessage: (message) => log(`Control message: ${message}`),
    onGameplayMessage: (message) => {
      if (!networkMatch) {
        log('Received gameplay packet before match session was ready.');
        return;
      }

      try {
        networkMatchStatus = networkMatch.receiveGameplayMessage(message);
        sendGameplayPackets(networkMatch.takeOutgoingPackets());
        networkMatchStatus = networkMatch.status;
        updatePeerStatus();
      } catch (error) {
        log(`Gameplay packet failed: ${readError(error)}`);
      }
    },
  });
}

function closePeer(): void {
  peerSession?.close();
  peerSession = null;
  networkMatch = null;
  networkMatchStatus = null;
  peerConnectionState = 'closed';
  updatePeerStatus();
}

function sendGameplayPackets(packets: readonly Uint8Array[]): void {
  for (const packet of packets) {
    peerSession?.sendGameplayMessage(packet);
  }
}

function log(message: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  debugLog.textContent = `${line}\n${debugLog.textContent ?? ''}`.slice(0, 4000);
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
}

function formatPeerSummary(connectionState: ConnectionState, status: NetworkMatchStatus | null): string {
  if (!status) {
    return `Peer: ${connectionState}`;
  }

  const syncState = status.desync ? 'desynced' : 'sync ok';
  const readyState = status.ready ? 'ready' : 'handshaking';
  return `Peer: ${connectionState} | ${readyState} | ${syncState} | rollback ${status.rollbackCount}`;
}

function formatMatchStatus(renderState: GameState): string {
  if (appPhase.name !== 'fighting' && appPhase.name !== 'networkFight' && appPhase.name !== 'aiDemo') {
    return formatPhaseStatus();
  }

  if (renderState.winnerId === null) {
    if (appPhase.name === 'networkFight') {
      return 'Online match active';
    }
    if (appPhase.name === 'aiDemo') {
      const remainingSeconds = Math.max(0, Math.ceil((AI_DEMO_ROUND_FRAMES - renderState.frame) / SIM_FPS));
      return `AI vs AI round ${appPhase.round} | ${remainingSeconds}s until reroll`;
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
        <img class="captain-portrait${portraitClass}" src="${legacyAssets[ship.hud.portraitKey].url}" alt="${ship.name} portrait" />
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

function updateLegacyHud(renderState: GameState): void {
  const crewMeters = Array.from(document.querySelectorAll<HTMLElement>('[data-crew-meter]'));
  const batteryMeters = Array.from(document.querySelectorAll<HTMLElement>('[data-battery-meter]'));

  for (const ship of renderState.ships) {
    const crewValue = ship.alive ? ship.crew : 0;
    const batteryValue = ship.alive ? ship.battery : 0;
    setMeterValue(crewMeters[ship.id], crewValue);
    setMeterValue(batteryMeters[ship.id], batteryValue);
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

function getVisibleLobbies(): readonly LobbyRecord[] {
  return showOwnLobbiesCheckbox.checked ? lobbies : lobbies.filter((lobby) => lobby.hostUid !== currentUid);
}

function readBudget(button: HTMLButtonElement): number {
  if (button.dataset.budgetSource === 'custom') {
    const input = menuOverlay.querySelector<HTMLInputElement>('[data-budget-input]');
    return clampBudget(Number(input?.value ?? 100));
  }

  return clampBudget(Number(button.dataset.budget ?? 100));
}

function clampBudget(value: number): number {
  if (!Number.isFinite(value)) {
    return 100;
  }

  return Math.max(40, Math.min(999, Math.round(value)));
}

function readShipId(button: HTMLButtonElement): ShipCatalogId {
  const shipId = button.dataset.shipId;
  if (!SHIP_CATALOG.some((ship) => ship.id === shipId)) {
    throw new Error(`Invalid ship id: ${shipId}`);
  }

  return shipId as ShipCatalogId;
}

function readFleetUid(button: HTMLButtonElement): string {
  const uid = button.dataset.fleetUid;
  if (!uid) {
    throw new Error('Missing fleet ship id.');
  }

  return uid;
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
