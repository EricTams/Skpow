import './style.css';

import { GameAudio } from './audio';
import { shipSfx } from './audioAssets';
import { MenuInputBits, bindKeyboard, readGamepadMenuInput, readInputDeviceStatus, readLocalInputs, readPrimaryLocalInput } from './input';
import { createFixedLoop, SIM_FPS } from './loop';
import { decodeNetworkControlMessage, encodeNetworkControlMessage, type NetworkFleetShip } from './net/controlMessages';
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
import { fixedToNumber, type Fixed } from './sim/fixed';
import { hashState } from './sim/hash';
import { SHIP_SPECS } from './sim/shipSpecs';
import { createInitialState, type RoundStartShipOverride } from './sim/state';
import { isKronBeamHitting, stepGame } from './sim/step';
import { ANGLE_STEPS, type Angle } from './sim/trig';
import type { ActorState, GameState, GameplaySettings, ProjectileState, ShipCustomState, ShipState } from './sim/types';

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
const LOW_GRAVITY_DIVISOR = 6;
const SPEED_PRESETS = [
  { id: 'low', label: 'Low', multiplier: 1 },
  { id: 'mid', label: 'Mid', multiplier: 1.5 },
  { id: 'high', label: 'High', multiplier: 2 },
] as const;

const CATALOG_PREVIEW_SHIP_IDS = ['frog', 'cannonade', 'zizlik', 'voskum', 'pscout', 'kron', 'gooj', 'krab', 'nurtip', 'duk', 'discfighter', 'doubleship'] as const satisfies readonly ShipCatalogId[];
const CATALOG_DIAGRAM_SCALE_MULTIPLIER = 2.4;
const CATALOG_LIST_SCALE_MULTIPLIER = 0.42;
const FLEET_PICKER_ART_SCALE_MULTIPLIER = 0.50;
const FLEET_SLOT_ART_SCALE_MULTIPLIER = 0.50;

type CatalogPreviewShipId = (typeof CATALOG_PREVIEW_SHIP_IDS)[number];

interface ShipCatalogStat {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly display: string;
  readonly stackedBars?: readonly {
    readonly label: string;
    readonly value: number;
    readonly max: number;
    readonly display: string;
  }[];
}

interface UiShipArtLayer {
  readonly key: keyof typeof legacyAssets;
  readonly scale: number;
  readonly className?: string;
  readonly offsetX?: number;
  readonly offsetY?: number;
}

const SHIP_CATALOG_METADATA: Record<CatalogPreviewShipId, ShipCatalogDisplayMetadata> = {
  frog: {
    registryCode: 'SKP-FRG-001',
    role: 'Charged bubble pressure craft',
    primaryName: 'Variable Bubble Capacitor',
    secondaryName: 'Reactive Bubble Shield',
    callouts: [
      {
        index: '01',
        title: 'Charge-Fed Bubble Projector',
        body: 'Holding primary banks fuel into a larger bubble; releasing launches the stored charge.',
        position: 'upper-left',
      },
      {
        index: '02',
        title: 'Compact Crew Capsule',
        body: 'Thirty crew units packed into a soft-body hull with encouraging optimism.',
        position: 'upper-right',
      },
      {
        index: '03',
        title: 'Variable Power Bladder',
        body: 'Charge climbs in fuel-fed steps, increasing bubble damage, life span, and radius.',
        position: 'lower-left',
      },
      {
        index: '04',
        title: 'One-Hit Guard Membrane',
        body: 'Secondary coats the hull, reducing the next normal hit before the membrane collapses.',
        position: 'lower-right',
      },
    ],
  },
  cannonade: {
    registryCode: 'SKP-CND-002',
    role: 'Heavy turret artillery platform',
    primaryName: 'Independent Heavy Cannon',
    secondaryName: 'Tracking Return Boomerang',
    callouts: [
      {
        index: '01',
        title: 'Autonomous Cannon Mount',
        body: 'Main cannon slews independently from the hull and fires along its own facing.',
        position: 'upper-left',
      },
      {
        index: '02',
        title: 'Armored Split Hull',
        body: 'The chassis separates while the boomerang system is active in the field.',
        position: 'upper-right',
      },
      {
        index: '03',
        title: 'High-Yield Cannonball',
        body: 'Primary fire is expensive and slow to recycle, but lands heavy direct damage.',
        position: 'lower-left',
      },
      {
        index: '04',
        title: 'Single Active Boomerang',
        body: 'Secondary launches one tracking return weapon; reload begins after it clears.',
        position: 'lower-right',
      },
    ],
  },
  zizlik: {
    registryCode: 'SKP-ZZK-003',
    role: 'Fast node-amplified interceptor',
    primaryName: 'Vertical Twin Pulse',
    secondaryName: 'Deployable Side Nodes',
    callouts: [
      {
        index: '01',
        title: 'Twin-Axis Pulse Core',
        body: 'Each firing origin emits paired shots vertically, one upward and one downward.',
        position: 'upper-left',
      },
      {
        index: '02',
        title: 'Rotating Control Ring',
        body: 'Very high acceleration and turn speed make the core difficult to pin down.',
        position: 'upper-right',
      },
      {
        index: '03',
        title: 'Left and Right Nodes',
        body: 'Secondary spends a full battery to attach up to two extra firing origins.',
        position: 'lower-left',
      },
      {
        index: '04',
        title: 'Fragile Projection Array',
        body: 'Nodes track beside the ship and are removed independently when struck.',
        position: 'lower-right',
      },
    ],
  },
  voskum: {
    registryCode: 'SKP-VSK-004',
    role: 'Blink skirmisher',
    primaryName: 'Offset Scatter Pulse',
    secondaryName: 'Random Blink Drive',
    callouts: [
      {
        index: '01',
        title: 'Offset Pulse Port',
        body: 'Primary shots leave from one of three nearby muzzle offsets while flying forward.',
        position: 'upper-left',
      },
      {
        index: '02',
        title: 'Compact Strike Body',
        body: 'High top speed lets the ship keep pressure while waiting for blink recycle.',
        position: 'upper-right',
      },
      {
        index: '03',
        title: 'Blink Vectorizer',
        body: 'Secondary relocates the ship in a random direction across a fixed jump distance.',
        position: 'lower-left',
      },
      {
        index: '04',
        title: 'Teleport Imprint Trail',
        body: 'The renderer leaves transient green afterimages between old and new positions.',
        position: 'lower-right',
      },
    ],
  },
  pscout: {
    registryCode: 'SKP-PSC-005',
    role: 'Beacon-guided beam scout',
    primaryName: 'Tracking Beacon Launcher',
    secondaryName: 'Beacon Discharge Beam',
    callouts: [
      {
        index: '01',
        title: 'Ready Beacon Pod',
        body: 'A loaded beacon is drawn ahead of the hull while primary fire is available.',
        position: 'upper-left',
      },
      {
        index: '02',
        title: 'Light Scout Hull',
        body: 'Low crew and tiny battery are traded for high speed and sharp acceleration.',
        position: 'upper-right',
      },
      {
        index: '03',
        title: 'Attached Beacon Stack',
        body: 'Primary hits attach beacons to the enemy; each one increases beam strength.',
        position: 'lower-left',
      },
      {
        index: '04',
        title: 'Column Beam Trigger',
        body: 'Secondary consumes enemy beacons and fires a delayed vertical beam pulse.',
        position: 'lower-right',
      },
    ],
  },
  kron: {
    registryCode: 'SKP-KRN-006',
    role: 'Beam-control interceptor',
    primaryName: 'Forward Pulse Beam',
    secondaryName: 'Cryo Lock Burst',
    callouts: [
      { index: '01', title: 'Forward Beam Lens', body: 'Primary scans straight ahead and damages only while the enemy intersects the beam path.', position: 'upper-left' },
      { index: '02', title: 'Broad Target Profile', body: 'Large hull radius gives the beam craft presence but makes close passes hazardous.', position: 'upper-right' },
      { index: '03', title: 'Rapid Pulse Cycle', body: 'Low-cost beam pulses recycle quickly when lined up with the enemy.', position: 'lower-left' },
      { index: '04', title: 'Cryo Lock Emitter', body: 'Secondary freezes the opposing ship when a target is present.', position: 'lower-right' },
    ],
  },
  gooj: {
    registryCode: 'SKP-GOJ-007',
    role: 'Heavy homing ordnance carrier',
    primaryName: 'Guided Torpedo Cocktail',
    secondaryName: 'Aft Junk Burst',
    callouts: [
      { index: '01', title: 'Guided Cocktail Tube', body: 'Primary launches a slow torpedo with steering toward its target.', position: 'upper-left' },
      { index: '02', title: 'Massive Hull Plate', body: 'Huge source art renders down to a tiny in-game scale for a broad silhouette.', position: 'upper-right' },
      { index: '03', title: 'Aft Debris Chute', body: 'Secondary ejects eight randomized junk pieces behind the ship.', position: 'lower-left' },
      { index: '04', title: 'Long-Lived Junk Field', body: 'Junk pieces drift for a variable lifespan and clutter the pursuit lane.', position: 'lower-right' },
    ],
  },
  krab: {
    registryCode: 'SKP-KRB-008',
    role: 'Mode-shifting crab fighter',
    primaryName: 'Mode-Linked Claw Guns',
    secondaryName: 'Range Mode Toggle',
    callouts: [
      { index: '01', title: 'Short-Range Claw Spread', body: 'Default primary fires a four-shot randomized spread at close range.', position: 'upper-left' },
      { index: '02', title: 'Alternate Long Hull', body: 'Secondary toggles a faster long-range form with a different ship sprite.', position: 'upper-right' },
      { index: '03', title: 'Long-Range Needle Shot', body: 'Long mode swaps in a faster straight primary with slower turning.', position: 'lower-left' },
      { index: '04', title: 'Transform Control Loop', body: 'Mode changes alter movement stats and weapon behavior until toggled again.', position: 'lower-right' },
    ],
  },
  nurtip: {
    registryCode: 'SKP-NTP-009',
    role: 'Remote missile and asteroid controller',
    primaryName: 'Armed Remote Torpedo',
    secondaryName: 'Orbiting Asteroid Seed',
    callouts: [
      { index: '01', title: 'Remote Torpedo Tube', body: 'Primary launches one missile and locks the launcher until release or natural death.', position: 'upper-left' },
      { index: '02', title: 'Laser Barrel Assembly', body: 'Ready barrels render above the hull when the primary launcher is available.', position: 'upper-right' },
      { index: '03', title: 'Manual Detonation Link', body: 'Releasing primary detonates the active missile in an area burst.', position: 'lower-left' },
      { index: '04', title: 'Asteroid Orbit Seed', body: 'Secondary creates orbiting asteroids that spread into rotating slots around the owner.', position: 'lower-right' },
    ],
  },
  duk: {
    registryCode: 'SKP-DUK-010',
    role: 'Stunner and missile rack ship',
    primaryName: 'Ramping Stunner Shot',
    secondaryName: 'Limited Missile Rack',
    callouts: [
      { index: '01', title: 'Stunner Launch Tube', body: 'Primary fires a slightly inaccurate stunner that slows before ramping up.', position: 'upper-left' },
      { index: '02', title: 'Four-Round Rack', body: 'Missiles are visible on the hull and each secondary shot consumes one rack slot.', position: 'upper-right' },
      { index: '03', title: 'Freeze-On-Hit Payload', body: 'Stunner hits damage and freeze the target for a short duration.', position: 'lower-left' },
      { index: '04', title: 'Heavy Missile Payload', body: 'Secondary missiles are limited, costly in cooldown time, and hit hard.', position: 'lower-right' },
    ],
  },
  discfighter: {
    registryCode: 'SKP-NUM-011',
    role: 'Remote disc and shock-line fighter',
    primaryName: 'Remote Disc Launcher',
    secondaryName: 'Disc Tether Shocker',
    callouts: [
      { index: '01', title: 'Docked Combat Disc', body: 'Primary launches one disc from the hull only while the disc is docked.', position: 'upper-left' },
      { index: '02', title: 'Numinus Light Frame', body: 'Classic Frog-like handling with a compact hull and thirty crew.', position: 'upper-right' },
      { index: '03', title: 'Hold-To-Thrust Control', body: 'Holding primary keeps the disc moving; releasing parks it in space.', position: 'lower-left' },
      { index: '04', title: 'Line Shock Tether', body: 'Secondary shocks targets caught near the line between ship and deployed disc.', position: 'lower-right' },
    ],
  },
  doubleship: {
    registryCode: 'SKP-LOB-012',
    role: 'Twin-hull laser reverser',
    primaryName: 'Dual Forward Laser',
    secondaryName: 'Sidewinder Flip Drive',
    callouts: [
      { index: '01', title: 'Offset Twin Hulls', body: 'Two linked hulls ride side-by-side and rotate apart during the flip recovery.', position: 'upper-left' },
      { index: '02', title: 'Paired Laser Lanes', body: 'Primary traces two short instant beams from the left and right hull offsets.', position: 'upper-right' },
      { index: '03', title: 'Beam Cutoff Readout', body: 'Each beam visual shortens to the first target it intersects.', position: 'lower-left' },
      { index: '04', title: 'Velocity Reversal Burst', body: 'Secondary flips facing and velocity while damaging nearby targets.', position: 'lower-right' },
    ],
  },
};

type SpeedSetting = (typeof SPEED_PRESETS)[number]['id'];

interface ShipCatalogDisplayMetadata {
  readonly registryCode: string;
  readonly role: string;
  readonly primaryName: string;
  readonly secondaryName: string;
  readonly callouts: readonly {
    readonly index: string;
    readonly title: string;
    readonly body: string;
    readonly position: 'upper-left' | 'upper-right' | 'lower-left' | 'lower-right';
  }[];
}

interface FleetShip {
  readonly uid: string;
  readonly catalogId: ShipCatalogId;
  readonly alive: boolean;
  readonly persistent?: PersistentFleetShipState;
}

interface PersistentFleetShipState {
  readonly crew?: number;
  readonly custom?: ShipCustomState;
  readonly zizlikNodeSlots?: readonly number[];
  readonly pscoutBeaconSlots?: readonly number[];
}

interface BattleSession {
  readonly mode: 'single' | 'hotseat' | 'network';
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
  | { readonly name: 'shipCatalog' }
  | { readonly name: 'singleBudget' }
  | { readonly name: 'hotseatBudget' }
  | { readonly name: 'fleetBuild'; readonly budget: number; readonly fleet: readonly FleetShip[] }
  | {
      readonly name: 'hotseatFleetBuild';
      readonly budget: number;
      readonly fleets: readonly [readonly FleetShip[], readonly FleetShip[]];
      readonly ready: readonly [boolean, boolean];
    }
  | { readonly name: 'shipSelect'; readonly session: BattleSession; readonly message?: string }
  | {
      readonly name: 'hotseatShipSelect';
      readonly session: BattleSession;
      readonly selectingSideIds: readonly (0 | 1)[];
      readonly message?: string;
    }
  | {
      readonly name: 'networkShipSelect';
      readonly role: ConnectionRole;
      readonly budget: number;
      readonly lobbyId: string;
      readonly session: BattleSession;
      readonly selectingSideIds: readonly (0 | 1)[];
      readonly message?: string;
    }
  | { readonly name: 'fighting'; readonly session: BattleSession; readonly handledWinnerId: number | null }
  | { readonly name: 'hotseatFighting'; readonly session: BattleSession; readonly handledWinnerId: number | null }
  | { readonly name: 'aiDemo'; readonly round: number }
  | { readonly name: 'roundResult'; readonly session: BattleSession; readonly winnerId: number; readonly loserId: number }
  | { readonly name: 'finalResult'; readonly title: string; readonly detail: string }
  | { readonly name: 'multiplayerMenu' }
  | { readonly name: 'hostSetup' }
  | { readonly name: 'lobbyBrowser' }
  | { readonly name: 'networkConnecting'; readonly role: ConnectionRole; readonly budget: number; readonly lobbyId: string; readonly title?: string; readonly detail?: string }
  | { readonly name: 'networkFleetBuild'; readonly role: ConnectionRole; readonly budget: number; readonly lobbyId: string; readonly fleet: readonly FleetShip[] }
  | {
      readonly name: 'networkFight';
      readonly role?: ConnectionRole;
      readonly budget?: number;
      readonly lobbyId?: string;
      readonly session?: BattleSession;
      readonly handledWinnerId: number | null;
    }
  | { readonly name: 'networkResult'; readonly winnerId: number };

type MatchLoadout = readonly [ShipCatalogId, ShipCatalogId];
type FleetBuilderNavDirection = 'up' | 'down' | 'left' | 'right';
type PlayerSide = 0 | 1;

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
let networkHumanRound = 0;
let pendingHostShip: ShipCatalogId | null = null;
let pendingJoinerShip: ShipCatalogId | null = null;
let pendingNetworkFleets: [readonly FleetShip[] | null, readonly FleetShip[] | null] = [null, null];
let networkBattleSession: BattleSession | null = null;
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
let lowGravityEnabled = true;
let speedSetting: SpeedSetting = 'low';
let selectedCatalogShipId: CatalogPreviewShipId = 'frog';
let catalogEntryListScrollTop = 0;
let suppressPeerDisconnectPopup = false;
let pauseMenuOpen = false;
let lastRenderedPhaseName: AppPhase['name'] | null = null;
let fleetBuilderNavTargets: [FleetBuilderNavTarget | null, FleetBuilderNavTarget | null] = [null, null];
let fleetBuilderPickingSlotIndices: [number | null, number | null] = [null, null];
let fleetBuilderConfirmingBack: [boolean, boolean] = [false, false];
let previousFleetBuilderInputs: [number, number] = [0, 0];
let fleetBuilderNavRepeatFrames: [number, number] = [0, 0];
let shipSelectNavTargets: [FleetBuilderNavTarget | null, FleetBuilderNavTarget | null] = [null, null];
let previousShipSelectInputs: [number, number] = [0, 0];
let shipSelectNavRepeatFrames: [number, number] = [0, 0];
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
              <button class="audio-toggle-button" type="button" data-pause-audio>Unmute Audio</button>
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
const pauseAudioButton = requiredElement<HTMLButtonElement>('[data-pause-audio]');
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
const gameAudio = new GameAudio();

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
gameAudio.subscribe(syncAudioControls);
renderHud(currentLoadout);
renderMenu();

const firebase = getFirebaseClient();
const lobbyRepository = firebase ? new LobbyRepository(firebase.database) : null;

const cleanupKeyboard = bindKeyboard({
  shouldCapture: (event) =>
    appPhase.name === 'fighting' ||
    appPhase.name === 'hotseatFighting' ||
    appPhase.name === 'networkFight' ||
    (isFleetBuilderPhase() && event.code !== 'ShiftLeft' && event.code !== 'ShiftRight'),
});
window.addEventListener('beforeunload', cleanupKeyboard);
window.addEventListener('keydown', (event) => {
  if (handleFleetBuilderKeyboardNav(event)) {
    return;
  }

  if (handleShipSelectKeyboardNav(event)) {
    return;
  }

  if (handleDebugShipKillShortcut(event)) {
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

function handleDebugShipKillShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
    return false;
  }

  const sideId = event.code === 'Digit1' || event.code === 'Numpad1' ? 0 : event.code === 'Digit2' || event.code === 'Numpad2' ? 1 : null;
  if (sideId === null) {
    return false;
  }

  event.preventDefault();
  debugKillShip(sideId);
  return true;
}

createFixedLoop(
  () => {
    updateFleetBuilderGamepadNav();
    updateShipSelectGamepadNav();

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

    if (appPhase.name === 'hotseatFighting') {
      if (pauseMenuOpen) {
        return;
      }
      state = stepGame(state, readLocalInputs());
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
        if (appPhase.session && appPhase.role && appPhase.budget !== undefined && appPhase.lobbyId) {
          sendNetworkRoundResolved({ kind: 'winner', winnerId: outcome.winnerId as PlayerSide });
          resolveNetworkRound(appPhase.session, outcome.winnerId, appPhase.role, appPhase.budget, appPhase.lobbyId);
        } else {
          appPhase = { name: 'networkResult', winnerId: outcome.winnerId };
          renderMenu();
        }
      } else if (outcome.kind === 'draw' && !networkMatchStatus?.aiDemo && appPhase.handledWinnerId === null) {
        if (appPhase.session && appPhase.role && appPhase.budget !== undefined && appPhase.lobbyId) {
          sendNetworkRoundResolved({ kind: 'draw' });
          resolveNetworkMutualDestruction(appPhase.session, appPhase.role, appPhase.budget, appPhase.lobbyId);
        } else {
          appPhase = { name: 'finalResult', title: 'Draw', detail: 'Both online ships were destroyed.' };
          renderMenu();
        }
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

  if (appPhase.name === 'hotseatFighting') {
    return renderState.ships.map(() => null);
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
  state = createInitialState(seed, currentLoadout, getGameplaySettings());
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
  networkMatch = new NetworkMatchSession('host', {
    roundId: networkAiRound,
    seed,
    loadout: currentLoadout,
    gameplay: getGameplaySettings(),
    aiDemo: true,
    readyImmediately: true,
  });
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

pauseAudioButton.addEventListener('click', () => {
  gameAudio.toggleMuted();
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
    case 'toggle-audio':
      gameAudio.toggleMuted();
      return;
    case 'toggle-low-gravity':
      lowGravityEnabled = !lowGravityEnabled;
      renderMenu();
      return;
    case 'set-speed': {
      const requestedSpeed = button.dataset.speed;
      if (isSpeedSetting(requestedSpeed)) {
        speedSetting = requestedSpeed;
        renderMenu();
      }
      return;
    }
    case 'main-single':
      appPhase = { name: 'singleBudget' };
      break;
    case 'main-hotseat':
      appPhase = { name: 'hotseatBudget' };
      break;
    case 'main-ai-demo':
      startAiDemoRound(1);
      return;
    case 'main-catalog':
      catalogEntryListScrollTop = 0;
      appPhase = { name: 'shipCatalog' };
      break;
    case 'catalog-pick':
      catalogEntryListScrollTop = button.closest<HTMLElement>('.ship-catalog-entry-list')?.scrollTop ?? catalogEntryListScrollTop;
      selectedCatalogShipId = readCatalogPreviewShipId(button);
      renderMenu();
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
    case 'choose-hotseat-budget':
      appPhase = { name: 'hotseatFleetBuild', budget: readBudget(button), fleets: [[], []], ready: [false, false] };
      break;
    case 'fleet-add':
      addShipToPlayerFleet(readShipId(button));
      return;
    case 'fleet-slot-pick':
      selectFleetBuilderSlot(readFleetSlotIndex(button), readFleetSide(button));
      return;
    case 'fleet-pick-ship':
      addShipToPlayerFleet(readShipId(button), readFleetSide(button));
      return;
    case 'fleet-picker-cancel':
      cancelFleetBuilderShipPicker(readFleetSide(button));
      return;
    case 'fleet-back-request':
      requestFleetBuilderBackConfirmation(readFleetSide(button));
      return;
    case 'fleet-back-cancel':
      cancelFleetBuilderBackConfirmation(readFleetSide(button));
      return;
    case 'fleet-back-confirm':
      confirmFleetBuilderBack();
      return;
    case 'fleet-remove':
      removeShipFromPlayerFleet(readFleetUid(button), readFleetSide(button));
      return;
    case 'fleet-ready':
      if (appPhase.name === 'networkFleetBuild') {
        readyNetworkFleet();
      } else if (appPhase.name === 'hotseatFleetBuild') {
        toggleHotseatFleetReady(readFleetSide(button));
      } else {
        startSinglePlayerRun();
      }
      return;
    case 'ship-pick':
      choosePlayerShip(readFleetUid(button), readFleetSide(button));
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
    fleetBuilderConfirmingBack = [false, false];
  }
  if (!isPauseMenuAvailable()) {
    closePauseMenu();
  }
  lastRenderedPhaseName = appPhase.name;

  const combatPhase = isCombatPhase();
  syncCombatMusic(combatPhase);
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
    case 'shipCatalog':
      menuOverlay.innerHTML = renderFrogCatalogMenu();
      break;
    case 'singleBudget':
      menuOverlay.innerHTML = renderBudgetMenu(
        'Build Single Player Fleet',
        'choose-budget',
        'Pick a point budget for your side.',
        '<button type="button" data-action="back">Back</button>',
      );
      break;
    case 'hotseatBudget':
      menuOverlay.innerHTML = renderBudgetMenu(
        'Build Hotseat Fleets',
        'choose-hotseat-budget',
        'Pick a shared point budget for both local players.',
        '<button type="button" data-action="back">Back</button>',
      );
      break;
    case 'fleetBuild':
      menuOverlay.innerHTML = renderFleetBuildMenu(appPhase);
      break;
    case 'hotseatFleetBuild':
      menuOverlay.innerHTML = renderHotseatFleetBuildMenu(appPhase);
      break;
    case 'shipSelect':
      menuOverlay.innerHTML = renderShipSelectMenu(appPhase);
      break;
    case 'hotseatShipSelect':
      menuOverlay.innerHTML = renderHotseatShipSelectMenu(appPhase);
      break;
    case 'networkShipSelect':
      menuOverlay.innerHTML = renderNetworkShipSelectMenu(appPhase);
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
      menuOverlay.innerHTML = renderFinalResultMenu(`Player ${appPhase.winnerId + 1} wins`, 'The online fleet battle is complete.');
      break;
    case 'fighting':
    case 'hotseatFighting':
    case 'aiDemo':
    case 'networkFight':
      menuOverlay.innerHTML = '';
      break;
  }

  if (isFleetBuilderPhase()) {
    queueFleetBuilderFocusRestore();
  }
  if (isShipSelectPhase()) {
    queueShipSelectFocusRestore();
  }
  if (appPhase.name === 'shipCatalog') {
    restoreCatalogEntryListScroll();
  }
  syncAudioControls();
}

function restoreCatalogEntryListScroll(): void {
  const list = menuOverlay.querySelector<HTMLElement>('.ship-catalog-entry-list');
  if (list) {
    list.scrollTop = catalogEntryListScrollTop;
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
        <button type="button" data-action="main-hotseat">Hotseat</button>
        <button type="button" data-action="main-ai-demo">Attract Mode</button>
        <button type="button" data-action="main-catalog">Ship Catalog</button>
        <button type="button" data-action="main-multi">Multiplayer</button>
        <button class="low-gravity-toggle-button" type="button" data-action="toggle-low-gravity" aria-pressed="${lowGravityEnabled}">${getLowGravityToggleLabel()}</button>
        <div class="speed-control" aria-label="Speed">
          <span>Speed:</span>
          ${SPEED_PRESETS.map(
            (preset) =>
              `<button class="speed-toggle-button" type="button" data-action="set-speed" data-speed="${preset.id}" aria-pressed="${speedSetting === preset.id}">${preset.label}</button>`,
          ).join('')}
        </div>
        <button class="audio-toggle-button" type="button" data-action="toggle-audio" data-audio-toggle>${getAudioToggleLabel()}</button>
      </div>
    </section>
  `;
}

function renderFrogCatalogMenu(): string {
  const ship = getShipCatalogEntry(selectedCatalogShipId);
  const spec = SHIP_SPECS[selectedCatalogShipId];
  const metadata = SHIP_CATALOG_METADATA[selectedCatalogShipId];
  const primaryReadout = getCatalogPrimaryReadout(selectedCatalogShipId);
  const secondaryReadout = getCatalogSecondaryReadout(selectedCatalogShipId);
  const turnDegreesPerSecond = turnStepToDegreesPerSecond(spec.turnStep);
  const fastestTurnDegreesPerSecond = Math.max(...Object.values(SHIP_SPECS).map((shipSpec) => turnStepToDegreesPerSecond(shipSpec.turnStep)));
  const weaponStats = getCatalogWeaponStats(selectedCatalogShipId);
  const stats: readonly ShipCatalogStat[] = [
    { label: 'Crew Complement', value: ship.crew, max: 40, display: String(ship.crew) },
    { label: 'Fuel Capacity', value: ship.battery, max: 40, display: String(ship.battery) },
    { label: 'Fuel Regen.', value: 90 - spec.batteryChargeFrames, max: 90, display: `${spec.batteryChargeFrames}f cycle` },
    { label: 'Acceleration', value: fixedToNumber(spec.accel), max: 0.22, display: formatDecimal(fixedToNumber(spec.accel), 3) },
    { label: 'Turn Speed', value: turnDegreesPerSecond, max: fastestTurnDegreesPerSecond, display: `${Math.round(turnDegreesPerSecond)} deg/s` },
    { label: 'Max Velocity', value: fixedToNumber(spec.maxSpeed), max: 5.2, display: formatDecimal(fixedToNumber(spec.maxSpeed), 2) },
    weaponStats.range,
    ...weaponStats.damage,
  ];
  return `
    <section
      class="ship-catalog-screen"
      style="--catalog-space: url('${legacyAssets.space3.url}');"
      aria-label="Ship catalog"
    >
      <aside class="ship-catalog-sidebar" aria-label="Catalog entries">
        <p class="menu-kicker">Ship Catalog</p>
        <h2>Technical Index</h2>
        <div class="ship-catalog-entry-list">
          ${CATALOG_PREVIEW_SHIP_IDS.map((shipId) => renderCatalogIndexEntry(shipId)).join('')}
        </div>
        <p class="ship-catalog-sidebar-note">Additional vessels pending hazardous materials review.</p>
        <button type="button" data-action="back">Back</button>
      </aside>

      <article class="ship-spec-sheet" aria-label="${ship.name} technical poster">
        <header class="ship-spec-header">
          <div>
            <p class="ship-spec-registry">${metadata.registryCode}</p>
            <h2>${ship.name}</h2>
            <p>${metadata.role}</p>
          </div>
          <div class="ship-spec-cost" aria-label="Point cost">
            <span>Points</span>
            <strong>${ship.cost}</strong>
          </div>
        </header>

        <div class="ship-spec-body">
          <section class="ship-diagram-panel" aria-label="${ship.name} diagram">
            <div class="ship-diagram-grid" aria-hidden="true"></div>
            ${metadata.callouts.map(renderShipCallout).join('')}
            ${renderCatalogShipDiagramArt(selectedCatalogShipId)}
          </section>

          <aside class="ship-spec-readout" aria-label="${ship.name} readout">
            <div class="ship-spec-portrait">
              <img class="ship-spec-portrait-main" src="${legacyAssets[ship.hud.portraitKey].url}" alt="${ship.name} portrait" />
              ${renderCatalogPortraitPips(selectedCatalogShipId)}
            </div>
            <section>
              <h3>Primary</h3>
              <p><strong>${metadata.primaryName}</strong></p>
              <p>${primaryReadout}</p>
            </section>
            <section>
              <h3>Secondary</h3>
              <p><strong>${metadata.secondaryName}</strong></p>
              <p>${secondaryReadout}</p>
            </section>
          </aside>
        </div>

        <footer class="ship-spec-footer">
          <dl class="ship-spec-stats">
            ${stats.map(renderShipCatalogStat).join('')}
          </dl>
        </footer>
      </article>
    </section>
  `;
}

function renderCatalogPortraitPips(shipId: CatalogPreviewShipId): string {
  if (shipId !== 'pscout') {
    return '';
  }

  return `
    <div class="ship-spec-portrait-pips" aria-label="pScout command portraits">
      <figure>
        <img src="${legacyAssets.pscoutPortraitAdmiral.url}" alt="pScout admiral portrait" />
        <figcaption>Admiral</figcaption>
      </figure>
      <figure>
        <img src="${legacyAssets.pscoutPortraitYgun.url}" alt="pScout carrier portrait" />
        <figcaption>Carrier</figcaption>
      </figure>
    </div>
  `;
}

function renderCatalogShipDiagramArt(shipId: CatalogPreviewShipId): string {
  return renderUiShipArt(shipId, 'ship-diagram-art', CATALOG_DIAGRAM_SCALE_MULTIPLIER);
}

function renderCatalogShipListArt(shipId: CatalogPreviewShipId): string {
  return renderUiShipArt(shipId, 'ship-catalog-sidebar-thumb', CATALOG_LIST_SCALE_MULTIPLIER);
}

function renderUiShipArt(shipId: ShipCatalogId, className: string, scaleMultiplier: number): string {
  const ship = getShipCatalogEntry(shipId);
  const layers = getUiShipLayers(shipId, scaleMultiplier);
  return `
    <div class="ui-ship-art ${className}">
      ${layers
        .map(
          (layer, index) =>
            `<img
              class="${layer.className ?? ''}"
              src="${legacyAssets[layer.key].url}"
              alt="${index === 0 ? `${ship.name} ship` : ''}"
              ${index === 0 ? '' : 'aria-hidden="true"'}
              style="--catalog-ship-scale: ${layer.scale}; --catalog-ship-offset-x: ${layer.offsetX ?? 0}px; --catalog-ship-offset-y: ${layer.offsetY ?? 0}px;"
            />`,
        )
        .join('')}
    </div>
  `;
}

function getUiShipLayers(shipId: ShipCatalogId, scaleMultiplier: number): readonly UiShipArtLayer[] {
  const ship = getShipCatalogEntry(shipId);
  const scale = ship.render.scale * scaleMultiplier;
  switch (shipId) {
    case 'frog':
      return [{ key: 'frogShip', scale }];
    case 'cannonade':
      return [
        { key: 'cannonadeBase', scale },
        { key: 'cannonadeBarrel', scale, className: 'ship-diagram-part-cannonade-barrel' },
      ];
    case 'zizlik':
      return [
        { key: 'zizlikRing', scale, className: 'ship-diagram-part-zizlik-ring' },
        { key: 'zizlikCore', scale, className: 'ship-diagram-part-zizlik-core' },
      ];
    case 'voskum':
      return [{ key: 'voskumShip', scale }];
    case 'pscout':
      return [
        { key: 'pscoutBeacon', scale: scaleMultiplier, offsetX: -15 * scaleMultiplier },
        { key: 'pscoutShip', scale },
      ];
    case 'kron':
      return [{ key: 'kronShip', scale }];
    case 'gooj':
      return [{ key: 'goojShip', scale }];
    case 'krab':
      return [
        { key: 'krabShip2', scale, offsetX: -34 * scaleMultiplier },
        { key: 'krabShip', scale, offsetX: 34 * scaleMultiplier },
      ];
    case 'nurtip':
      return [
        { key: 'nurtipShip', scale },
        { key: 'nurtipBarrel1', scale: scale * 1.1, offsetY: -17.25 * scaleMultiplier },
      ];
    case 'duk':
      return [
        { key: 'dukShip', scale },
        { key: 'dukMissile', scale, offsetX: -25 * scaleMultiplier },
        { key: 'dukMissile', scale, offsetX: -13 * scaleMultiplier },
        { key: 'dukMissile', scale, offsetX: 13 * scaleMultiplier },
        { key: 'dukMissile', scale, offsetX: 25 * scaleMultiplier },
      ];
    case 'discfighter':
      return [
        { key: 'discfighterShip', scale },
        { key: 'discfighterDisc', scale, offsetX: -28 * scaleMultiplier },
      ];
    case 'doubleship':
      return [
        { key: 'doubleshipShip', scale, offsetX: -15 * scaleMultiplier },
        { key: 'doubleshipShip', scale, offsetX: 15 * scaleMultiplier },
      ];
    case 'bolter':
      return [
        { key: 'bolterBottom', scale },
        { key: 'bolterLeftArm', scale },
        { key: 'bolterRightArm', scale },
        { key: 'bolterTop', scale },
      ];
    case 'shugg':
      return [{ key: 'shuggShip', scale }];
  }
}

function renderCatalogIndexEntry(shipId: CatalogPreviewShipId): string {
  const ship = getShipCatalogEntry(shipId);
  const metadata = SHIP_CATALOG_METADATA[shipId];
  const active = shipId === selectedCatalogShipId;
  return `
    <button
      class="ship-catalog-list-entry${active ? ' ship-catalog-list-entry-active' : ''}"
      type="button"
      data-action="catalog-pick"
      data-ship-id="${shipId}"
      aria-pressed="${active}"
    >
      ${renderCatalogShipListArt(shipId)}
      <span>
        <strong>${ship.name}</strong>
        <small>${metadata.registryCode}</small>
      </span>
    </button>
  `;
}

function getCatalogPrimaryReadout(shipId: CatalogPreviewShipId): string {
  const spec = SHIP_SPECS[shipId];
  switch (shipId) {
    case 'frog': {
      const maxCharge = 8;
      const chargeInterval = 50;
      return `Hold primary to charge: 1 fuel every ${chargeInterval}f, up to ${maxCharge} charge. Releasing fires the stored bubble and starts a ${spec.primary.framesPerShot}f recycle.`;
    }
    case 'cannonade':
      return `Fires from the independent cannon angle. Costs ${spec.primary.cost} fuel and recycles in ${spec.primary.framesPerShot}f.`;
    case 'zizlik':
      return `Each active origin fires one shot upward and one downward. Costs ${spec.primary.cost} fuel and recycles in ${spec.primary.framesPerShot}f.`;
    case 'voskum':
      return `Fires from one of three nearby muzzle offsets. Costs ${spec.primary.cost} fuel and recycles quickly in ${spec.primary.framesPerShot}f.`;
    case 'pscout':
      return `Launches a beacon that attaches to the enemy on hit. Costs ${spec.primary.cost} fuel and recycles in ${spec.primary.framesPerShot}f.`;
    case 'kron':
      return `Projects a short forward beam scan while firing. Costs ${spec.primary.cost} fuel, recycles in ${spec.primary.framesPerShot}f, and only hits targets crossing the beam path.`;
    case 'gooj':
      return `Launches a guided cocktail torpedo from a random nearby muzzle offset. Costs ${spec.primary.cost} fuel and recycles in ${spec.primary.framesPerShot}f.`;
    case 'krab':
      return `Default mode fires four randomized close-range shots; long mode fires one faster straight shot. Both cost ${spec.primary.cost} fuel.`;
    case 'nurtip':
      return `Launches one remote torpedo for ${spec.primary.cost} fuel. The launcher stays armed until the missile is released, hits, expires, or is detonated.`;
    case 'duk':
      return `Fires a slightly inaccurate stunner for ${spec.primary.cost} fuel. It starts nearly inert, ramps up over time, and briefly freezes on hit.`;
    case 'discfighter':
      return `Launches one remote disc for ${spec.primary.cost} fuel. Hold primary to keep it thrusting, release to park it, then press again to dock.`;
    case 'doubleship':
      return `Fires two instant forward laser lanes from offset hulls. Costs ${spec.primary.cost} fuel and recycles in ${spec.primary.framesPerShot}f.`;
  }
}

function getCatalogSecondaryReadout(shipId: CatalogPreviewShipId): string {
  const spec = SHIP_SPECS[shipId];
  switch (shipId) {
    case 'frog':
      return `Costs ${spec.secondary.cost} fuel and arms a shield membrane. The next non-piercing hit is reduced, then the shield is consumed. Recycles in ${spec.secondary.framesPerShot}f.`;
    case 'cannonade':
      return `Launches one active tracking boomerang. Costs ${spec.secondary.cost} fuel and reloads after the active boomerang clears.`;
    case 'zizlik':
      return `Costs ${spec.secondary.cost} fuel to attach a side node, first right then left. Recycles in ${spec.secondary.framesPerShot}f, and each node can be destroyed independently.`;
    case 'voskum':
      return `Costs ${spec.secondary.cost} fuel to blink in a random direction. Recycles in ${spec.secondary.framesPerShot}f and leaves a short teleport-imprint visual trail.`;
    case 'pscout':
      return `Costs ${spec.secondary.cost} fuel and requires at least one enemy beacon. Consumes all enemy beacons, then applies beam damage after a short delay.`;
    case 'kron':
      return `Costs ${spec.secondary.cost} fuel and freezes the enemy ship when one is alive. Recycles in ${spec.secondary.framesPerShot}f.`;
    case 'gooj':
      return `Costs ${spec.secondary.cost} fuel to dump eight junk projectiles from the aft chute. Each piece gets randomized speed, angle, variety, and lifespan.`;
    case 'krab':
      return `Costs ${spec.secondary.cost} fuel to toggle between short-spread mode and long-range mode. Movement stats and primary fire swap immediately.`;
    case 'nurtip':
      return `Costs ${spec.secondary.cost} fuel to seed an orbiting asteroid. Asteroids drift outward, then settle into rotating slots around the ship.`;
    case 'duk': {
      const missileCount = 4;
      return `Costs ${spec.secondary.cost} fuel to launch one rack missile, with ${missileCount} missiles available per ship. Recycles in ${spec.secondary.framesPerShot}f.`;
    }
    case 'discfighter':
      return `Costs ${spec.secondary.cost} fuel to shock targets near the tether line from ship to deployed disc. Recycles in ${spec.secondary.framesPerShot}f.`;
    case 'doubleship':
      return `Costs ${spec.secondary.cost} fuel to reverse velocity, flip facing, splay the hulls, and damage nearby targets in a 300u burst.`;
  }
}

function getCatalogWeaponStats(shipId: CatalogPreviewShipId): {
  readonly range: ShipCatalogStat;
  readonly damage: readonly ShipCatalogStat[];
} {
  const spec = SHIP_SPECS[shipId];
  switch (shipId) {
    case 'frog': {
      const maxCharge = 8;
      const baseRange = fixedToNumber(spec.primary.speed) * spec.primary.ttl;
      const maxRange = fixedToNumber(spec.primary.speed) * (spec.primary.ttl + 6 * maxCharge);
      return {
        range: { label: 'Weapon Range', value: maxRange, max: 2200, display: `${Math.round(baseRange)}-${Math.round(maxRange)}u` },
        damage: [{ label: 'Weapon Damage', value: maxCharge, max: 8, display: `${spec.primary.damage}-${maxCharge}` }],
      };
    }
    case 'cannonade': {
      const primaryRange = fixedToNumber(spec.primary.speed) * spec.primary.ttl;
      const secondaryRange = fixedToNumber(spec.secondary.speed) * spec.secondary.ttl;
      return {
        range: {
          label: 'Weapon Range',
          value: Math.max(primaryRange, secondaryRange),
          max: 3000,
          display: `${Math.round(primaryRange)} / ${Math.round(secondaryRange)}u`,
          stackedBars: [
            { label: 'Primary', value: primaryRange, max: 3000, display: `${Math.round(primaryRange)}u` },
            { label: 'Secondary', value: secondaryRange, max: 3000, display: `${Math.round(secondaryRange)}u` },
          ],
        },
        damage: [
          {
            label: 'Weapon Damage',
            value: spec.primary.damage,
            max: 8,
            display: `${spec.primary.damage} / ${spec.secondary.damage}`,
            stackedBars: [
              { label: 'Primary', value: spec.primary.damage, max: 8, display: String(spec.primary.damage) },
              { label: 'Secondary', value: spec.secondary.damage, max: 8, display: String(spec.secondary.damage) },
            ],
          },
        ],
      };
    }
    case 'zizlik': {
      const range = fixedToNumber(spec.primary.speed) * spec.primary.ttl;
      const maxVolleyDamage = spec.primary.damage * 6;
      return {
        range: { label: 'Weapon Range', value: range, max: 2200, display: `${Math.round(range)}u` },
        damage: [{ label: 'Volley Damage', value: maxVolleyDamage, max: 8, display: `2-6 x ${spec.primary.damage}` }],
      };
    }
    case 'voskum': {
      const range = fixedToNumber(spec.primary.speed) * spec.primary.ttl;
      return {
        range: { label: 'Weapon Range', value: range, max: 2200, display: `${Math.round(range)}u` },
        damage: [{ label: 'Weapon Damage', value: spec.primary.damage, max: 8, display: String(spec.primary.damage) }],
      };
    }
    case 'pscout': {
      const range = fixedToNumber(spec.primary.speed) * spec.primary.ttl;
      return {
        range: { label: 'Beacon Range', value: range, max: 2200, display: `${Math.round(range)}u` },
        damage: [{ label: 'Beam Damage', value: 4, max: 8, display: 'beacons^2' }],
      };
    }
    case 'kron': {
      const beamRange = 32 * 10;
      return {
        range: { label: 'Beam Reach', value: beamRange, max: 2200, display: `${beamRange}u scan` },
        damage: [{ label: 'Weapon Damage', value: spec.primary.damage, max: 8, display: String(spec.primary.damage) }],
      };
    }
    case 'gooj': {
      const primaryRange = fixedToNumber(spec.primary.speed) * spec.primary.ttl;
      const secondaryRange = fixedToNumber(spec.secondary.speed) * spec.secondary.ttl;
      return {
        range: {
          label: 'Weapon Range',
          value: Math.max(primaryRange, secondaryRange),
          max: 2200,
          display: `${Math.round(primaryRange)} / ${Math.round(secondaryRange)}u`,
          stackedBars: [
            { label: 'Primary', value: primaryRange, max: 2200, display: `${Math.round(primaryRange)}u` },
            { label: 'Junk', value: secondaryRange, max: 2200, display: `${Math.round(secondaryRange)}u+` },
          ],
        },
        damage: [
          {
            label: 'Weapon Damage',
            value: 8,
            max: 8,
            display: `${spec.primary.damage} / 8 x ${spec.secondary.damage}`,
            stackedBars: [
              { label: 'Primary', value: spec.primary.damage, max: 8, display: String(spec.primary.damage) },
              { label: 'Junk', value: 8 * spec.secondary.damage, max: 8, display: `8 x ${spec.secondary.damage}` },
            ],
          },
        ],
      };
    }
    case 'krab': {
      const shortRange = fixedToNumber(spec.primary.speed) * spec.primary.ttl;
      const longPrimary = spec.longRange?.primary ?? spec.primary;
      const longRange = fixedToNumber(longPrimary.speed) * longPrimary.ttl;
      return {
        range: {
          label: 'Weapon Range',
          value: Math.max(shortRange, longRange),
          max: 2200,
          display: `${Math.round(shortRange)} / ${Math.round(longRange)}u`,
          stackedBars: [
            { label: 'Short', value: shortRange, max: 2200, display: `${Math.round(shortRange)}u` },
            { label: 'Long', value: longRange, max: 2200, display: `${Math.round(longRange)}u` },
          ],
        },
        damage: [
          {
            label: 'Volley Damage',
            value: 4 * spec.primary.damage,
            max: 8,
            display: `4 x ${spec.primary.damage} / ${longPrimary.damage}`,
            stackedBars: [
              { label: 'Short', value: 4 * spec.primary.damage, max: 8, display: `4 x ${spec.primary.damage}` },
              { label: 'Long', value: longPrimary.damage, max: 8, display: String(longPrimary.damage) },
            ],
          },
        ],
      };
    }
    case 'nurtip': {
      const primaryRange = fixedToNumber(spec.primary.speed) * spec.primary.ttl;
      const asteroidReach = 140;
      return {
        range: {
          label: 'Weapon Range',
          value: primaryRange,
          max: 3600,
          display: `${Math.round(primaryRange)}u / ${asteroidReach}u orbit`,
          stackedBars: [
            { label: 'Missile', value: primaryRange, max: 3600, display: `${Math.round(primaryRange)}u` },
            { label: 'Asteroid', value: asteroidReach, max: 3600, display: `${asteroidReach}u orbit` },
          ],
        },
        damage: [
          {
            label: 'Weapon Damage',
            value: spec.primary.damage,
            max: 8,
            display: `${spec.primary.damage} / 2 AOE / ${spec.secondary.damage}`,
            stackedBars: [
              { label: 'Hit', value: spec.primary.damage, max: 8, display: String(spec.primary.damage) },
              { label: 'Detonate', value: 2, max: 8, display: '2 AOE' },
              { label: 'Asteroid', value: spec.secondary.damage, max: 8, display: String(spec.secondary.damage) },
            ],
          },
        ],
      };
    }
    case 'duk': {
      const primaryRange = estimateDukStunnerRange(fixedToNumber(spec.primary.speed), spec.primary.ttl);
      const secondaryRange = fixedToNumber(spec.secondary.speed) * spec.secondary.ttl;
      return {
        range: {
          label: 'Weapon Range',
          value: Math.max(primaryRange, secondaryRange),
          max: 3000,
          display: `${Math.round(primaryRange)} / ${Math.round(secondaryRange)}u`,
          stackedBars: [
            { label: 'Stunner', value: primaryRange, max: 3000, display: `~${Math.round(primaryRange)}u ramp` },
            { label: 'Missile', value: secondaryRange, max: 3000, display: `${Math.round(secondaryRange)}u` },
          ],
        },
        damage: [
          {
            label: 'Weapon Damage',
            value: spec.secondary.damage,
            max: 10,
            display: `${spec.primary.damage} / ${spec.secondary.damage}`,
            stackedBars: [
              { label: 'Stunner', value: spec.primary.damage, max: 10, display: `${spec.primary.damage}+freeze` },
              { label: 'Missile', value: spec.secondary.damage, max: 10, display: String(spec.secondary.damage) },
            ],
          },
        ],
      };
    }
    case 'discfighter': {
      const controlRange = 900;
      return {
        range: {
          label: 'Weapon Range',
          value: controlRange,
          max: 3000,
          display: `${controlRange}u control / tether`,
          stackedBars: [
            { label: 'Disc Control', value: controlRange, max: 3000, display: `${controlRange}u` },
            { label: 'Shock Tether', value: controlRange, max: 3000, display: 'disc line' },
          ],
        },
        damage: [
          {
            label: 'Weapon Damage',
            value: spec.primary.damage,
            max: 8,
            display: `${spec.primary.damage} / ${spec.secondary.damage}`,
            stackedBars: [
              { label: 'Disc', value: spec.primary.damage, max: 8, display: String(spec.primary.damage) },
              { label: 'Shock', value: spec.secondary.damage, max: 8, display: String(spec.secondary.damage) },
            ],
          },
        ],
      };
    }
    case 'doubleship': {
      const beamRange = 32 * 10;
      const specialRange = 300;
      return {
        range: {
          label: 'Weapon Range',
          value: Math.max(beamRange, specialRange),
          max: 2200,
          display: `${beamRange}u beam / ${specialRange}u burst`,
          stackedBars: [
            { label: 'Dual Laser', value: beamRange, max: 2200, display: `${beamRange}u` },
            { label: 'Sidewinder Burst', value: specialRange, max: 2200, display: `${specialRange}u` },
          ],
        },
        damage: [
          {
            label: 'Weapon Damage',
            value: spec.primary.damage * 2,
            max: 8,
            display: `2 x ${spec.primary.damage} / ${spec.secondary.damage} AOE`,
            stackedBars: [
              { label: 'Dual Laser', value: spec.primary.damage * 2, max: 8, display: `2 x ${spec.primary.damage}` },
              { label: 'Sidewinder Burst', value: spec.secondary.damage, max: 8, display: `${spec.secondary.damage} AOE` },
            ],
          },
        ],
      };
    }
  }
}

function renderShipCallout(callout: ShipCatalogDisplayMetadata['callouts'][number]): string {
  return `
    <div class="ship-callout ship-callout-${callout.position}">
      <span>${callout.index}</span>
      <strong>${callout.title}</strong>
      <p>${callout.body}</p>
    </div>
  `;
}

function estimateDukStunnerRange(speed: number, ttl: number): number {
  const muzzleSpeedScale = 0.8;
  const slowTtl = 700;
  const rampFrames = 300;
  const legacyLifeDecay = 3;
  let range = 0;

  for (let remainingTtl = ttl - legacyLifeDecay; remainingTtl > slowTtl; remainingTtl -= legacyLifeDecay) {
    const lifeAboveSlow = Math.min(remainingTtl, slowTtl + rampFrames) - slowTtl;
    const thrustRatio = Math.max(0, 1 - (0.00333 * (rampFrames - lifeAboveSlow)) ** 2);
    range += speed * muzzleSpeedScale * thrustRatio;
  }

  return range;
}

function renderShipCatalogStat(stat: ShipCatalogStat): string {
  const bars = stat.stackedBars?.map(renderShipCatalogStatBar).join('') ?? renderShipCatalogStatBar(stat);
  return `
    <div>
      <dt>${stat.label}</dt>
      <dd>
        <span class="${stat.stackedBars ? 'ship-spec-stat-stack' : 'ship-spec-stat-stack ship-spec-stat-stack-single'}">
          ${bars}
        </span>
      </dd>
    </div>
  `;
}

function renderShipCatalogStatBar(stat: { readonly label?: string; readonly value: number; readonly max: number; readonly display: string }): string {
  const fill = Math.max(6, Math.min(100, Math.round((stat.value / stat.max) * 100)));
  const label = stat.label ? `<span>${stat.label}</span>` : '';
  return `
    <span class="ship-spec-stat-bar">
      <span class="ship-spec-stat-fill" style="width: ${fill}%"></span>
      <strong>${label}${stat.display}</strong>
    </span>
  `;
}

function formatDecimal(value: number, digits: number): string {
  return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function turnStepToDegreesPerSecond(turnStep: Fixed): number {
  return (fixedToNumber(turnStep) / ANGLE_STEPS) * 360 * SIM_FPS;
}

function getGameplaySettings(): GameplaySettings {
  return {
    gravityDivisor: lowGravityEnabled ? LOW_GRAVITY_DIVISOR : 1,
    speedMultiplier: getSelectedSpeedPreset().multiplier,
  };
}

function getLowGravityToggleLabel(): string {
  return `Low Gravity: ${lowGravityEnabled ? 'On' : 'Off'}`;
}

function getSelectedSpeedPreset(): (typeof SPEED_PRESETS)[number] {
  return SPEED_PRESETS.find((preset) => preset.id === speedSetting) ?? SPEED_PRESETS[0];
}

function isSpeedSetting(value: string | undefined): value is SpeedSetting {
  return SPEED_PRESETS.some((preset) => preset.id === value);
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
  const modeLabel = isNetwork ? 'Multiplayer' : 'Single Player';
  const detail = isNetwork
    ? 'Build your fleet here. After both players ready up, each player chooses a starting ship.'
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
        activeSide: 0,
        hideP2: true,
        readyLabel: isNetwork ? 'Ready Fleet' : 'Ready',
        backLabel: isNetwork ? 'Leave Match' : 'Back',
        fleetLabel: isNetwork ? 'Your Fleet' : 'P1 Fleet',
      })}
    </section>
  `;
}

function renderHotseatFleetBuildMenu(phase: Extract<AppPhase, { readonly name: 'hotseatFleetBuild' }>): string {
  const readyText = phase.ready.every(Boolean) ? 'Both players ready. Starting...' : 'Each player builds a fleet, then presses Ready.';
  return `
    <section
      class="fleet-builder-screen fleet-builder-screen-hotseat"
      style="--fleet-builder-space: url('${legacyAssets.space.url}'); --fleet-builder-space-alt: url('${legacyAssets.space3.url}');"
    >
      <header class="fleet-builder-header">
        <div>
          <p class="menu-kicker">Hotseat</p>
          <h2>Build Fleets</h2>
          <p>${readyText} Gamepad 1 controls P1, gamepad 2 controls P2.</p>
        </div>
      </header>
      <div class="fleet-builder-body">
        <div class="fleet-stage fleet-stage-hotseat" aria-label="Hotseat fleet rosters">
          ${renderHotseatFleetPanel(phase, 0)}
          ${renderHotseatFleetPanel(phase, 1)}
        </div>
      </div>
    </section>
  `;
}

function renderHotseatFleetPanel(phase: Extract<AppPhase, { readonly name: 'hotseatFleetBuild' }>, sideId: PlayerSide): string {
  const fleet = phase.fleets[sideId];
  const remaining = getRemainingBudget(fleet, phase.budget);
  const pickingSlotIndex = getFleetBuilderPickingSlotIndex(sideId);
  const ready = phase.ready[sideId];
  const pickerHtml = pickingSlotIndex !== null ? renderFleetShipPicker(remaining, pickingSlotIndex, sideId) : '';
  return renderFleetPanel({
    fleet,
    label: `${getSideName(sideId, 'hotseat')} Fleet`,
    sideId,
    isEditable: !ready,
    isHidden: false,
    pickerHtml,
    controlsHtml: renderFleetCommandBlock(
      remaining,
      fleet.length,
      ready ? 'Ready - Press To Edit' : 'Ready',
      sideId === 0 ? 'Back' : 'Back',
      pickingSlotIndex,
      sideId,
      ready,
    ),
  });
}

function renderFleetBuilderScreen(options: {
  readonly fleet: readonly FleetShip[];
  readonly budget: number;
  readonly remaining: number;
  readonly activeSide: 0 | 1;
  readonly hideP2: boolean;
  readonly readyLabel: string;
  readonly backLabel: string;
  readonly fleetLabel: string;
}): string {
  const fleets: readonly [readonly FleetShip[], readonly FleetShip[]] =
    options.activeSide === 0 ? [options.fleet, []] : [[], options.fleet];
  const pickingSlotIndex =
    fleetBuilderPickingSlotIndices[options.activeSide] !== null &&
    fleetBuilderPickingSlotIndices[options.activeSide] === options.fleet.length &&
    options.fleet.length < MAX_FLEET_SLOTS
      ? fleetBuilderPickingSlotIndices[options.activeSide]
      : null;
  return `
    <div class="fleet-builder-body">
      <div class="fleet-stage" aria-label="Fleet roster">
        ${renderFleetPanel({
          fleet: fleets[0],
          label: options.fleetLabel,
          sideId: 0,
          isEditable: options.activeSide === 0,
          isHidden: false,
          pickerHtml: pickingSlotIndex !== null && options.activeSide === 0 ? renderFleetShipPicker(options.remaining, pickingSlotIndex, 0) : '',
          controlsHtml:
            options.activeSide === 0
              ? renderFleetCommandBlock(options.remaining, options.fleet.length, options.readyLabel, options.backLabel, pickingSlotIndex, 0)
              : '',
        })}
        ${renderFleetPanel({
          fleet: fleets[1],
          label: 'P2 Fleet',
          sideId: 1,
          isEditable: options.activeSide === 1,
          isHidden: options.hideP2,
          pickerHtml: pickingSlotIndex !== null && options.activeSide === 1 ? renderFleetShipPicker(options.remaining, pickingSlotIndex, 1) : '',
          controlsHtml:
            options.activeSide === 1
              ? renderFleetCommandBlock(options.remaining, options.fleet.length, options.readyLabel, options.backLabel, pickingSlotIndex, 1)
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
  sideId: PlayerSide,
  isReady = false,
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
        ${isReady ? '<div><dt>Status</dt><dd>Ready</dd></div>' : ''}
      </dl>
      ${renderFleetCommandActions(fleetLength, readyLabel, backLabel, pickingSlotIndex, sideId)}
    </aside>
  `;
}

function renderFleetCommandActions(
  fleetLength: number,
  readyLabel: string,
  backLabel: string,
  pickingSlotIndex: number | null,
  sideId: PlayerSide,
): string {
  if (fleetBuilderConfirmingBack[sideId]) {
    return `
      <div class="fleet-command-actions">
        <button type="button" data-action="fleet-back-cancel" data-fleet-side="${sideId}" data-fleet-nav="command" data-fleet-nav-index="1">Stay</button>
        <button type="button" class="fleet-danger-button" data-action="fleet-back-confirm" data-fleet-side="${sideId}" data-fleet-nav="command" data-fleet-nav-index="2">Confirm ${backLabel}</button>
      </div>
    `;
  }

  const note = pickingSlotIndex === null ? '' : `<p class="fleet-command-note">Cancel returns to the fleet.</p>`;
  return `
    <div class="fleet-command-actions">
      <button type="button" data-action="fleet-ready" data-fleet-side="${sideId}" data-fleet-nav="command" data-fleet-nav-index="0" ${fleetLength === 0 ? 'disabled' : ''}>${readyLabel}</button>
      <button type="button" data-action="fleet-back-request" data-fleet-side="${sideId}" data-fleet-nav="command" data-fleet-nav-index="1">${backLabel}</button>
    </div>
    ${note}
  `;
}

function renderFleetShipPicker(remaining: number, slotIndex: number, sideId: PlayerSide): string {
  return `
    <section class="fleet-ship-picker" aria-label="Choose ship for slot ${slotIndex + 1}">
      ${renderShipCatalogGrid(remaining, sideId)}
    </section>
  `;
}

function renderFleetPanel(options: {
  readonly fleet: readonly FleetShip[];
  readonly label: string;
  readonly sideId: PlayerSide;
  readonly isEditable: boolean;
  readonly isHidden: boolean;
  readonly pickerHtml: string;
  readonly controlsHtml: string;
}): string {
  const hiddenClass = options.isHidden ? ' fleet-console-hidden' : '';
  const editableClass = options.isEditable ? ' fleet-console-active' : '';
  const pickingClass = options.pickerHtml ? ' fleet-console-picking' : '';
  const sideClass = options.sideId === 0 ? ' fleet-console-p1' : ' fleet-console-p2';
  const contentClass = options.controlsHtml ? ' fleet-console-content fleet-console-content-controls' : ' fleet-console-content';
  return `
    <section class="fleet-console${sideClass}${editableClass}${hiddenClass}${pickingClass}" aria-label="${options.label}" ${options.isHidden ? 'aria-hidden="true"' : ''}>
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
                ${renderFleetSlots(options.fleet, options.isEditable, options.sideId)}
              </div>
              ${options.controlsHtml}
            </div>
          `
      }
    </section>
  `;
}

function renderFleetSlots(fleet: readonly FleetShip[], isEditable: boolean, sideId: PlayerSide): string {
  const slots = Array.from({ length: MAX_FLEET_SLOTS }, (_, index) => renderFleetSlot(index, fleet[index], isEditable, fleet.length, sideId));
  return `<div class="fleet-slot-grid">${slots.join('')}</div>`;
}

function renderFleetSlot(index: number, fleetShip: FleetShip | undefined, isEditable: boolean, fleetLength: number, sideId: PlayerSide): string {
  if (!fleetShip) {
    const isNextOpenSlot = isEditable && index === fleetLength && fleetLength < MAX_FLEET_SLOTS;
    if (isNextOpenSlot) {
      return `
        <button
          type="button"
          class="fleet-slot fleet-slot-empty fleet-slot-open"
          data-action="fleet-slot-pick"
          data-fleet-side="${sideId}"
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
        ${renderUiShipArt(fleetShip.catalogId, 'fleet-slot-ship', FLEET_SLOT_ART_SCALE_MULTIPLIER)}
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
      data-fleet-side="${sideId}"
      data-fleet-uid="${fleetShip.uid}"
      data-fleet-nav="slot"
      data-fleet-nav-index="${index}"
      aria-label="Remove ${ship.name} from slot ${index + 1}"
    >
      <span class="fleet-slot-number">${index + 1}</span>
      ${renderUiShipArt(fleetShip.catalogId, 'fleet-slot-ship', FLEET_SLOT_ART_SCALE_MULTIPLIER)}
      <span class="fleet-slot-name">${ship.name}</span>
      <span class="fleet-slot-cost">${ship.cost}</span>
    </button>
  `;
}

function renderShipCatalogGrid(remaining: number, sideId: PlayerSide): string {
  return `
    <div class="fleet-catalog-grid">
      ${SHIP_CATALOG.map((ship, index) => renderCatalogCard(ship.id, remaining, index, sideId)).join('')}
    </div>
  `;
}

function renderCatalogCard(shipId: ShipCatalogId, remaining: number, catalogIndex = 0, sideId: PlayerSide = 0): string {
  const ship = getShipCatalogEntry(shipId);
  const disabled = ship.cost > remaining ? 'disabled' : '';
  return `
    <button
      type="button"
      class="fleet-picker-ship"
      data-action="fleet-pick-ship"
      data-fleet-side="${sideId}"
      data-ship-id="${ship.id}"
      data-fleet-nav="picker"
      data-fleet-nav-index="${catalogIndex}"
      ${disabled}
    >
      ${renderFleetPickerShipArt(ship.id)}
      <div>
        <h3>${ship.name}</h3>
      </div>
      <p class="fleet-picker-ship-cost">${ship.cost}</p>
    </button>
  `;
}

function renderFleetPickerShipArt(shipId: ShipCatalogId): string {
  return renderUiShipArt(shipId, 'fleet-picker-catalog-art', FLEET_PICKER_ART_SCALE_MULTIPLIER);
}

function isFleetBuilderPhase(): boolean {
  return appPhase.name === 'fleetBuild' || appPhase.name === 'networkFleetBuild' || appPhase.name === 'hotseatFleetBuild';
}

function getNetworkLocalSide(role: ConnectionRole): PlayerSide {
  return role === 'host' ? 0 : 1;
}

function getNetworkRemoteSide(role: ConnectionRole): PlayerSide {
  return role === 'host' ? 1 : 0;
}

function isShipSelectPhase(): boolean {
  return appPhase.name === 'shipSelect' || appPhase.name === 'hotseatShipSelect' || appPhase.name === 'networkShipSelect';
}

function handleFleetBuilderKeyboardNav(event: KeyboardEvent): boolean {
  if (!isFleetBuilderPhase()) {
    return false;
  }

  const directionInput = readFleetBuilderKeyboardDirectionInput(event.code);
  if (directionInput) {
    event.preventDefault();
    focusFleetBuilderNav(directionInput.direction, directionInput.sideId);
    return true;
  }

  const activateSide = readFleetBuilderKeyboardActivateSide(event.code);
  if (activateSide !== null) {
    event.preventDefault();
    activateFleetBuilderFocusedControl(activateSide);
    return true;
  }

  const cancelSide = readFleetBuilderKeyboardCancelSide(event.code);
  if (cancelSide !== null) {
    event.preventDefault();
    activateFleetBuilderBackControl(cancelSide);
    return true;
  }

  return false;
}

function handleShipSelectKeyboardNav(event: KeyboardEvent): boolean {
  if (!isShipSelectPhase()) {
    return false;
  }

  const directionInput = readShipSelectKeyboardDirection(event.code);
  if (directionInput) {
    event.preventDefault();
    focusShipSelectNav(directionInput.direction, directionInput.sideId);
    return true;
  }

  const activateSide = readShipSelectKeyboardActivateSide(event.code);
  if (activateSide !== null) {
    event.preventDefault();
    activateShipSelectFocusedControl(activateSide);
    return true;
  }

  const cancelSide = readShipSelectKeyboardCancelSide(event.code);
  if (cancelSide !== null) {
    event.preventDefault();
    cancelShipSelectForSide(cancelSide);
    return true;
  }

  return false;
}

function updateFleetBuilderGamepadNav(): void {
  if (!isFleetBuilderPhase()) {
    previousFleetBuilderInputs = [0, 0];
    fleetBuilderNavRepeatFrames = [0, 0];
    return;
  }

  if (appPhase.name === 'hotseatFleetBuild') {
    updateFleetBuilderGamepadNavForSide(0);
    updateFleetBuilderGamepadNavForSide(1);
    return;
  }

  previousFleetBuilderInputs[1] = 0;
  fleetBuilderNavRepeatFrames[1] = 0;
  clearPlayerInteractionIndicator('fleet', 1);
  updateFleetBuilderGamepadNavForSide(0, 0);
}

function updateShipSelectGamepadNav(): void {
  if (!isShipSelectPhase()) {
    previousShipSelectInputs = [0, 0];
    shipSelectNavRepeatFrames = [0, 0];
    return;
  }

  if (appPhase.name === 'hotseatShipSelect') {
    updateShipSelectGamepadNavForSide(0);
    updateShipSelectGamepadNavForSide(1);
    return;
  }

  const sideId = getDefaultShipSelectSide();
  const inactiveSideId = sideId === 0 ? 1 : 0;
  previousShipSelectInputs[inactiveSideId] = 0;
  shipSelectNavRepeatFrames[inactiveSideId] = 0;
  clearPlayerInteractionIndicator('shipSelect', inactiveSideId);
  updateShipSelectGamepadNavForSide(sideId, 0);
}

function updateShipSelectGamepadNavForSide(sideId: PlayerSide, inputIndex: number = sideId): void {
  if (!isShipSelectSideActive(sideId)) {
    previousShipSelectInputs[sideId] = 0;
    shipSelectNavRepeatFrames[sideId] = 0;
    clearPlayerInteractionIndicator('shipSelect', sideId);
    return;
  }

  const input = readGamepadMenuInput(inputIndex);
  const pressed = input & ~previousShipSelectInputs[sideId];
  if (shipSelectNavRepeatFrames[sideId] > 0) {
    shipSelectNavRepeatFrames[sideId] -= 1;
  }

  const direction =
    readFleetBuilderInputDirection(pressed) ?? (shipSelectNavRepeatFrames[sideId] === 0 ? readFleetBuilderInputDirection(input) : null);
  if (direction) {
    focusShipSelectNav(direction, sideId);
    shipSelectNavRepeatFrames[sideId] = FLEET_NAV_REPEAT_FRAMES;
  } else if (input === 0) {
    shipSelectNavRepeatFrames[sideId] = 0;
  }

  if ((pressed & MenuInputBits.Primary) !== 0) {
    activateShipSelectFocusedControl(sideId);
  } else if ((pressed & MenuInputBits.Secondary) !== 0) {
    cancelShipSelectForSide(sideId);
  }

  previousShipSelectInputs[sideId] = input;
}

function updateFleetBuilderGamepadNavForSide(sideId: PlayerSide, inputIndex: number = sideId): void {
  const input = readGamepadMenuInput(inputIndex);
  const pressed = input & ~previousFleetBuilderInputs[sideId];
  if (fleetBuilderNavRepeatFrames[sideId] > 0) {
    fleetBuilderNavRepeatFrames[sideId] -= 1;
  }

  const direction =
    readFleetBuilderInputDirection(pressed) ?? (fleetBuilderNavRepeatFrames[sideId] === 0 ? readFleetBuilderInputDirection(input) : null);
  if (direction) {
    focusFleetBuilderNav(direction, sideId);
    fleetBuilderNavRepeatFrames[sideId] = FLEET_NAV_REPEAT_FRAMES;
  } else if (input === 0) {
    fleetBuilderNavRepeatFrames[sideId] = 0;
  }

  if ((pressed & MenuInputBits.Primary) !== 0) {
    activateFleetBuilderFocusedControl(sideId);
  } else if ((pressed & MenuInputBits.Secondary) !== 0) {
    activateFleetBuilderBackControl(sideId);
  }

  previousFleetBuilderInputs[sideId] = input;
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

function readFleetBuilderKeyboardDirectionInput(code: string): { readonly sideId: PlayerSide; readonly direction: FleetBuilderNavDirection } | null {
  const p1Direction = readFleetBuilderKeyboardDirection(code);
  if (p1Direction) {
    return { sideId: 0, direction: p1Direction };
  }

  if (appPhase.name !== 'hotseatFleetBuild') {
    return null;
  }

  switch (code) {
    case 'KeyI':
      return { sideId: 1, direction: 'up' };
    case 'KeyK':
      return { sideId: 1, direction: 'down' };
    case 'KeyJ':
      return { sideId: 1, direction: 'left' };
    case 'KeyL':
      return { sideId: 1, direction: 'right' };
    default:
      return null;
  }
}

function readFleetBuilderKeyboardActivateSide(code: string): PlayerSide | null {
  if (code === 'Space') {
    return 0;
  }

  if (code === 'Enter' || code === 'NumpadEnter') {
    return appPhase.name === 'hotseatFleetBuild' ? 1 : 0;
  }

  return null;
}

function readFleetBuilderKeyboardCancelSide(code: string): PlayerSide | null {
  if (code === 'KeyE' || code === 'Escape') {
    return 0;
  }

  if (code === 'KeyO' && appPhase.name === 'hotseatFleetBuild') {
    return 1;
  }

  return null;
}

function readShipSelectKeyboardDirection(code: string): { readonly sideId: PlayerSide; readonly direction: FleetBuilderNavDirection } | null {
  const p1Direction = readFleetBuilderKeyboardDirection(code);
  if (p1Direction) {
    return { sideId: getDefaultShipSelectSide(), direction: p1Direction };
  }

  if (appPhase.name !== 'hotseatShipSelect') {
    return null;
  }

  switch (code) {
    case 'KeyI':
      return { sideId: 1, direction: 'up' };
    case 'KeyK':
      return { sideId: 1, direction: 'down' };
    case 'KeyJ':
      return { sideId: 1, direction: 'left' };
    case 'KeyL':
      return { sideId: 1, direction: 'right' };
    default:
      return null;
  }
}

function readShipSelectKeyboardActivateSide(code: string): PlayerSide | null {
  if (code === 'Space') {
    return getDefaultShipSelectSide();
  }

  if (code === 'Enter' || code === 'NumpadEnter') {
    return appPhase.name === 'hotseatShipSelect' ? 1 : getDefaultShipSelectSide();
  }

  return null;
}

function readShipSelectKeyboardCancelSide(code: string): PlayerSide | null {
  if (code === 'KeyE' || code === 'Escape') {
    return getDefaultShipSelectSide();
  }

  if (code === 'KeyO' && appPhase.name === 'hotseatShipSelect') {
    return 1;
  }

  return null;
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
      if (appPhase.name === 'hotseatFleetBuild') {
        restoreFleetBuilderFocus(0);
        restoreFleetBuilderFocus(1);
      } else {
        restoreFleetBuilderFocus(0);
        clearPlayerInteractionIndicator('fleet', 1);
      }
    }
  }, 0);
}

function restoreFleetBuilderFocus(sideId: PlayerSide): HTMLButtonElement | null {
  const activeButton = getActiveFleetBuilderButton(sideId);
  if (activeButton) {
    rememberFleetBuilderNavTarget(activeButton, sideId);
    return activeButton;
  }

  const buttons = getFleetBuilderNavButtons(sideId);
  const previousTarget = fleetBuilderNavTargets[sideId];
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
    rememberFleetBuilderNavTarget(targetButton, sideId);
  }
  return targetButton;
}

function queueShipSelectFocusRestore(): void {
  window.setTimeout(() => {
    if (isShipSelectPhase()) {
      if (appPhase.name === 'hotseatShipSelect') {
        for (const sideId of [0, 1] as const) {
          if (isShipSelectSideActive(sideId)) {
            restoreShipSelectFocus(sideId);
          } else {
            clearPlayerInteractionIndicator('shipSelect', sideId);
          }
        }
      } else {
        const sideId = getDefaultShipSelectSide();
        restoreShipSelectFocus(sideId);
        clearPlayerInteractionIndicator('shipSelect', sideId === 0 ? 1 : 0);
      }
    }
  }, 0);
}

function restoreShipSelectFocus(sideId: PlayerSide): HTMLButtonElement | null {
  if (!isShipSelectSideActive(sideId)) {
    return null;
  }

  const activeButton = getActiveShipSelectButton(sideId);
  if (activeButton) {
    rememberShipSelectNavTarget(activeButton, sideId);
    return activeButton;
  }

  const buttons = getShipSelectNavButtons(sideId);
  const previousTarget = shipSelectNavTargets[sideId];
  const targetButton =
    (previousTarget ? buttons.find((button) => Number(button.dataset.shipSelectNavIndex) === previousTarget.index) : null) ?? buttons[0] ?? null;

  targetButton?.focus();
  if (targetButton) {
    rememberShipSelectNavTarget(targetButton, sideId);
  }
  return targetButton;
}

function focusFleetBuilderNav(direction: FleetBuilderNavDirection, sideId: PlayerSide = 0): void {
  const buttons = getFleetBuilderNavButtons(sideId);
  const current = getActiveFleetBuilderButton(sideId) ?? restoreFleetBuilderFocus(sideId);
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
    rememberFleetBuilderNavTarget(bestButton, sideId);
  }
}

function focusShipSelectNav(direction: FleetBuilderNavDirection, sideId: PlayerSide = 0): void {
  if (!isShipSelectSideActive(sideId)) {
    return;
  }

  const buttons = getShipSelectNavButtons(sideId);
  const current = getActiveShipSelectButton(sideId) ?? restoreShipSelectFocus(sideId);
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
    rememberShipSelectNavTarget(bestButton, sideId);
  }
}

function activateFleetBuilderFocusedControl(sideId: PlayerSide = 0): void {
  const button = getActiveFleetBuilderButton(sideId) ?? restoreFleetBuilderFocus(sideId);
  button?.click();
}

function activateShipSelectFocusedControl(sideId: PlayerSide = 0): void {
  const button = getActiveShipSelectButton(sideId) ?? restoreShipSelectFocus(sideId);
  button?.click();
}

function cancelShipSelectForSide(sideId: PlayerSide): void {
  if (appPhase.name !== 'hotseatShipSelect' || appPhase.selectingSideIds.includes(sideId)) {
    return;
  }

  if (appPhase.session.selectedShipUids[sideId] === null) {
    return;
  }

  const selectingSideIds = [...appPhase.selectingSideIds, sideId].sort((left, right) => left - right) as PlayerSide[];
  appPhase = {
    ...appPhase,
    session: withoutSelectedShip(appPhase.session, sideId),
    selectingSideIds,
    message: `${getSideName(sideId, 'hotseat')} canceled their pick. Choose a ship.`,
  };
  shipSelectNavTargets[sideId] = null;
  renderMenu();
}

function activateFleetBuilderBackControl(sideId: PlayerSide = 0): void {
  if (fleetBuilderPickingSlotIndices[sideId] !== null) {
    cancelFleetBuilderShipPicker(sideId);
    return;
  }

  if (fleetBuilderConfirmingBack[sideId]) {
    cancelFleetBuilderBackConfirmation(sideId);
    return;
  }

  const backButton = menuOverlay.querySelector<HTMLButtonElement>(`button[data-action="fleet-back-request"][data-fleet-side="${sideId}"]`);
  backButton?.click();
}

function getActiveFleetBuilderButton(sideId: PlayerSide): HTMLButtonElement | null {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLButtonElement) ||
    !menuOverlay.contains(active) ||
    !active.dataset.fleetNav ||
    active.dataset.fleetSide !== String(sideId) ||
    active.disabled
  ) {
    return null;
  }

  return active;
}

function getFleetBuilderNavButtons(sideId: PlayerSide): HTMLButtonElement[] {
  return Array.from(menuOverlay.querySelectorAll<HTMLButtonElement>(`button[data-fleet-nav][data-fleet-side="${sideId}"]`)).filter(
    (button) => !button.disabled,
  );
}

function getActiveShipSelectButton(sideId: PlayerSide): HTMLButtonElement | null {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLButtonElement) ||
    !menuOverlay.contains(active) ||
    !active.dataset.shipSelectNav ||
    active.dataset.fleetSide !== String(sideId) ||
    active.disabled
  ) {
    return null;
  }

  return active;
}

function getShipSelectNavButtons(sideId: PlayerSide): HTMLButtonElement[] {
  return Array.from(menuOverlay.querySelectorAll<HTMLButtonElement>(`button[data-ship-select-nav][data-fleet-side="${sideId}"]`)).filter(
    (button) => !button.disabled,
  );
}

function rememberFleetBuilderNavTarget(button: HTMLButtonElement, sideId: PlayerSide): void {
  const index = Number(button.dataset.fleetNavIndex);
  fleetBuilderNavTargets[sideId] = {
    nav: button.dataset.fleetNav ?? 'catalog',
    index: Number.isFinite(index) ? index : 0,
  };
  updatePlayerInteractionIndicator('fleet', sideId, button);
}

function rememberShipSelectNavTarget(button: HTMLButtonElement, sideId: PlayerSide): void {
  const index = Number(button.dataset.shipSelectNavIndex);
  shipSelectNavTargets[sideId] = {
    nav: button.dataset.shipSelectNav ?? 'slot',
    index: Number.isFinite(index) ? index : 0,
  };
  updatePlayerInteractionIndicator('shipSelect', sideId, button);
}

function updatePlayerInteractionIndicator(kind: 'fleet' | 'shipSelect', sideId: PlayerSide, button: HTMLButtonElement): void {
  clearPlayerInteractionIndicator(kind, sideId);
  button.classList.add('player-interaction-active', sideId === 0 ? 'player-interaction-p1' : 'player-interaction-p2');
  button.dataset.playerIndicator = sideId === 0 ? 'P1' : 'P2';
}

function clearPlayerInteractionIndicator(kind: 'fleet' | 'shipSelect', sideId: PlayerSide): void {
  const selector = kind === 'fleet' ? `button[data-fleet-nav][data-fleet-side="${sideId}"]` : `button[data-ship-select-nav][data-fleet-side="${sideId}"]`;
  menuOverlay.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
    button.classList.remove('player-interaction-active', 'player-interaction-p1', 'player-interaction-p2');
    delete button.dataset.playerIndicator;
  });
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

function selectFleetBuilderSlot(slotIndex: number, sideId: PlayerSide = 0): void {
  const fleet = getEditableFleet(sideId);
  if (!fleet) {
    return;
  }

  if (slotIndex !== fleet.length || fleet.length >= MAX_FLEET_SLOTS) {
    return;
  }

  fleetBuilderPickingSlotIndices[sideId] = slotIndex;
  fleetBuilderConfirmingBack[sideId] = false;
  fleetBuilderNavTargets[sideId] = { nav: 'picker', index: 0 };
  renderMenu();
}

function cancelFleetBuilderShipPicker(sideId: PlayerSide = 0): void {
  const fleet = getEditableFleet(sideId);
  if (!fleet) {
    return;
  }

  const slotIndex = fleetBuilderPickingSlotIndices[sideId] ?? fleet.length;
  fleetBuilderPickingSlotIndices[sideId] = null;
  fleetBuilderConfirmingBack[sideId] = false;
  fleetBuilderNavTargets[sideId] = { nav: 'slot', index: Math.min(slotIndex, MAX_FLEET_SLOTS - 1) };
  renderMenu();
}

function requestFleetBuilderBackConfirmation(sideId: PlayerSide = 0): void {
  if (!isFleetBuilderPhase()) {
    return;
  }

  fleetBuilderPickingSlotIndices[sideId] = null;
  fleetBuilderConfirmingBack[sideId] = true;
  fleetBuilderNavTargets[sideId] = { nav: 'command', index: 1 };
  renderMenu();
}

function cancelFleetBuilderBackConfirmation(sideId: PlayerSide = 0): void {
  if (!isFleetBuilderPhase()) {
    return;
  }

  fleetBuilderConfirmingBack[sideId] = false;
  fleetBuilderNavTargets[sideId] = { nav: 'command', index: 1 };
  renderMenu();
}

function confirmFleetBuilderBack(): void {
  if (!isFleetBuilderPhase()) {
    return;
  }

  fleetBuilderConfirmingBack = [false, false];
  goBack();
}

function renderShipSelectMenu(phase: Extract<AppPhase, { readonly name: 'shipSelect' }>): string {
  return `
    <section class="menu-card menu-card-wide">
      ${renderMenuBrand()}
      <p class="menu-kicker">Choose Your Champion</p>
      <h2>Select Ship</h2>
      <p>${phase.message ?? 'The loser picks a new ship. The winner stays in the arena.'}</p>
      ${renderShipSelectFleetGrid(phase.session.fleets[0], 0)}
    </section>
  `;
}

function renderHotseatShipSelectMenu(phase: Extract<AppPhase, { readonly name: 'hotseatShipSelect' }>): string {
  return `
    <section class="hotseat-ship-select">
      <header class="hotseat-select-header">
        <div>
          <p class="menu-kicker">Hotseat Ship Select</p>
          <h2>Select Ships</h2>
        </div>
        <p>${phase.message ?? 'The losing player picks a new ship. The winner stays in the arena.'}</p>
      </header>
      <div class="hotseat-select-grid">
        ${([0, 1] as const)
          .map((sideId) => renderHotseatShipSelectPanel(phase.session, sideId, phase.selectingSideIds.includes(sideId)))
          .join('')}
      </div>
    </section>
  `;
}

function renderNetworkShipSelectMenu(phase: Extract<AppPhase, { readonly name: 'networkShipSelect' }>): string {
  const sideId = getNetworkLocalSide(phase.role);
  const isSelecting = phase.selectingSideIds.includes(sideId);
  const selectedShip = getSelectedFleetShip(phase.session, sideId);
  const status = isSelecting
    ? 'Choose a ship'
    : selectedShip
      ? `${getShipCatalogEntry(selectedShip.catalogId).name} locked in`
      : 'Waiting for ship selection';
  return `
    <section class="menu-card menu-card-wide">
      ${renderMenuBrand()}
      <p class="menu-kicker">Multiplayer Ship Select</p>
      <h2>Select Ship</h2>
      <p>${phase.message ?? 'Choose your next living ship. The host starts the next round once both required picks are locked.'}</p>
      <p>${status}</p>
      ${renderShipSelectFleetGrid(phase.session.fleets[sideId], sideId, isSelecting, selectedShip?.uid ?? null)}
    </section>
  `;
}

function renderHotseatShipSelectPanel(session: BattleSession, sideId: PlayerSide, isSelecting: boolean): string {
  const selectedShip = getSelectedFleetShip(session, sideId);
  const status = isSelecting ? 'Choose a ship' : selectedShip ? `${getShipCatalogEntry(selectedShip.catalogId).name} locked in` : 'Waiting';
  return `
    <section class="hotseat-select-panel hotseat-select-panel-p${sideId + 1}${isSelecting ? '' : ' hotseat-select-panel-locked'}" aria-label="${getSideName(sideId, 'hotseat')} ship selection">
      <h3>${getSideName(sideId, 'hotseat')}</h3>
      <p class="hotseat-select-status">${status}</p>
      ${renderShipSelectFleetGrid(session.fleets[sideId], sideId, isSelecting, selectedShip?.uid ?? null)}
    </section>
  `;
}

function renderShipSelectFleetGrid(
  fleet: readonly FleetShip[],
  sideId: PlayerSide,
  isSelecting = true,
  selectedUid: string | null = null,
): string {
  const slots = Array.from({ length: MAX_FLEET_SLOTS }, (_, index) => renderShipSelectFleetSlot(index, fleet[index], sideId, isSelecting, selectedUid));
  return `
    <div class="ship-select-roster-frame">
      <div class="fleet-slot-grid ship-select-slot-grid">
        ${slots.join('')}
      </div>
    </div>
  `;
}

function renderShipSelectFleetSlot(
  index: number,
  fleetShip: FleetShip | undefined,
  sideId: PlayerSide,
  isSelecting = true,
  selectedUid: string | null = null,
): string {
  if (!fleetShip) {
    return `
      <div class="fleet-slot fleet-slot-empty ship-select-slot-empty" aria-label="Empty fleet slot ${index + 1}">
        <span>${index + 1}</span>
      </div>
    `;
  }

  const ship = getShipCatalogEntry(fleetShip.catalogId);
  const defeatedClass = fleetShip.alive ? '' : ' ship-select-slot-defeated';
  const defeatedOverlay = fleetShip.alive ? '' : '<span class="ship-select-defeated-mark" aria-hidden="true">X</span>';
  const selectedClass = fleetShip.uid === selectedUid ? ` ship-select-slot-selected ship-select-slot-selected-p${sideId + 1}` : '';
  const selectedOverlay = fleetShip.uid === selectedUid ? '<span class="ship-select-selected-mark" aria-hidden="true">Locked</span>' : '';
  const label = fleetShip.alive ? `Fight with ${ship.name} from slot ${index + 1}` : `${ship.name} in slot ${index + 1} was defeated`;
  const content = `
    <span class="fleet-slot-number">${index + 1}</span>
    ${renderUiShipArt(fleetShip.catalogId, 'fleet-slot-ship', FLEET_SLOT_ART_SCALE_MULTIPLIER)}
    <span class="fleet-slot-name">${ship.name}</span>
    <span class="fleet-slot-cost">${ship.cost}</span>
    ${defeatedOverlay}
    ${selectedOverlay}
  `;

  if (!fleetShip.alive || !isSelecting) {
    return `
      <div class="fleet-slot fleet-slot-filled ship-select-slot${defeatedClass}${selectedClass}" aria-label="${label}">
        ${content}
      </div>
    `;
  }

  return `
    <button
      type="button"
      class="fleet-slot fleet-slot-filled ship-select-slot${selectedClass}"
      data-action="ship-pick"
      data-fleet-side="${sideId}"
      data-fleet-uid="${fleetShip.uid}"
      data-ship-select-nav="slot"
      data-ship-select-nav-index="${index}"
      aria-label="${label}"
    >
      ${content}
    </button>
  `;
}

function renderRoundResultMenu(phase: Extract<AppPhase, { readonly name: 'roundResult' }>): string {
  const winnerName = getSideName(phase.winnerId, phase.session.mode);
  const loserName = getSideName(phase.loserId, phase.session.mode);
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
  const title = phase.title ?? (phase.role === 'host' ? 'Waiting For Joiner' : 'Joining Lobby');
  const detail = phase.detail ?? `Lobby ${phase.lobbyId} | ${phase.budget} pts | Peer ${peerConnectionState}`;
  return `
    <section class="menu-card">
      ${renderMenuBrand()}
      <p class="menu-kicker">Multiplayer</p>
      <h2>${title}</h2>
      <p>${detail}</p>
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

function addShipToPlayerFleet(shipId: ShipCatalogId, sideId: PlayerSide = 0): void {
  if (appPhase.name === 'hotseatFleetBuild') {
    const fleet = getEditableFleet(sideId);
    if (!fleet || fleet.length >= MAX_FLEET_SLOTS) {
      return;
    }

    const ship = getShipCatalogEntry(shipId);
    if (ship.cost > getRemainingBudget(fleet, appPhase.budget)) {
      return;
    }

    fleetSerial += 1;
    const nextShip = { uid: `${sideId === 0 ? 'p1' : 'p2'}-${fleetSerial}`, catalogId: shipId, alive: true };
    appPhase = {
      ...appPhase,
      fleets: updateFleetForSide(appPhase.fleets, sideId, [...fleet, nextShip]),
      ready: updateReadyForSide(appPhase.ready, sideId, false),
    };
    fleetBuilderPickingSlotIndices[sideId] = null;
    fleetBuilderConfirmingBack[sideId] = false;
    fleetBuilderNavTargets[sideId] = { nav: 'slot', index: Math.min(fleet.length, MAX_FLEET_SLOTS - 1) };
    renderMenu();
    return;
  }

  if (appPhase.name !== 'fleetBuild' && appPhase.name !== 'networkFleetBuild') {
    return;
  }

  if (sideId !== 0 || appPhase.fleet.length >= MAX_FLEET_SLOTS) {
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
  fleetBuilderPickingSlotIndices[sideId] = null;
  fleetBuilderConfirmingBack[sideId] = false;
  fleetBuilderNavTargets[sideId] = { nav: 'slot', index: Math.min(appPhase.fleet.length, MAX_FLEET_SLOTS - 1) };
  renderMenu();
}

function removeShipFromPlayerFleet(uid: string, sideId: PlayerSide = 0): void {
  if (appPhase.name === 'hotseatFleetBuild') {
    const fleet = getEditableFleet(sideId);
    if (!fleet) {
      return;
    }

    appPhase = {
      ...appPhase,
      fleets: updateFleetForSide(
        appPhase.fleets,
        sideId,
        fleet.filter((ship) => ship.uid !== uid),
      ),
      ready: updateReadyForSide(appPhase.ready, sideId, false),
    };
    fleetBuilderPickingSlotIndices[sideId] = null;
    fleetBuilderConfirmingBack[sideId] = false;
    renderMenu();
    return;
  }

  if (appPhase.name !== 'fleetBuild' && appPhase.name !== 'networkFleetBuild') {
    return;
  }

  if (sideId !== 0) {
    return;
  }

  appPhase = {
    ...appPhase,
    fleet: appPhase.fleet.filter((ship) => ship.uid !== uid),
  };
  fleetBuilderPickingSlotIndices[sideId] = null;
  fleetBuilderConfirmingBack[sideId] = false;
  renderMenu();
}

function toggleHotseatFleetReady(sideId: PlayerSide): void {
  if (appPhase.name !== 'hotseatFleetBuild') {
    return;
  }

  const fleet = appPhase.fleets[sideId];
  if (fleet.length === 0) {
    return;
  }

  const nextReady = updateReadyForSide(appPhase.ready, sideId, !appPhase.ready[sideId]);
  appPhase = { ...appPhase, ready: nextReady };
  fleetBuilderPickingSlotIndices[sideId] = null;
  fleetBuilderConfirmingBack[sideId] = false;
  fleetBuilderNavTargets[sideId] = { nav: 'command', index: 0 };
  if (nextReady.every(Boolean)) {
    startHotseatRun();
    return;
  }
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
    mode: 'single',
    budget: appPhase.budget,
    fleets: [appPhase.fleet, aiFleet],
    selectedShipUids: [null, aiShip.uid],
  };
  appPhase = { name: 'shipSelect', session, message: 'Pick the first ship for your fleet.' };
  renderMenu();
}

function startHotseatRun(): void {
  if (appPhase.name !== 'hotseatFleetBuild' || !appPhase.ready.every(Boolean) || appPhase.fleets.some((fleet) => fleet.length === 0)) {
    return;
  }

  const session: BattleSession = {
    mode: 'hotseat',
    budget: appPhase.budget,
    fleets: appPhase.fleets,
    selectedShipUids: [null, null],
  };
  appPhase = { name: 'hotseatShipSelect', session, selectingSideIds: [0, 1], message: 'Both players pick the first ship for their fleets.' };
  renderMenu();
}

function readyNetworkFleet(): void {
  if (appPhase.name !== 'networkFleetBuild' || appPhase.fleet.length === 0) {
    return;
  }

  const { role, budget, lobbyId } = appPhase;
  const sideId = getNetworkLocalSide(role);
  pendingNetworkFleets = sideId === 0 ? [appPhase.fleet, pendingNetworkFleets[1]] : [pendingNetworkFleets[0], appPhase.fleet];
  networkBattleSession = null;
  peerSession?.sendControlMessage(
    encodeNetworkControlMessage({
      type: 'fleetReady',
      sideId,
      fleet: appPhase.fleet.map(toNetworkFleetShip),
    }),
  );
  log(`Fleet ready with ${appPhase.fleet.length} ships. Waiting for peer fleet...`);
  appPhase = { name: 'networkConnecting', role, budget, lobbyId };
  renderMenu();
  maybeStartNetworkShipSelect(role, budget, lobbyId);
}

function toNetworkFleetShip(ship: FleetShip): NetworkFleetShip {
  return ship;
}

function fromNetworkFleetShip(ship: NetworkFleetShip): FleetShip {
  return ship;
}

function maybeStartNetworkShipSelect(role: ConnectionRole, budget: number, lobbyId: string): void {
  const fleets = pendingNetworkFleets;
  if (!fleets[0] || !fleets[1]) {
    return;
  }

  const session: BattleSession =
    networkBattleSession?.mode === 'network'
      ? networkBattleSession
      : { mode: 'network', budget, fleets: [fleets[0], fleets[1]], selectedShipUids: [null, null] };
  networkBattleSession = session;
  if (role === 'joiner' && !networkMatch) {
    networkMatch = new NetworkMatchSession('joiner');
    networkMatchStatus = networkMatch.status;
    presentationCorrection = null;
  }
  if (networkMatch) {
    if (role === 'joiner') {
      appPhase = {
        name: 'networkShipSelect',
        role,
        budget,
        lobbyId,
        session,
        selectingSideIds: getSidesNeedingSelection(session),
        message: 'Both players pick the first ship for their fleets.',
      };
      renderMenu();
    }
    return;
  }

  appPhase = {
    name: 'networkShipSelect',
    role,
    budget,
    lobbyId,
    session,
    selectingSideIds: getSidesNeedingSelection(session),
    message: 'Both players pick the first ship for their fleets.',
  };
  renderMenu();
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

function choosePlayerShip(uid: string, sideId: PlayerSide = 0): void {
  if (appPhase.name === 'hotseatShipSelect') {
    chooseHotseatShip(uid, sideId);
    return;
  }

  if (appPhase.name === 'networkShipSelect') {
    chooseNetworkShip(uid, sideId);
    return;
  }

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

function chooseHotseatShip(uid: string, sideId: PlayerSide): void {
  if (appPhase.name !== 'hotseatShipSelect' || !appPhase.selectingSideIds.includes(sideId)) {
    return;
  }

  const livingShip = appPhase.session.fleets[sideId].find((ship) => ship.uid === uid && ship.alive);
  if (!livingShip) {
    return;
  }

  const session = withSelectedShip(appPhase.session, sideId, uid);
  const selectingSideIds = appPhase.selectingSideIds.filter((candidate) => candidate !== sideId);
  if (selectingSideIds.length > 0) {
    appPhase = { ...appPhase, session, selectingSideIds, message: `${getSideName(sideId, 'hotseat')} locked in. Waiting for the other player.` };
    renderMenu();
    return;
  }

  startHotseatFight(session);
}

function chooseNetworkShip(uid: string, sideId: PlayerSide): void {
  if (appPhase.name !== 'networkShipSelect' || !appPhase.selectingSideIds.includes(sideId)) {
    return;
  }

  const { role, budget, lobbyId } = appPhase;
  const localSide = getNetworkLocalSide(role);
  if (sideId !== localSide) {
    return;
  }

  const livingShip = appPhase.session.fleets[sideId].find((ship) => ship.uid === uid && ship.alive);
  if (!livingShip) {
    return;
  }

  const session = withSelectedShip(appPhase.session, sideId, uid);
  networkBattleSession = session;
  peerSession?.sendControlMessage(encodeNetworkControlMessage({ type: 'shipPicked', sideId, uid }));
  const selectingSideIds = appPhase.selectingSideIds.filter((candidate) => candidate !== sideId);
  appPhase = {
    ...appPhase,
    session,
    selectingSideIds,
    message: selectingSideIds.length > 0 ? 'Ship locked in. Waiting for the other player.' : 'Ship locked in. Waiting for host round config.',
  };
  renderMenu();
  maybeStartSelectedNetworkRound(role, budget, lobbyId, session);
}

function maybeStartSelectedNetworkRound(role: ConnectionRole, budget: number, lobbyId: string, session: BattleSession): void {
  if (role !== 'host' || !getSelectedFleetShip(session, 0) || !getSelectedFleetShip(session, 1)) {
    return;
  }

  startNetworkFight(role, budget, lobbyId, session);
}

function startNetworkFight(role: ConnectionRole, budget: number, lobbyId: string, session: BattleSession): void {
  const hostShip = getSelectedFleetShip(session, 0);
  const joinerShip = getSelectedFleetShip(session, 1);
  if (role !== 'host' || !hostShip || !joinerShip) {
    return;
  }

  networkHumanRound += 1;
  currentLoadout = [hostShip.catalogId, joinerShip.catalogId];
  const seed = Date.now() >>> 0;
  const shipOverrides = createRoundStartOverrides(session);
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
  state = createInitialState(seed, currentLoadout, getGameplaySettings(), shipOverrides);
  networkMatch = new NetworkMatchSession('host', {
    roundId: networkHumanRound,
    seed,
    loadout: currentLoadout,
    gameplay: getGameplaySettings(),
    shipOverrides,
    readyImmediately: true,
  });
  presentationCorrection = null;
  sendGameplayPackets(networkMatch.takeOutgoingPackets());
  networkMatchStatus = networkMatch.status;
  networkBattleSession = session;
  appPhase = { name: 'networkFight', role, budget, lobbyId, session, handledWinnerId: null };
  renderMenu();
  log(`Network round ${networkHumanRound}: ${getShipCatalogEntry(currentLoadout[0]).name} vs ${getShipCatalogEntry(currentLoadout[1]).name}`);
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
  state = createInitialState(Date.now() >>> 0, currentLoadout, getGameplaySettings(), createRoundStartOverrides(session));
  appPhase = { name: 'fighting', session, handledWinnerId: null };
  renderMenu();
}

function startHotseatFight(session: BattleSession): void {
  const playerOneShip = getSelectedFleetShip(session, 0);
  const playerTwoShip = getSelectedFleetShip(session, 1);
  if (!playerOneShip || !playerTwoShip) {
    appPhase = {
      name: 'hotseatShipSelect',
      session,
      selectingSideIds: getSidesNeedingSelection(session),
      message: 'Pick living ships before fighting.',
    };
    renderMenu();
    return;
  }

  closePeer();
  currentLoadout = [playerOneShip.catalogId, playerTwoShip.catalogId];
  renderer.setShipLoadout(currentLoadout);
  renderHud(currentLoadout);
  state = createInitialState(Date.now() >>> 0, currentLoadout, getGameplaySettings(), createRoundStartOverrides(session));
  appPhase = { name: 'hotseatFighting', session, handledWinnerId: null };
  renderMenu();
}

function createRoundStartOverrides(session: BattleSession): readonly [RoundStartShipOverride | undefined, RoundStartShipOverride | undefined] {
  return [createRoundStartOverride(getSelectedFleetShip(session, 0)), createRoundStartOverride(getSelectedFleetShip(session, 1))];
}

function createRoundStartOverride(fleetShip: FleetShip | null): RoundStartShipOverride | undefined {
  if (!fleetShip?.persistent) {
    return undefined;
  }

  return {
    crew: fleetShip.persistent.crew,
    custom: fleetShip.persistent.custom,
    zizlikNodeSlots: fleetShip.persistent.zizlikNodeSlots,
    pscoutBeaconSlots: fleetShip.persistent.pscoutBeaconSlots,
  };
}

function persistRoundFleetState(
  session: BattleSession,
  eliminatedSideIds: ReadonlySet<number>,
  roundState: GameState = state,
): [readonly FleetShip[], readonly FleetShip[]] {
  return session.fleets.map((fleet, sideId) => {
    const selectedUid = session.selectedShipUids[sideId];
    if (!selectedUid) {
      return fleet;
    }

    return fleet.map((fleetShip) => {
      if (fleetShip.uid !== selectedUid) {
        return fleetShip;
      }

      if (eliminatedSideIds.has(sideId)) {
        return { ...fleetShip, alive: false, persistent: undefined };
      }

      const roundShip = roundState.ships[sideId];
      if (!roundShip?.alive) {
        return { ...fleetShip, alive: false, persistent: undefined };
      }

      return { ...fleetShip, persistent: createPersistentFleetShipState(roundShip, roundState.actors) };
    });
  }) as [readonly FleetShip[], readonly FleetShip[]];
}

function createPersistentFleetShipState(ship: ShipState, actors: readonly ActorState[]): PersistentFleetShipState {
  return {
    crew: ship.crew,
    custom: createPersistentCustomState(ship),
    zizlikNodeSlots: actors
      .filter((actor) => actor.active && actor.kind === 'zizlikNode' && actor.ownerId === ship.id)
      .map((actor) => actor.slot),
    pscoutBeaconSlots: actors
      .filter((actor) => actor.active && actor.kind === 'pscoutBeacon' && actor.ownerId === ship.id)
      .map((actor) => actor.slot),
  };
}

function createPersistentCustomState(ship: ShipState): ShipCustomState {
  switch (ship.shipId) {
    case 'duk':
      return { dukMissileCount: ship.custom.dukMissileCount };
    case 'krab':
      return { krabLongRange: ship.custom.krabLongRange };
    default:
      return {};
  }
}

function resolveLocalRound(session: BattleSession, winnerId: number): void {
  const loserId = winnerId === 0 ? 1 : 0;
  const nextFleets = persistRoundFleetState(session, new Set([loserId]), networkMatch?.currentState ?? state);
  const nextSession: BattleSession = {
    ...session,
    fleets: nextFleets,
    selectedShipUids: loserId === 0 ? [null, session.selectedShipUids[1]] : [session.selectedShipUids[0], null],
  };

  if (!hasLivingShips(nextSession.fleets[loserId])) {
    appPhase = {
      name: 'finalResult',
      title: `${getSideName(winnerId, nextSession.mode)} wins`,
      detail: `${getSideName(loserId, nextSession.mode)} has no ships remaining.`,
    };
  } else if (nextSession.mode === 'hotseat') {
    appPhase = {
      name: 'hotseatShipSelect',
      session: nextSession,
      selectingSideIds: [loserId as PlayerSide],
      message: `${getSideName(loserId, 'hotseat')} lost that ship. Pick a new one to challenge the winner.`,
    };
  } else {
    appPhase = { name: 'roundResult', session: nextSession, winnerId, loserId };
  }
  renderMenu();
}

function resolveLocalMutualDestruction(session: BattleSession): void {
  const nextFleets = persistRoundFleetState(session, new Set([0, 1]), networkMatch?.currentState ?? state);
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
    appPhase =
      session.mode === 'hotseat'
        ? { name: 'finalResult', title: 'Player 2 wins', detail: 'Both ships were destroyed, and Player 1 has no ships remaining.' }
        : { name: 'finalResult', title: 'AI wins', detail: 'Both ships were destroyed, and you have no ships remaining.' };
  } else if (!aiAlive) {
    appPhase =
      session.mode === 'hotseat'
        ? { name: 'finalResult', title: 'Player 1 wins', detail: 'Both ships were destroyed, and Player 2 has no ships remaining.' }
        : { name: 'finalResult', title: 'Player wins', detail: 'Both ships were destroyed, and the AI has no ships remaining.' };
  } else if (session.mode === 'hotseat') {
    appPhase = { name: 'hotseatShipSelect', session: nextSession, selectingSideIds: [0, 1], message: 'Both ships were destroyed. Pick new ships.' };
  } else {
    appPhase = { name: 'shipSelect', session: nextSession, message: 'Both ships were destroyed. Pick a new ship.' };
  }

  renderMenu();
}

function resolveNetworkRound(session: BattleSession, winnerId: number, role: ConnectionRole, budget: number, lobbyId: string): void {
  const loserId = winnerId === 0 ? 1 : 0;
  const nextFleets = persistRoundFleetState(session, new Set([loserId]));
  const nextSession: BattleSession = {
    ...session,
    fleets: nextFleets,
    selectedShipUids: loserId === 0 ? [null, session.selectedShipUids[1]] : [session.selectedShipUids[0], null],
  };

  endNetworkRoundSession();
  if (!hasLivingShips(nextSession.fleets[loserId])) {
    networkBattleSession = nextSession;
    appPhase = {
      name: 'finalResult',
      title: `${getSideName(winnerId, 'network')} wins`,
      detail: `${getSideName(loserId, 'network')} has no ships remaining.`,
    };
    renderMenu();
    return;
  }

  enterNetworkShipSelect(role, budget, lobbyId, nextSession, [loserId as PlayerSide], `${getSideName(loserId, 'network')} lost that ship. Pick a new one to challenge the winner.`);
}

function sendNetworkRoundResolved(outcome: { readonly kind: 'winner'; readonly winnerId: PlayerSide } | { readonly kind: 'draw' }): void {
  peerSession?.sendControlMessage(encodeNetworkControlMessage({ type: 'roundResolved', outcome }));
}

function resolveNetworkMutualDestruction(session: BattleSession, role: ConnectionRole, budget: number, lobbyId: string): void {
  const nextFleets = persistRoundFleetState(session, new Set([0, 1]));
  const nextSession: BattleSession = {
    ...session,
    fleets: nextFleets,
    selectedShipUids: [null, null],
  };
  const playerOneAlive = hasLivingShips(nextSession.fleets[0]);
  const playerTwoAlive = hasLivingShips(nextSession.fleets[1]);

  endNetworkRoundSession();
  if (!playerOneAlive && !playerTwoAlive) {
    networkBattleSession = nextSession;
    appPhase = { name: 'finalResult', title: 'Draw', detail: 'Both fleets were destroyed.' };
    renderMenu();
  } else if (!playerOneAlive) {
    networkBattleSession = nextSession;
    appPhase = { name: 'finalResult', title: 'Player 2 wins', detail: 'Both ships were destroyed, and Player 1 has no ships remaining.' };
    renderMenu();
  } else if (!playerTwoAlive) {
    networkBattleSession = nextSession;
    appPhase = { name: 'finalResult', title: 'Player 1 wins', detail: 'Both ships were destroyed, and Player 2 has no ships remaining.' };
    renderMenu();
  } else {
    enterNetworkShipSelect(role, budget, lobbyId, nextSession, [0, 1], 'Both ships were destroyed. Pick new ships.');
  }
}

function endNetworkRoundSession(): void {
  clearPendingGameplayPackets();
  networkMatch = null;
  networkMatchStatus = null;
  presentationCorrection = null;
}

function enterNetworkShipSelect(
  role: ConnectionRole,
  budget: number,
  lobbyId: string,
  session: BattleSession,
  selectingSideIds: readonly PlayerSide[],
  message: string,
): void {
  networkBattleSession = session;
  pendingNetworkFleets = [session.fleets[0], session.fleets[1]];
  const localSide = getNetworkLocalSide(role);
  if (role === 'joiner') {
    networkMatch = new NetworkMatchSession('joiner');
    networkMatchStatus = networkMatch.status;
  }
  appPhase = selectingSideIds.includes(localSide)
    ? { name: 'networkShipSelect', role, budget, lobbyId, session, selectingSideIds, message }
    : {
        name: 'networkConnecting',
        role,
        budget,
        lobbyId,
        title: 'Opponent Is Choosing A Ship',
        detail: 'You won the last round. Waiting for your opponent to choose their next ship.',
      };
  renderMenu();
}

function continueAfterRound(): void {
  if (appPhase.name !== 'roundResult') {
    return;
  }

  if (appPhase.session.mode === 'hotseat') {
    appPhase = {
      name: 'hotseatShipSelect',
      session: appPhase.session,
      selectingSideIds: [appPhase.loserId as PlayerSide],
      message: `${getSideName(appPhase.loserId, 'hotseat')} lost that ship. Pick a new one to challenge the winner.`,
    };
    renderMenu();
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
  state = createInitialState(Date.now() >>> 0, currentLoadout, getGameplaySettings());
  appPhase = { name: 'aiDemo', round };
  log(`Attract Mode round ${round}: ${getShipCatalogEntry(currentLoadout[0]).name} vs ${getShipCatalogEntry(currentLoadout[1]).name}`);
  renderMenu();
}

function debugKillShip(sideId: PlayerSide): void {
  if (appPhase.name !== 'fighting' && appPhase.name !== 'hotseatFighting' && appPhase.name !== 'aiDemo') {
    return;
  }

  const targetShip = state.ships[sideId];
  if (!targetShip?.alive || state.winnerId !== null) {
    return;
  }

  const ships = state.ships.map((ship) => (ship.id === sideId ? { ...ship, crew: 0, alive: false } : ship));
  const living = ships.filter((ship) => ship.alive);
  const winnerId = living.length === 1 ? living[0].id : null;
  state = {
    ...state,
    ships,
    winnerId,
  };
  log(`Debug killed P${sideId + 1} ship.`);
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
  pendingNetworkFleets = [null, null];
  networkBattleSession = null;
  networkHumanRound = 0;
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
  pendingNetworkFleets = [null, null];
  networkBattleSession = null;
  networkHumanRound = 0;
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
          appPhase.name === 'networkFleetBuild' ||
          appPhase.name === 'networkShipSelect';
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
          appPhase = {
            name: 'networkFight',
            role,
            budget,
            lobbyId,
            session: networkBattleSession ?? undefined,
            handledWinnerId: null,
          };
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
  state = createInitialState(seed, currentLoadout, getGameplaySettings());
  networkMatch = new NetworkMatchSession('host', {
    roundId: networkAiRound,
    seed,
    loadout: currentLoadout,
    gameplay: getGameplaySettings(),
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
  const controlMessage = decodeNetworkControlMessage(message);
  if (controlMessage) {
    if (controlMessage.type === 'fleetReady') {
      if (controlMessage.sideId !== getNetworkRemoteSide(role)) {
        log(`Ignored control message for unexpected side ${controlMessage.sideId}.`);
        return;
      }

      const fleet = controlMessage.fleet.map(fromNetworkFleetShip);
      pendingNetworkFleets = controlMessage.sideId === 0 ? [fleet, pendingNetworkFleets[1]] : [pendingNetworkFleets[0], fleet];
      log(`Peer fleet ready with ${fleet.length} ships.`);
      maybeStartNetworkShipSelect(role, budget, lobbyId);
      return;
    }

    if (controlMessage.type === 'shipPicked') {
      if (controlMessage.sideId !== getNetworkRemoteSide(role)) {
        log(`Ignored control message for unexpected side ${controlMessage.sideId}.`);
        return;
      }

      if (!networkBattleSession) {
        log('Ignored peer ship pick before fleet session was ready.');
        return;
      }

      const ship = networkBattleSession.fleets[controlMessage.sideId].find((fleetShip) => fleetShip.uid === controlMessage.uid && fleetShip.alive);
      if (!ship) {
        log('Ignored peer ship pick for an unavailable ship.');
        return;
      }

      const session = withSelectedShip(networkBattleSession, controlMessage.sideId, controlMessage.uid);
      networkBattleSession = session;
      if (appPhase.name === 'networkShipSelect') {
        appPhase = {
          ...appPhase,
          session,
          selectingSideIds: appPhase.selectingSideIds.filter((sideId) => sideId !== controlMessage.sideId),
          message: `${getSideName(controlMessage.sideId, 'network')} locked in.`,
        };
        renderMenu();
      }
      maybeStartSelectedNetworkRound(role, budget, lobbyId, session);
      return;
    }

    if (controlMessage.type === 'roundResolved') {
      if (appPhase.name !== 'networkFight' || !networkBattleSession) {
        return;
      }

      if (controlMessage.outcome.kind === 'winner') {
        resolveNetworkRound(networkBattleSession, controlMessage.outcome.winnerId, role, budget, lobbyId);
      } else {
        resolveNetworkMutualDestruction(networkBattleSession, role, budget, lobbyId);
      }
      return;
    }
  }

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
  pendingNetworkFleets = [null, null];
  networkBattleSession = null;
  networkHumanRound = 0;
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
  if (appPhase.name === 'aiDemo' || appPhase.name === 'fighting' || appPhase.name === 'hotseatFighting' || appPhase.name === 'networkFight') {
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
  state = createInitialState(undefined, currentLoadout, getGameplaySettings());
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
  if (appPhase.name !== 'networkFleetBuild' && appPhase.name !== 'networkShipSelect') {
    return;
  }

  closePeer();
  appPhase = { name: 'multiplayerMenu' };
  renderMenu();
}

function goBack(): void {
  switch (appPhase.name) {
    case 'shipCatalog':
    case 'singleBudget':
    case 'hotseatBudget':
      appPhase = { name: 'mainMenu' };
      break;
    case 'fleetBuild':
      appPhase = { name: 'singleBudget' };
      break;
    case 'hotseatFleetBuild':
      appPhase = { name: 'hotseatBudget' };
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
    case 'networkShipSelect':
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
    case 'shipCatalog':
      return 'Ship catalog';
    case 'singleBudget':
    case 'fleetBuild':
    case 'shipSelect':
      return 'Single player setup';
    case 'hotseatBudget':
    case 'hotseatFleetBuild':
    case 'hotseatShipSelect':
      return 'Hotseat setup';
    case 'roundResult':
    case 'finalResult':
    case 'networkResult':
      return 'Match complete';
    case 'multiplayerMenu':
    case 'hostSetup':
    case 'lobbyBrowser':
    case 'networkConnecting':
    case 'networkFleetBuild':
    case 'networkShipSelect':
      return 'Multiplayer setup';
    case 'fighting':
    case 'hotseatFighting':
    case 'aiDemo':
    case 'networkFight':
      return 'Match active';
  }
}

function isCombatPhase(): boolean {
  return appPhase.name === 'fighting' || appPhase.name === 'hotseatFighting' || appPhase.name === 'networkFight' || appPhase.name === 'aiDemo';
}

function syncCombatMusic(combatPhase: boolean = isCombatPhase()): void {
  if (combatPhase) {
    gameAudio.startCombatMusic();
    return;
  }

  gameAudio.stopCombatMusic();
}

function syncAudioControls(): void {
  const label = getAudioToggleLabel();
  pauseAudioButton.textContent = label;
  for (const button of menuOverlay.querySelectorAll<HTMLButtonElement>('[data-audio-toggle]')) {
    button.textContent = label;
  }
}

function getAudioToggleLabel(): string {
  return gameAudio.isMuted() ? 'Unmute Audio' : 'Mute Audio';
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
  const shipArt = renderHudShipArt(shipId);
  const shipOverlay = shipId !== 'bolter' && ship.hud.shipOverlayKey
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
          ${shipArt}
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

function renderHudShipArt(shipId: ShipCatalogId): string {
  const ship = getShipCatalogEntry(shipId);
  if (shipId !== 'bolter') {
    return `<img class="hud-ship-icon" src="${legacyAssets[ship.hud.shipKey].url}" alt="${ship.name} ship" />`;
  }

  const layers: readonly (keyof typeof legacyAssets)[] = ['bolterBottom', 'bolterLeftArm', 'bolterRightArm', 'bolterTop'];
  return layers
    .map(
      (key, index) =>
        `<img
          class="hud-ship-icon"
          src="${legacyAssets[key].url}"
          alt="${index === 0 ? `${ship.name} ship` : ''}"
          ${index === 0 ? '' : 'aria-hidden="true"'}
        />`,
    )
    .join('');
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
  trackAudioEvents(previousState, state);
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

function trackAudioEvents(previousState: GameState, currentState: GameState): void {
  if (pauseMenuOpen || hasDeadShip(previousState)) {
    return;
  }

  if (!hasDeadShip(currentState)) {
    trackWeaponAudioEvents(previousState, currentState);
  }
  trackDamageAudioEvents(previousState, currentState);
}

function hasDeadShip(state: GameState): boolean {
  return state.ships.some((ship) => !ship.alive);
}

function trackWeaponAudioEvents(previousState: GameState, currentState: GameState): void {
  currentState.ships.forEach((ship, index) => {
    const previousShip = previousState.ships[index];
    if (!previousShip || !ship.alive) {
      return;
    }

    const sfx = shipSfx[ship.shipId];
    if (didPrimaryFire(previousShip, ship)) {
      gameAudio.playSfx(sfx.primary);
    }
    if (didSecondaryFire(previousShip, ship)) {
      gameAudio.playSfx(sfx.secondary);
    }
  });
}

function trackDamageAudioEvents(previousState: GameState, currentState: GameState): void {
  let stoppedMusic = false;
  currentState.ships.forEach((ship, index) => {
    const previousShip = previousState.ships[index];
    if (!previousShip) {
      return;
    }

    if (ship.crew < previousShip.crew) {
      gameAudio.playSfx('SOUND_HIT');
    }
    if (previousShip.alive && !ship.alive) {
      gameAudio.playSfx('SOUND_DIE');
      stoppedMusic = true;
    }
  });

  if (stoppedMusic) {
    gameAudio.stopCombatMusic();
  }
}

function didPrimaryFire(previousShip: ShipState, ship: ShipState): boolean {
  const expectedCooldown = Math.max(0, previousShip.primaryCooldown - 1);
  return ship.primaryCooldown > expectedCooldown;
}

function didSecondaryFire(previousShip: ShipState, ship: ShipState): boolean {
  const expectedCooldown = Math.max(0, previousShip.secondaryCooldown - 1);
  if (ship.secondaryCooldown <= expectedCooldown) {
    return false;
  }

  return !(ship.shipId === 'cannonade' && previousShip.secondaryCooldown > 0 && ship.secondaryCooldown === 1);
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

function withoutSelectedShip(session: BattleSession, sideId: PlayerSide): BattleSession {
  return {
    ...session,
    selectedShipUids: sideId === 0 ? [null, session.selectedShipUids[1]] : [session.selectedShipUids[0], null],
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

function getSideName(sideId: number, mode: BattleSession['mode'] = 'single'): string {
  if (mode === 'hotseat' || mode === 'network') {
    return sideId === 0 ? 'Player 1' : 'Player 2';
  }

  return sideId === 0 ? 'Player' : 'AI';
}

function getEditableFleet(sideId: PlayerSide): readonly FleetShip[] | null {
  if (appPhase.name === 'hotseatFleetBuild') {
    return appPhase.ready[sideId] ? null : appPhase.fleets[sideId];
  }

  if ((appPhase.name === 'fleetBuild' || appPhase.name === 'networkFleetBuild') && sideId === 0) {
    return appPhase.fleet;
  }

  return null;
}

function getFleetBuilderPickingSlotIndex(sideId: PlayerSide): number | null {
  if (appPhase.name !== 'hotseatFleetBuild') {
    return null;
  }

  const slotIndex = fleetBuilderPickingSlotIndices[sideId];
  return slotIndex !== null && slotIndex === appPhase.fleets[sideId].length && appPhase.fleets[sideId].length < MAX_FLEET_SLOTS ? slotIndex : null;
}

function updateFleetForSide(
  fleets: readonly [readonly FleetShip[], readonly FleetShip[]],
  sideId: PlayerSide,
  fleet: readonly FleetShip[],
): readonly [readonly FleetShip[], readonly FleetShip[]] {
  return sideId === 0 ? [fleet, fleets[1]] : [fleets[0], fleet];
}

function updateReadyForSide(ready: readonly [boolean, boolean], sideId: PlayerSide, value: boolean): readonly [boolean, boolean] {
  return sideId === 0 ? [value, ready[1]] : [ready[0], value];
}

function getSidesNeedingSelection(session: BattleSession): readonly PlayerSide[] {
  return ([0, 1] as const).filter((sideId) => hasLivingShips(session.fleets[sideId]) && getSelectedFleetShip(session, sideId) === null);
}

function isShipSelectSideActive(sideId: PlayerSide): boolean {
  if (appPhase.name === 'shipSelect') {
    return sideId === 0;
  }

  if (appPhase.name === 'networkShipSelect') {
    return appPhase.selectingSideIds.includes(sideId);
  }

  return appPhase.name === 'hotseatShipSelect' && appPhase.selectingSideIds.includes(sideId);
}

function getDefaultShipSelectSide(): PlayerSide {
  if (appPhase.name === 'networkShipSelect') {
    return getNetworkLocalSide(appPhase.role);
  }

  return appPhase.name === 'hotseatShipSelect' ? (appPhase.selectingSideIds[0] ?? 0) : 0;
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

function readCatalogPreviewShipId(button: HTMLButtonElement): CatalogPreviewShipId {
  const shipId = button.dataset.shipId;
  if (!isCatalogPreviewShipId(shipId)) {
    throw new Error(`Invalid catalog preview ship id: ${shipId}`);
  }

  return shipId;
}

function isCatalogPreviewShipId(shipId: string | undefined): shipId is CatalogPreviewShipId {
  return CATALOG_PREVIEW_SHIP_IDS.some((catalogShipId) => catalogShipId === shipId);
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

function readFleetSide(button: HTMLButtonElement): PlayerSide {
  const side = Number(button.dataset.fleetSide ?? 0);
  if (side !== 0 && side !== 1) {
    throw new Error(`Invalid fleet side: ${button.dataset.fleetSide}`);
  }

  return side;
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
