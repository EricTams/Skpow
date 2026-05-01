import { fixedToNumber } from '../sim/fixed';
import { DEFAULT_MATCH_SHIPS, getShipCatalogEntry, type ShipCatalogId } from '../ships';
import type { AiMovementMode } from '../sim/ai';
import { ANGLE_STEPS } from '../sim/trig';
import type { ActorState, GameState, ProjectileState, ShipState } from '../sim/types';
import type { LegacyAssetKey, LegacyImageStore } from './legacyAssets';

const SHIP_COLORS = ['#58a6ff', '#ff7b72'];
const PROJECTILE_COLORS = ['#9ecbff', '#ffa198'];
const LEGACY_ARENA_RADIUS = 1450;
const LEGACY_WORLD_SIZE = LEGACY_ARENA_RADIUS * 2;
const LEGACY_PLAYFIELD_SIZE = 720;
const MIN_CAMERA_OFFSET = 0.2 * LEGACY_ARENA_RADIUS;
const PSCOUT_RENDER_BEAM_FRAMES = 200;
const VOSKUM_TELEPORT_VISUAL_FRAMES = 24;
const VOSKUM_TELEPORT_IMPRINT_COLOR = '#66ff66';
const STAR_KEYS = ['star1', 'star2'] as const satisfies readonly LegacyAssetKey[];
const GOOJ_JUNK_KEYS = ['goojJunk', 'goojJunk2', 'goojJunk3', 'goojJunk4', 'goojJunk5', 'goojJunk6', 'goojJunk7'] as const satisfies readonly LegacyAssetKey[];
const STAR_FIELD = createStarField(500);
type MatchShipLoadout = readonly [ShipCatalogId, ShipCatalogId];
type AiDebugModes = readonly (AiMovementMode | null)[];

interface LegacyCamera {
  readonly scale: number;
  readonly legacyScale: number;
  readonly screenScale: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly screenCenterX: number;
  readonly screenCenterY: number;
}

interface StarPlacement {
  readonly key: 'star1' | 'star2';
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly alpha: number;
}

export class CanvasRenderer {
  private readonly context: CanvasRenderingContext2D;
  private shipLoadout: MatchShipLoadout = DEFAULT_MATCH_SHIPS;
  private aiDebugModes: AiDebugModes = [];

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly images: LegacyImageStore,
  ) {
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not create 2D canvas context.');
    }

    this.context = context;
  }

  public resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const deviceScale = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * deviceScale));
    const height = Math.max(1, Math.floor(rect.height * deviceScale));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  public render(state: GameState): void {
    this.resize();

    const ctx = this.context;
    const camera = this.createCamera(state);

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawBackground(camera);

    this.drawPlanet(state, camera);

    for (const projectile of state.projectiles) {
      this.drawProjectile(projectile, camera);
    }

    for (const actor of state.actors) {
      this.drawActor(actor, camera);
    }

    for (const ship of state.ships) {
      this.drawShip(ship, camera);
    }

    this.drawBoardOverlays(state, camera);

    if (state.winnerId !== null) {
      this.drawWinnerBanner(state.winnerId);
    }
  }

  public setShipLoadout(loadout: MatchShipLoadout): void {
    this.shipLoadout = loadout;
  }

  public setAiDebugModes(modes: AiDebugModes): void {
    this.aiDebugModes = modes;
  }

  private createCamera(state: GameState): LegacyCamera {
    const screenScale = Math.min(this.canvas.width, this.canvas.height) / LEGACY_PLAYFIELD_SIZE;
    const player1 = state.ships[0];
    const player2 = state.ships[1];
    const player1Camera = this.getShipCameraPosition(player1);
    const player2Camera = this.getShipCameraPosition(player2);
    const player1X = player1Camera.x;
    const player1Y = player1Camera.y;
    const player2X = player2Camera.x;
    const player2Y = player2Camera.y;
    let diffX = this.shortestWrappedDelta(player1X - player2X);
    let diffY = this.shortestWrappedDelta(player1Y - player2Y);
    let centerX = this.wrapSignedLegacyCoordinate(player2X + diffX / 2);
    let centerY = this.wrapSignedLegacyCoordinate(player2Y + diffY / 2);

    if (!player1.alive && player2.alive) {
      centerX = player2X;
      centerY = player2Y;
      diffX = 0;
      diffY = 0;
    } else if (player1.alive && !player2.alive) {
      centerX = player1X;
      centerY = player1Y;
      diffX = 0;
      diffY = 0;
    }

    const offset = Math.max(Math.abs(diffX), Math.abs(diffY), MIN_CAMERA_OFFSET);
    const ratio = offset / LEGACY_ARENA_RADIUS;
    const legacyScale = (480 / offset) * 0.75 * (ratio + 1);

    return {
      scale: legacyScale * screenScale,
      legacyScale,
      screenScale,
      centerX,
      centerY,
      screenCenterX: this.canvas.width / 2,
      screenCenterY: this.canvas.height / 2,
    };
  }

  private drawBackground(camera: LegacyCamera): void {
    const ctx = this.context;
    const space = this.images.getLoaded('space');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    this.clipPlayfield();

    if (space) {
      const backgroundScale = 0.0775 * (9 + camera.legacyScale) * camera.screenScale;
      const width = space.naturalWidth * backgroundScale;
      const height = space.naturalHeight * backgroundScale;

      ctx.globalAlpha = 0.74;
      ctx.drawImage(space, camera.screenCenterX - width / 2, camera.screenCenterY - height / 2, width, height);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    this.drawStars(camera);
    ctx.restore();
  }

  private drawStars(camera: LegacyCamera): void {
    const ctx = this.context;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const star of STAR_FIELD) {
      const x = camera.screenCenterX - (star.x - LEGACY_ARENA_RADIUS / 2) * camera.scale;
      const y = camera.screenCenterY - (star.y - LEGACY_ARENA_RADIUS / 2) * camera.scale;
      const scale = 1.5 * camera.scale * star.depth;
      const image = this.images.getLoaded(star.key);

      ctx.globalAlpha = star.alpha;
      if (image) {
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        ctx.drawImage(image, x - width / 2, y - height / 2, width, height);
      } else {
        const size = Math.max(1, 2 * scale);
        ctx.fillStyle = '#bfc8ff';
        ctx.fillRect(x, y, size, size);
      }
    }
    ctx.restore();
  }

  private drawPlanet(state: GameState, camera: LegacyCamera): void {
    const ctx = this.context;
    const planet = state.planet;
    const x = this.toScreenX(fixedToNumber(planet.x), camera);
    const y = this.toScreenY(fixedToNumber(planet.y), camera);
    const radius = fixedToNumber(planet.radius) * camera.scale;
    const planetImage = this.images.getLoaded('planet');

    if (planetImage) {
      const scale = 1.333 * camera.scale;
      const width = planetImage.naturalWidth * scale;
      const height = planetImage.naturalHeight * scale;
      ctx.drawImage(planetImage, x - width / 2, y - height / 2, width, height);
      return;
    }

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#f2cc60';
    ctx.fill();
  }

  private drawShip(ship: ShipState, camera: LegacyCamera): void {
    const x = this.toScreenX(fixedToNumber(ship.x), camera);
    const y = this.toScreenY(fixedToNumber(ship.y), camera);
    const angleRadians = (ship.angle / ANGLE_STEPS) * Math.PI * 2;
    const spriteRadians = this.toLegacySpriteRadians(angleRadians);

    this.drawShipUnderlayEffects(ship, camera);

    switch (ship.shipId) {
      case 'frog':
        this.drawFrogShip(ship, camera, x, y, angleRadians, spriteRadians);
        break;
      case 'cannonade':
        this.drawCannonadeShip(ship, camera, x, y, spriteRadians);
        break;
      case 'zizlik':
        this.drawZizlikShip(camera, x, y, spriteRadians, ship.alive ? 1 : 0.35);
        break;
      case 'voskum':
        this.drawVoskumShip(ship, camera, x, y, spriteRadians);
        break;
      case 'pscout':
        this.drawPScoutShip(ship, camera, x, y, angleRadians, spriteRadians);
        break;
      case 'kron':
        this.drawSimpleShip(ship, camera, x, y, spriteRadians, 'kronShip', 0.33);
        break;
      case 'gooj':
        this.drawSimpleShip(ship, camera, x, y, spriteRadians, 'goojShip', 0.04);
        break;
      case 'krab':
        this.drawKrabShip(ship, camera, x, y, spriteRadians);
        break;
      default:
        this.drawGenericShip(ship, camera, x, y, spriteRadians);
        break;
    }

    this.drawShipEffects(ship, camera);
    this.drawAiDebugOverlay(ship, camera, x, y);
  }

  private drawGenericShip(ship: ShipState, camera: LegacyCamera, x: number, y: number, radians: number): void {
    const ctx = this.context;
    const catalog = getShipCatalogEntry(ship.shipId ?? this.shipLoadout[ship.id] ?? DEFAULT_MATCH_SHIPS[ship.id]);
    const spec = catalog.render;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(radians);
    ctx.globalAlpha = ship.alive ? 1 : 0.35;

    if (spec.barrelKey) {
      const baseDrawn = this.drawSpriteNative(spec.spriteKey, camera.scale * spec.scale);
      const barrelDrawn = this.drawSpriteNative(spec.barrelKey, camera.scale * spec.scale);
      if (baseDrawn || barrelDrawn) {
        ctx.restore();
        return;
      }
    }

    if (this.drawSpriteNative(spec.spriteKey, camera.scale * spec.scale)) {
      ctx.restore();
      return;
    }

    this.drawShipFallback(ship, camera.scale);
    ctx.restore();
  }

  private drawFrogShip(
    ship: ShipState,
    camera: LegacyCamera,
    x: number,
    y: number,
    angleRadians: number,
    spriteRadians: number,
  ): void {
    const alpha = ship.alive ? 1 : 0.35;
    this.drawSimpleShip(ship, camera, x, y, spriteRadians, 'frogShip', 0.4);

    const charge = ship.custom.frogCharge ?? 0;
    if (charge > 0) {
      const offsetX = -30 * Math.cos(angleRadians) * camera.scale;
      const offsetY = -30 * Math.sin(angleRadians) * camera.scale;
      this.drawSpriteAt('frogShot', x + offsetX, y + offsetY, 0, camera.scale * 0.1 * Math.sqrt(charge), alpha);
    }

    if (ship.custom.frogShielded) {
      this.drawSpriteAt('frogShot', x, y, 0, camera.scale * 0.6, alpha);
    }
  }

  private drawCannonadeShip(ship: ShipState, camera: LegacyCamera, x: number, y: number, spriteRadians: number): void {
    const alpha = ship.alive ? 1 : 0.35;
    const baseKey = ship.secondaryCooldown > 0 ? 'cannonadeSeparated' : 'cannonadeBase';
    const baseDrawn = this.drawSpriteAt(baseKey, x, y, spriteRadians, camera.scale * 0.15, alpha);
    const barrelKey = ship.battery >= 6 && ship.primaryCooldown === 0 ? 'cannonadeBarrel' : 'cannonadeBarrelCharging';
    const cannonRadians = this.toLegacySpriteRadians(((ship.custom.cannonAngle ?? ship.angle) / ANGLE_STEPS) * Math.PI * 2);
    const barrelDrawn = this.drawSpriteAt(barrelKey, x, y, cannonRadians, camera.scale * 0.15, alpha);

    if (!baseDrawn && !barrelDrawn) {
      this.drawFallbackAt(ship, x, y, spriteRadians, camera.scale, alpha);
    }
  }

  private drawPScoutShip(
    ship: ShipState,
    camera: LegacyCamera,
    x: number,
    y: number,
    angleRadians: number,
    spriteRadians: number,
  ): void {
    const alpha = ship.alive ? 1 : 0.35;

    if (ship.battery >= 2 && ship.primaryCooldown === 0) {
      const offsetX = -15 * Math.cos(angleRadians) * camera.scale;
      const offsetY = -15 * Math.sin(angleRadians) * camera.scale;
      this.drawSpriteAt('pscoutBeacon', x + offsetX, y + offsetY, spriteRadians, camera.scale, alpha);
    }

    this.drawSimpleShip(ship, camera, x, y, spriteRadians, 'pscoutShip', 0.6);
  }

  private drawVoskumShip(ship: ShipState, camera: LegacyCamera, x: number, y: number, spriteRadians: number): void {
    this.drawVoskumTeleportImprints(ship, camera);
    this.drawSimpleShip(ship, camera, x, y, spriteRadians, 'voskumShip', 0.6);
  }

  private drawKrabShip(ship: ShipState, camera: LegacyCamera, x: number, y: number, radians: number): void {
    const spriteKey = ship.custom.krabLongRange ? 'krabShip' : 'krabShip2';
    this.drawSimpleShip(ship, camera, x, y, radians, spriteKey, 0.5);
  }

  private drawVoskumTeleportImprints(ship: ShipState, camera: LegacyCamera): void {
    const fromX = ship.custom.voskumTeleportFromX;
    const fromY = ship.custom.voskumTeleportFromY;
    const age = ship.custom.voskumTeleportAge;
    const angles = ship.custom.voskumTeleportAngles;
    if (fromX === undefined || fromY === undefined || age === undefined || !angles || angles.length === 0) {
      return;
    }

    const currentX = fixedToNumber(ship.x);
    const currentY = fixedToNumber(ship.y);
    const originX = fixedToNumber(fromX);
    const originY = fixedToNumber(fromY);
    const currentProgress = age / VOSKUM_TELEPORT_VISUAL_FRAMES;

    for (let index = 0; index < angles.length; index += 1) {
      const imprintProgress = index / Math.max(1, angles.length - 1);
      const distanceFromCurrent = Math.abs(imprintProgress - currentProgress);
      const pulse = Math.exp(-(distanceFromCurrent * distanceFromCurrent) / 0.0125);
      const alpha = (ship.alive ? 0.08 : 0.03) + pulse * (ship.alive ? 0.42 : 0.14);
      const imprintX = this.lerpWrappedLegacy(originX, currentX, imprintProgress);
      const imprintY = this.lerpWrappedLegacy(originY, currentY, imprintProgress);
      const x = this.toScreenX(imprintX, camera);
      const y = this.toScreenY(imprintY, camera);
      const radians = this.toLegacySpriteRadians((angles[index] / ANGLE_STEPS) * Math.PI * 2);

      this.drawTintedSpriteAt('voskumShip', x, y, radians, camera.scale * 0.6, alpha, VOSKUM_TELEPORT_IMPRINT_COLOR);
    }
  }

  private drawSimpleShip(
    ship: ShipState,
    camera: LegacyCamera,
    x: number,
    y: number,
    radians: number,
    spriteKey: LegacyAssetKey,
    shipScale: number,
  ): void {
    const alpha = ship.alive ? 1 : 0.35;
    if (!this.drawSpriteAt(spriteKey, x, y, radians, camera.scale * shipScale, alpha)) {
      this.drawFallbackAt(ship, x, y, radians, camera.scale, alpha);
    }
  }

  private drawSpriteAt(key: LegacyAssetKey, x: number, y: number, radians: number, scale: number, alpha: number): boolean {
    const ctx = this.context;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(radians);
    ctx.globalAlpha = alpha;
    const drawn = this.drawSpriteNative(key, scale);
    ctx.restore();
    return drawn;
  }

  private drawTintedSpriteAt(
    key: LegacyAssetKey,
    x: number,
    y: number,
    radians: number,
    scale: number,
    alpha: number,
    color: string,
  ): void {
    const image = this.images.getLoaded(key);
    const ctx = this.context;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(radians);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = color;
    ctx.shadowBlur = 22 * scale;

    if (image) {
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      ctx.filter = 'brightness(0) saturate(100%) invert(88%) sepia(98%) saturate(1131%) hue-rotate(46deg) brightness(111%) contrast(104%)';
      ctx.drawImage(image, -width / 2, -height / 2, width, height);
    } else {
      const width = 28 * scale;
      const height = 18 * scale;
      ctx.fillStyle = color;
      ctx.fillRect(-width / 2, -height / 2, width, height);
      ctx.fillRect(width / 6, -height / 4, width / 3, height / 2);
    }

    ctx.restore();
  }

  private drawFallbackAt(ship: ShipState, x: number, y: number, radians: number, scale: number, alpha: number): void {
    const ctx = this.context;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(radians);
    ctx.globalAlpha = alpha;
    this.drawShipFallback(ship, scale);
    ctx.restore();
  }

  private drawShipEffects(ship: ShipState, camera: LegacyCamera): void {
    const ctx = this.context;
    const x = this.toScreenX(fixedToNumber(ship.x), camera);
    const y = this.toScreenY(fixedToNumber(ship.y), camera);

    if (ship.freezeFrames > 0) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = '#79c0ff';
      ctx.lineWidth = Math.max(1, 2 * camera.scale);
      ctx.beginPath();
      ctx.arc(x, y, 34 * camera.scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawBoardOverlays(state: GameState, camera: LegacyCamera): void {
    for (const ship of state.ships) {
      if (ship.shipId === 'pscout' && ship.alive) {
        this.drawPScoutBeamOverlay(ship, state, camera);
      }
    }
  }

  private drawPScoutBeamOverlay(ship: ShipState, state: GameState, camera: LegacyCamera): void {
    const beamFrames = ship.custom.pscoutBeamFrames ?? 0;
    const beamStrength = ship.custom.pscoutBeamStrength ?? 0;
    if (beamFrames <= 0 || beamStrength <= 0) {
      return;
    }

    const enemy = state.ships.find((candidate) => candidate.id !== ship.id);
    if (!enemy) {
      return;
    }

    const ctx = this.context;
    const image = this.images.getLoaded('pscoutBeam');
    const x = this.canvas.width / 2;
    const jitterY = ((state.frame + ship.id * 7) % 5) - 2;
    const y = this.toScreenY(fixedToNumber(enemy.y), camera) + jitterY * camera.screenScale;
    const startupScale = beamFrames > PSCOUT_RENDER_BEAM_FRAMES / 2 ? 0.01 : 1;

    ctx.save();
    if (image) {
      const width = image.naturalWidth * camera.screenScale;
      const height = image.naturalHeight * camera.scale * beamStrength * startupScale;
      ctx.drawImage(image, x - width / 2, y - height / 2, width, height);
    } else {
      const height = Math.max(1, 12 * camera.scale * beamStrength * startupScale);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#f0f6fc';
      ctx.fillRect(0, y - height / 2, this.canvas.width, height);
    }
    ctx.restore();
  }

  private drawAiDebugOverlay(ship: ShipState, camera: LegacyCamera, x: number, y: number): void {
    if (!ship.alive) {
      return;
    }

    const mode = this.aiDebugModes[ship.id];
    if (!mode) {
      return;
    }

    const ctx = this.context;
    const label = getAiDebugLabel(mode);
    const fontSize = Math.max(10, Math.round(12 * camera.screenScale));
    const offsetY = Math.max(24, 34 * camera.scale);

    ctx.save();
    ctx.font = `700 ${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, Math.round(3 * camera.screenScale));
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = '#ffffff';
    ctx.strokeText(label, x, y - offsetY);
    ctx.fillText(label, x, y - offsetY);
    ctx.restore();
  }

  private drawShipFallback(ship: ShipState, scale: number): void {
    const ctx = this.context;
    const width = 28 * scale;
    const height = 18 * scale;

    ctx.fillStyle = SHIP_COLORS[ship.id] ?? '#d2a8ff';
    ctx.fillRect(-width / 2, -height / 2, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(width / 6, -height / 4, width / 3, height / 2);
  }

  private drawZizlikShip(camera: LegacyCamera, x: number, y: number, radians: number, alpha: number): void {
    const ctx = this.context;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = alpha;
    this.drawSpriteNative('zizlikRing', camera.scale * 0.4);
    ctx.rotate(radians);
    this.drawSpriteNative('zizlikCore', camera.scale * 0.4);
    ctx.restore();
  }

  private drawShipUnderlayEffects(ship: ShipState, camera: LegacyCamera): void {
    if (ship.shipId !== 'kron' || !ship.alive || ship.primaryCooldown <= 0) {
      return;
    }

    const image = this.images.getLoaded('kronBeam');
    if (!image) {
      return;
    }

    const ctx = this.context;
    const x = this.toScreenX(fixedToNumber(ship.x), camera);
    const y = this.toScreenY(fixedToNumber(ship.y), camera);
    const radians = this.toLegacySpriteRadians((ship.angle / ANGLE_STEPS) * Math.PI * 2);
    const scale = camera.scale * 0.33;
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(radians);
    ctx.globalAlpha = 1;
    ctx.drawImage(image, -width / 2, -height / 2 - height * 0.56, width, height);
    ctx.restore();
  }

  private drawProjectile(projectile: ProjectileState, camera: LegacyCamera): void {
    const ctx = this.context;
    const x = this.toScreenX(fixedToNumber(projectile.x), camera);
    const y = this.toScreenY(fixedToNumber(projectile.y), camera);
    const radians = this.getProjectileSpriteRadians(projectile);
    const spec = getShipCatalogEntry(this.shipLoadout[projectile.ownerId] ?? DEFAULT_MATCH_SHIPS[projectile.ownerId]).render;
    const key = this.getProjectileSpriteKey(projectile, spec.projectileKey);
    const scale = projectile.kind === 'goojJunk' ? 0.075 : projectile.kind === 'kronPulse' ? 0.4 : spec.projectileScale;
    const image = this.images.getLoaded(key);

    if (image) {
      const width = image.naturalWidth * camera.scale * scale;
      const height = image.naturalHeight * camera.scale * scale;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(radians);
      if (projectile.kind === 'kronPulse') {
        ctx.drawImage(image, -width / 2, -height / 2 - height * 0.56, width, height);
      } else {
        ctx.drawImage(image, -width / 2, -height / 2, width, height);
      }
      ctx.restore();
      return;
    }

    const size = 6 * camera.scale;
    ctx.fillStyle = PROJECTILE_COLORS[projectile.ownerId] ?? '#d2a8ff';
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
  }

  private getProjectileSpriteKey(projectile: ProjectileState, fallback: LegacyAssetKey): LegacyAssetKey {
    if (projectile.kind === 'goojJunk') {
      return GOOJ_JUNK_KEYS[Math.abs(projectile.variety ?? 0) % GOOJ_JUNK_KEYS.length];
    }

    if (projectile.kind === 'kronPulse') {
      return 'kronBeam';
    }

    if (projectile.kind === 'cannonadeBoomerang') {
      return 'cannonadeBoomerang';
    }

    return fallback;
  }

  private drawActor(actor: ActorState, camera: LegacyCamera): void {
    const ctx = this.context;
    const x = this.toScreenX(fixedToNumber(actor.x), camera);
    const y = this.toScreenY(fixedToNumber(actor.y), camera);

    switch (actor.kind) {
      case 'zizlikNode':
        this.drawZizlikNodeActor(actor, camera, x, y);
        return;
      case 'pscoutBeacon':
        this.drawBeaconActor(actor, camera, x, y);
        return;
      case 'goojBackNode':
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.strokeStyle = PROJECTILE_COLORS[actor.ownerId] ?? '#d2a8ff';
        ctx.lineWidth = Math.max(1, 2 * camera.scale);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(8, fixedToNumber(actor.radius) * camera.scale), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return;
    }
  }

  private drawZizlikNodeActor(actor: ActorState, camera: LegacyCamera, x: number, y: number): void {
    const ctx = this.context;
    const radians = this.toLegacySpriteRadians((actor.angle / ANGLE_STEPS) * Math.PI * 2);
    ctx.save();
    ctx.translate(x, y);
    this.drawSpriteNative('zizlikRing', camera.scale * 0.4);
    ctx.rotate(radians);
    this.drawSpriteNative('zizlikCore', camera.scale * 0.4);
    ctx.restore();
  }

  private drawBeaconActor(actor: ActorState, camera: LegacyCamera, x: number, y: number): void {
    const image = this.images.getLoaded('pscoutBeacon');
    const ctx = this.context;
    const radians = this.toLegacySpriteRadians((actor.angle / ANGLE_STEPS) * Math.PI * 2);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(radians);
    if (image) {
      const width = image.naturalWidth * camera.scale * 0.8;
      const height = image.naturalHeight * camera.scale * 0.8;
      ctx.drawImage(image, -width / 2, -height / 2, width, height);
    } else {
      ctx.fillStyle = PROJECTILE_COLORS[actor.ownerId] ?? '#d2a8ff';
      ctx.beginPath();
      ctx.arc(0, 0, 5 * camera.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawSpriteNative(key: LegacyAssetKey, scale: number): boolean {
    const image = this.images.getLoaded(key);
    if (!image) {
      return false;
    }

    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    this.context.drawImage(image, -width / 2, -height / 2, width, height);
    return true;
  }

  private toLegacySpriteRadians(radians: number): number {
    return radians - Math.PI / 2;
  }

  private getShipCameraPosition(ship: ShipState): { readonly x: number; readonly y: number } {
    return {
      x: fixedToNumber(ship.custom.cameraOverrideX ?? ship.x),
      y: fixedToNumber(ship.custom.cameraOverrideY ?? ship.y),
    };
  }

  private getProjectileSpriteRadians(projectile: ProjectileState): number {
    const vx = fixedToNumber(projectile.vx);
    const vy = fixedToNumber(projectile.vy);
    const direction =
      projectile.kind === 'kronPulse' || (vx === 0 && vy === 0)
        ? (projectile.angle / ANGLE_STEPS) * Math.PI * 2
        : Math.atan2(vy, vx);
    return this.toLegacySpriteRadians(direction);
  }

  private clipPlayfield(): void {
    const size = Math.min(this.canvas.width, this.canvas.height);
    const x = (this.canvas.width - size) / 2;
    const y = (this.canvas.height - size) / 2;
    this.context.beginPath();
    this.context.rect(x, y, size, size);
    this.context.clip();
  }

  private toScreenX(x: number, camera: LegacyCamera): number {
    return camera.screenCenterX - this.shortestWrappedDelta(x - camera.centerX) * camera.scale;
  }

  private toScreenY(y: number, camera: LegacyCamera): number {
    return camera.screenCenterY - this.shortestWrappedDelta(y - camera.centerY) * camera.scale;
  }

  private lerpWrappedLegacy(from: number, to: number, progress: number): number {
    return this.wrapSignedLegacyCoordinate(from + this.shortestWrappedDelta(to - from) * progress);
  }

  private shortestWrappedDelta(delta: number): number {
    return ((((delta + LEGACY_ARENA_RADIUS) % LEGACY_WORLD_SIZE) + LEGACY_WORLD_SIZE) % LEGACY_WORLD_SIZE) - LEGACY_ARENA_RADIUS;
  }

  private wrapSignedLegacyCoordinate(value: number): number {
    return ((((value + LEGACY_ARENA_RADIUS) % LEGACY_WORLD_SIZE) + LEGACY_WORLD_SIZE) % LEGACY_WORLD_SIZE) - LEGACY_ARENA_RADIUS;
  }

  private drawWinnerBanner(winnerId: number): void {
    const ctx = this.context;
    ctx.save();
    ctx.fillStyle = 'rgba(5, 8, 20, 0.72)';
    ctx.fillRect(0, this.canvas.height / 2 - 44, this.canvas.width, 88);
    ctx.fillStyle = SHIP_COLORS[winnerId] ?? '#ffffff';
    ctx.font = '700 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Player ${winnerId + 1} wins`, this.canvas.width / 2, this.canvas.height / 2);
    ctx.restore();
  }
}

function getAiDebugLabel(mode: AiMovementMode): string {
  switch (mode) {
    case 'pursuit':
      return 'P';
    case 'right':
      return 'R';
    case 'back':
      return 'B';
    case 'left':
      return 'L';
  }
}

function createStarField(count: number): readonly StarPlacement[] {
  let seed = 0x5eed1234;
  const stars: StarPlacement[] = [];

  for (let index = 0; index < count; index += 1) {
    const depth = 0.1 + nextRandom() * 0.9;
    stars.push({
      key: STAR_KEYS[index % STAR_KEYS.length],
      x: nextRandom() * LEGACY_ARENA_RADIUS,
      y: nextRandom() * LEGACY_ARENA_RADIUS,
      depth,
      alpha: 0.4 + depth * 0.55,
    });
  }

  return stars;

  function nextRandom(): number {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  }
}
