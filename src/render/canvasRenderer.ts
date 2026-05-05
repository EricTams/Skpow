import { fixedToNumber } from '../sim/fixed';
import { DEFAULT_MATCH_SHIPS, getShipCatalogEntry, type ShipCatalogId } from '../ships';
import type { AiMovementMode } from '../sim/ai';
import { ANGLE_STEPS } from '../sim/trig';
import type { ActorState, EffectState, GameState, ProjectileState, ShipState } from '../sim/types';
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
const SHIP_EXPLOSION_FRAME_COUNT = 40;
const NURTIP_MISSILE_FRAME_COUNT = 13;
const NURTIP_ASTEROID_FRAME_COUNT = 20;
const NURTIP_EXPLOSION_FRAME_COUNT = 8;
const NURTIP_EXPLOSION_LIFE = 32;
const SHIP_EXPLOSION_LIFE_AT_FIRST_FRAME = 80;
const SHIP_EXPLOSION_RENDER_SCALE = 1.0;
const THRUST_DUST_COLOR = 'rgb(255, 144, 64)';
const THRUST_DUST_BASE_RADIUS = 12;
const GOOJ_JUNK_KEYS = ['goojJunk', 'goojJunk2', 'goojJunk3', 'goojJunk4', 'goojJunk5', 'goojJunk6', 'goojJunk7'] as const satisfies readonly LegacyAssetKey[];
const DUST_MIN_PARALLAX = 0.35;
const DUST_MAX_PARALLAX = 1.0;
const DUST_MIN_SIZE = 0.8;
const DUST_MAX_SIZE = 3.4;
const DUST_MIN_GRAY = 48;
const DUST_MAX_GRAY = 150;
const DUST_DEPTH_BIAS = 0.6;
const DUST_FIELD = createDustField(750, 0x71a3f0d);
type MatchShipLoadout = readonly [ShipCatalogId, ShipCatalogId];
type AiDebugModes = readonly (AiMovementMode | null)[];

interface LegacyCamera {
  readonly scale: number;
  readonly legacyScale: number;
  readonly screenScale: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly driftX: number;
  readonly driftY: number;
  readonly screenCenterX: number;
  readonly screenCenterY: number;
}

interface DustParticle {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly parallax: number;
  readonly size: number;
  readonly color: string;
}

export class CanvasRenderer {
  private readonly context: CanvasRenderingContext2D;
  private shipLoadout: MatchShipLoadout = DEFAULT_MATCH_SHIPS;
  private aiDebugModes: AiDebugModes = [];
  private lastCameraCenterX: number | null = null;
  private lastCameraCenterY: number | null = null;
  private cameraDriftX = 0;
  private cameraDriftY = 0;

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

    // Thrust dust trails draw beneath ships (legacy DrawPre).
    for (const effect of state.effects) {
      if (effect.kind === 'thrustDust') {
        this.drawEffect(effect, camera);
      }
    }

    for (const ship of state.ships) {
      this.drawShip(ship, state, camera);
    }

    // Explosion blooms draw above ships (legacy DrawPost).
    for (const effect of state.effects) {
      if (effect.kind === 'shipExplosion' || effect.kind === 'nurtipExplosion') {
        this.drawEffect(effect, camera);
      }
    }

    this.drawBoardOverlays(state, camera);

    if (state.winnerId !== null && !hasActiveShipExplosion(state)) {
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

    // While a death explosion is still playing, keep framing the dying ship's
    // last position so the camera doesn't snap to the survivor mid-blast.
    const explosionActive = hasActiveShipExplosion(state);

    if (!player1.alive && player2.alive && !explosionActive) {
      centerX = player2X;
      centerY = player2Y;
      diffX = 0;
      diffY = 0;
    } else if (player1.alive && !player2.alive && !explosionActive) {
      centerX = player1X;
      centerY = player1Y;
      diffX = 0;
      diffY = 0;
    }

    const offset = Math.max(Math.abs(diffX), Math.abs(diffY), MIN_CAMERA_OFFSET);
    const ratio = offset / LEGACY_ARENA_RADIUS;
    const legacyScale = (480 / offset) * 0.75 * (ratio + 1);

    if (this.lastCameraCenterX === null || this.lastCameraCenterY === null) {
      this.cameraDriftX = centerX;
      this.cameraDriftY = centerY;
    } else {
      this.cameraDriftX += this.shortestWrappedDelta(centerX - this.lastCameraCenterX);
      this.cameraDriftY += this.shortestWrappedDelta(centerY - this.lastCameraCenterY);
    }
    this.lastCameraCenterX = centerX;
    this.lastCameraCenterY = centerY;

    return {
      scale: legacyScale * screenScale,
      legacyScale,
      screenScale,
      centerX,
      centerY,
      driftX: this.cameraDriftX,
      driftY: this.cameraDriftY,
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

    this.drawDust(camera, DUST_FIELD);
    ctx.restore();
  }

  private drawDust(camera: LegacyCamera, field: readonly DustParticle[]): void {
    const ctx = this.context;
    ctx.save();
    for (const dust of field) {
      const dx = this.shortestWrappedDelta(dust.x - camera.driftX * dust.parallax);
      const dy = this.shortestWrappedDelta(dust.y - camera.driftY * dust.parallax);
      const screenX = camera.screenCenterX - dx * camera.scale;
      const screenY = camera.screenCenterY - dy * camera.scale;
      const size = Math.max(1, dust.size * camera.scale);
      ctx.fillStyle = dust.color;
      ctx.fillRect(screenX - size / 2, screenY - size / 2, size, size);
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

  private drawShip(ship: ShipState, state: GameState, camera: LegacyCamera): void {
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
        this.drawCannonadeShip(ship, state, camera, x, y, spriteRadians);
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
      case 'nurtip':
        this.drawNurtipShip(ship, camera, x, y, angleRadians, spriteRadians);
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

  private drawCannonadeShip(ship: ShipState, state: GameState, camera: LegacyCamera, x: number, y: number, spriteRadians: number): void {
    const alpha = ship.alive ? 1 : 0.35;
    const secondaryActive =
      ship.secondaryCooldown > 0 ||
      state.projectiles.some((projectile) => projectile.active && projectile.ownerId === ship.id && projectile.kind === 'cannonadeBoomerang');
    const baseKey = secondaryActive ? 'cannonadeSeparated' : 'cannonadeBase';
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

  private drawNurtipShip(
    ship: ShipState,
    camera: LegacyCamera,
    x: number,
    y: number,
    angleRadians: number,
    spriteRadians: number,
  ): void {
    this.drawSimpleShip(ship, camera, x, y, spriteRadians, 'nurtipShip', 0.6);

    // Reference Nurtip::Draw alternates two barrel sprites while a primary missile is ready/in-flight.
    const primaryReady = ship.alive && ship.primaryCooldown === 0 && ship.battery >= 6;
    const primaryArmed = Boolean(ship.custom.nurtipPrimaryArmed);
    if (primaryReady || primaryArmed) {
      const barrelKey: LegacyAssetKey = (ship.id + ship.angle) % 2 === 0 ? 'nurtipBarrel1' : 'nurtipBarrel2';
      const offset = 18 * camera.scale;
      const offsetX = Math.cos(angleRadians) * offset;
      const offsetY = Math.sin(angleRadians) * offset;
      const alpha = primaryArmed ? 0.6 : 1;
      this.drawSpriteAt(barrelKey, x + offsetX, y + offsetY, spriteRadians, camera.scale * 0.6, alpha);
    }
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

    const image = this.images.getLoaded(pickKronBeamKey());
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

    if (projectile.kind === 'nurtipMissile') {
      this.drawNurtipMissileProjectile(projectile, camera, x, y, radians);
      return;
    }
    if (projectile.kind === 'nurtipAsteroid') {
      this.drawNurtipAsteroidProjectile(projectile, camera, x, y);
      return;
    }

    const spec = getShipCatalogEntry(this.shipLoadout[projectile.ownerId] ?? DEFAULT_MATCH_SHIPS[projectile.ownerId]).render;
    const key = this.getProjectileSpriteKey(projectile, spec.projectileKey);
    const scale = this.getProjectileRenderScale(projectile, spec.projectileScale);
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

  private drawNurtipMissileProjectile(
    projectile: ProjectileState,
    camera: LegacyCamera,
    x: number,
    y: number,
    radians: number,
  ): void {
    const image = this.images.getLoaded('nurtipMissile');
    const ctx = this.context;
    if (!image) {
      const size = 8 * camera.scale;
      ctx.fillStyle = '#ffd28a';
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      return;
    }
    // Each cel is one strip frame; cycle through them at ~12fps to flicker the rocket art.
    const frameIndex = Math.floor(projectile.ttl / 5) % NURTIP_MISSILE_FRAME_COUNT;
    const cellWidth = image.naturalWidth / NURTIP_MISSILE_FRAME_COUNT;
    const cellHeight = image.naturalHeight;
    const drawScale = camera.scale * 0.55;
    const drawWidth = cellWidth * drawScale;
    const drawHeight = cellHeight * drawScale;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(radians);
    ctx.drawImage(
      image,
      frameIndex * cellWidth,
      0,
      cellWidth,
      cellHeight,
      -drawWidth / 2,
      -drawHeight / 2,
      drawWidth,
      drawHeight,
    );
    ctx.restore();
  }

  private drawNurtipAsteroidProjectile(
    projectile: ProjectileState,
    camera: LegacyCamera,
    x: number,
    y: number,
  ): void {
    const image = this.images.getLoaded('nurtipAsteroid');
    const ctx = this.context;
    if (!image) {
      const size = 10 * camera.scale;
      ctx.fillStyle = '#a87f4a';
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      return;
    }
    // Use rotation accumulator to pick a tumbling cel; the strip is a full 360° cycle.
    const rot = fixedToNumber(projectile.rotation);
    const normalized = ((rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const frameIndex = Math.floor((normalized / (Math.PI * 2)) * NURTIP_ASTEROID_FRAME_COUNT) % NURTIP_ASTEROID_FRAME_COUNT;
    const cellWidth = image.naturalWidth / NURTIP_ASTEROID_FRAME_COUNT;
    const cellHeight = image.naturalHeight;
    const drawScale = camera.scale * 0.5;
    const drawWidth = cellWidth * drawScale;
    const drawHeight = cellHeight * drawScale;
    ctx.drawImage(
      image,
      frameIndex * cellWidth,
      0,
      cellWidth,
      cellHeight,
      x - drawWidth / 2,
      y - drawHeight / 2,
      drawWidth,
      drawHeight,
    );
  }

  private getProjectileSpriteKey(projectile: ProjectileState, fallback: LegacyAssetKey): LegacyAssetKey {
    if (projectile.kind === 'goojJunk') {
      return GOOJ_JUNK_KEYS[Math.abs(projectile.variety ?? 0) % GOOJ_JUNK_KEYS.length];
    }

    if (projectile.kind === 'kronPulse') {
      return pickKronBeamKey();
    }

    if (projectile.kind === 'cannonadeBoomerang') {
      return 'cannonadeBoomerang';
    }

    return fallback;
  }

  private getProjectileRenderScale(projectile: ProjectileState, fallback: number): number {
    if (projectile.kind === 'goojJunk') {
      return 0.075;
    }

    if (projectile.kind === 'kronPulse') {
      return 0.4;
    }

    if (projectile.kind === 'frogBubble') {
      const charge = Math.max(0, (fixedToNumber(projectile.radius) - 10) / 3);
      return 0.1 * Math.sqrt(charge);
    }

    return fallback;
  }

  private drawActor(actor: ActorState, camera: LegacyCamera): void {
    if (actor.kind === 'goojBackNode') {
      return;
    }

    const x = this.toScreenX(fixedToNumber(actor.x), camera);
    const y = this.toScreenY(fixedToNumber(actor.y), camera);

    switch (actor.kind) {
      case 'zizlikNode':
        this.drawZizlikNodeActor(actor, camera, x, y);
        return;
      case 'pscoutBeacon':
        this.drawBeaconActor(actor, camera, x, y);
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

  private drawEffect(effect: EffectState, camera: LegacyCamera): void {
    if (effect.kind === 'thrustDust') {
      this.drawThrustDust(effect, camera);
      return;
    }

    if (effect.kind === 'nurtipExplosion') {
      this.drawNurtipExplosion(effect, camera);
      return;
    }

    if (effect.kind !== 'shipExplosion') {
      return;
    }

    const image = this.images.getLoaded('shipExplosion');
    const x = this.toScreenX(fixedToNumber(effect.x), camera);
    const y = this.toScreenY(fixedToNumber(effect.y), camera);
    const rawFrame = Math.floor((SHIP_EXPLOSION_LIFE_AT_FIRST_FRAME - effect.life) / 2);
    const frameIndex = rawFrame >= 0 && rawFrame < SHIP_EXPLOSION_FRAME_COUNT ? rawFrame : 0;

    const ctx = this.context;
    if (!image) {
      const fallbackRadius = Math.max(2, 18 * camera.scale * (effect.life / Math.max(1, effect.maxLife)));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#ffd28a';
      ctx.beginPath();
      ctx.arc(x, y, fallbackRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    const cellWidth = image.naturalWidth / SHIP_EXPLOSION_FRAME_COUNT;
    const cellHeight = image.naturalHeight;
    const drawScale = camera.scale * SHIP_EXPLOSION_RENDER_SCALE;
    const drawWidth = cellWidth * drawScale;
    const drawHeight = cellHeight * drawScale;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(
      image,
      frameIndex * cellWidth,
      0,
      cellWidth,
      cellHeight,
      x - drawWidth / 2,
      y - drawHeight / 2,
      drawWidth,
      drawHeight,
    );
    ctx.restore();
  }

  private drawNurtipExplosion(effect: EffectState, camera: LegacyCamera): void {
    const ctx = this.context;
    const x = this.toScreenX(fixedToNumber(effect.x), camera);
    const y = this.toScreenY(fixedToNumber(effect.y), camera);
    const image = this.images.getLoaded('nurtipExplosion');
    const elapsed = NURTIP_EXPLOSION_LIFE - effect.life;
    if (!image) {
      // Fallback: bright AOE bubble that fades.
      const alpha = Math.max(0, effect.life / NURTIP_EXPLOSION_LIFE);
      const radius = 60 * camera.scale * (1 + elapsed / NURTIP_EXPLOSION_LIFE);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = '#ffd28a';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    const frameIndex = Math.min(
      NURTIP_EXPLOSION_FRAME_COUNT - 1,
      Math.max(0, Math.floor((elapsed * NURTIP_EXPLOSION_FRAME_COUNT) / NURTIP_EXPLOSION_LIFE)),
    );
    const cellWidth = image.naturalWidth / NURTIP_EXPLOSION_FRAME_COUNT;
    const cellHeight = image.naturalHeight;
    const drawScale = camera.scale * 1.0;
    const drawWidth = cellWidth * drawScale;
    const drawHeight = cellHeight * drawScale;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(
      image,
      frameIndex * cellWidth,
      0,
      cellWidth,
      cellHeight,
      x - drawWidth / 2,
      y - drawHeight / 2,
      drawWidth,
      drawHeight,
    );
    ctx.restore();
  }

  private drawThrustDust(effect: EffectState, camera: LegacyCamera): void {
    const ctx = this.context;
    const x = this.toScreenX(fixedToNumber(effect.x), camera);
    const y = this.toScreenY(fixedToNumber(effect.y), camera);
    const lifeFraction = Math.max(0, effect.life / Math.max(1, effect.maxLife));
    const particleScale = fixedToNumber(effect.scale);
    // Size shrinks gradually; sqrt keeps the puff full-bodied for most of its life.
    const radius = Math.max(1, THRUST_DUST_BASE_RADIUS * particleScale * Math.sqrt(lifeFraction) * camera.scale);
    // Alpha holds bright longer before fading toward zero.
    const alpha = Math.min(1, 0.95 * Math.sqrt(lifeFraction));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, THRUST_DUST_COLOR);
    gradient.addColorStop(1, 'rgba(255, 144, 64, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
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
    if (projectile.kind === 'goojTorp') {
      return -0.05 * projectile.ttl;
    }

    if (projectile.kind === 'goojJunk') {
      return -0.035 * projectile.ttl;
    }

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

function pickKronBeamKey(): LegacyAssetKey {
  return Math.random() < 0.5 ? 'kronBeam' : 'kronBeam2';
}

export function hasActiveShipExplosion(state: GameState): boolean {
  return state.effects.some((effect) => effect.kind === 'shipExplosion');
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

function createDustField(count: number, seedValue: number): readonly DustParticle[] {
  let seed = seedValue >>> 0;
  const dust: DustParticle[] = [];

  for (let index = 0; index < count; index += 1) {
    const depth = Math.pow(nextRandom(), DUST_DEPTH_BIAS);
    const parallax = DUST_MIN_PARALLAX + depth * (DUST_MAX_PARALLAX - DUST_MIN_PARALLAX);
    const size = DUST_MIN_SIZE + depth * (DUST_MAX_SIZE - DUST_MIN_SIZE);
    const gray = Math.round(DUST_MIN_GRAY + depth * (DUST_MAX_GRAY - DUST_MIN_GRAY));
    dust.push({
      x: (nextRandom() * 2 - 1) * LEGACY_ARENA_RADIUS,
      y: (nextRandom() * 2 - 1) * LEGACY_ARENA_RADIUS,
      depth,
      parallax,
      size,
      color: `rgb(${gray}, ${gray}, ${gray})`,
    });
  }

  dust.sort((a, b) => a.depth - b.depth);
  return dust;

  function nextRandom(): number {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  }
}
