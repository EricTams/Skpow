import type { LegacyAssetKey } from './render/legacyAssets';
import { SHIP_SPECS, type ShipId } from './sim/shipSpecs';

export interface ShipCatalogEntry {
  readonly id: ShipCatalogId;
  readonly name: string;
  readonly cost: number;
  readonly crew: number;
  readonly battery: number;
  readonly render: {
    readonly spriteKey: LegacyAssetKey;
    readonly scale: number;
    readonly barrelKey?: LegacyAssetKey;
    readonly projectileKey: LegacyAssetKey;
    readonly projectileScale: number;
  };
  readonly hud: {
    readonly nameKey: LegacyAssetKey;
    readonly portraitKey: LegacyAssetKey;
    readonly shipKey: LegacyAssetKey;
    readonly shipOverlayKey?: LegacyAssetKey;
    readonly shipScale: number;
    readonly flippedPortrait?: boolean;
  };
}

export type ShipCatalogId = ShipId;

export const SHIP_CATALOG: readonly ShipCatalogEntry[] = [
  {
    id: 'frog',
    name: 'Frog',
    cost: 40,
    crew: SHIP_SPECS.frog.crew,
    battery: SHIP_SPECS.frog.battery,
    render: {
      spriteKey: 'frogShip',
      scale: 0.4,
      projectileKey: 'frogShot',
      projectileScale: 0.35,
    },
    hud: {
      nameKey: 'frogName',
      portraitKey: 'frogPortrait',
      shipKey: 'frogShip',
      shipScale: 1.2,
      flippedPortrait: true,
    },
  },
  {
    id: 'cannonade',
    name: 'Cannonade',
    cost: 60,
    crew: SHIP_SPECS.cannonade.crew,
    battery: SHIP_SPECS.cannonade.battery,
    render: {
      spriteKey: 'cannonadeBase',
      scale: 0.15,
      barrelKey: 'cannonadeBarrel',
      projectileKey: 'cannonadeShot',
      projectileScale: 0.15,
    },
    hud: {
      nameKey: 'cannonadeName',
      portraitKey: 'cannonadePortrait',
      shipKey: 'cannonadeBase',
      shipOverlayKey: 'cannonadeBarrel',
      shipScale: 0.345,
    },
  },
  {
    id: 'zizlik',
    name: 'Zizlik',
    cost: 40,
    crew: SHIP_SPECS.zizlik.crew,
    battery: SHIP_SPECS.zizlik.battery,
    render: {
      spriteKey: 'zizlikCore',
      scale: 0.4,
      barrelKey: 'zizlikRing',
      projectileKey: 'energyShot',
      projectileScale: 0.35,
    },
    hud: {
      nameKey: 'zizlikName',
      portraitKey: 'zizlikPortrait',
      shipKey: 'zizlikCore',
      shipOverlayKey: 'zizlikRing',
      shipScale: 1.2,
    },
  },
  {
    id: 'voskum',
    name: 'Voskum',
    cost: 50,
    crew: SHIP_SPECS.voskum.crew,
    battery: SHIP_SPECS.voskum.battery,
    render: {
      spriteKey: 'voskumShip',
      scale: 0.6,
      projectileKey: 'voskumShot',
      projectileScale: 0.6,
    },
    hud: {
      nameKey: 'voskumName',
      portraitKey: 'voskumPortrait',
      shipKey: 'voskumShip',
      shipScale: 1.8,
    },
  },
  {
    id: 'pscout',
    name: 'pScout',
    cost: 40,
    crew: SHIP_SPECS.pscout.crew,
    battery: SHIP_SPECS.pscout.battery,
    render: {
      spriteKey: 'pscoutShip',
      scale: 0.6,
      projectileKey: 'pscoutBeacon',
      projectileScale: 0.8,
    },
    hud: {
      nameKey: 'pscoutName',
      portraitKey: 'pscoutPortrait',
      shipKey: 'pscoutShip',
      shipScale: 1.8,
    },
  },
  {
    id: 'kron',
    name: 'Kron',
    cost: 50,
    crew: SHIP_SPECS.kron.crew,
    battery: SHIP_SPECS.kron.battery,
    render: {
      spriteKey: 'kronShip',
      scale: 0.33,
      projectileKey: 'kronBeam',
      projectileScale: 0.4,
    },
    hud: {
      nameKey: 'kronName',
      portraitKey: 'kronPortrait',
      shipKey: 'kronShip',
      shipScale: 0.8,
    },
  },
  {
    id: 'gooj',
    name: 'Gooj',
    cost: 60,
    crew: SHIP_SPECS.gooj.crew,
    battery: SHIP_SPECS.gooj.battery,
    render: {
      spriteKey: 'goojShip',
      scale: 0.04,
      projectileKey: 'goojShot',
      projectileScale: 0.125,
    },
    hud: {
      nameKey: 'goojName',
      portraitKey: 'goojPortrait',
      shipKey: 'goojShip',
      shipScale: 0.12,
    },
  },
  {
    id: 'nurtip',
    name: 'Nurtip',
    cost: 60,
    crew: SHIP_SPECS.nurtip.crew,
    battery: SHIP_SPECS.nurtip.battery,
    render: {
      spriteKey: 'nurtipShip',
      scale: 0.6,
      projectileKey: 'nurtipMissile',
      projectileScale: 0.45,
    },
    hud: {
      nameKey: 'nurtipName',
      portraitKey: 'nurtipPortrait',
      shipKey: 'nurtipShip',
      shipScale: 1.8,
    },
  },
  {
    id: 'krab',
    name: 'Krab',
    cost: 50,
    crew: SHIP_SPECS.krab.crew,
    battery: SHIP_SPECS.krab.battery,
    render: {
      spriteKey: 'krabShip2',
      scale: 0.5,
      barrelKey: 'krabShip',
      projectileKey: 'krabShot',
      projectileScale: 0.45,
    },
    hud: {
      nameKey: 'krabName',
      portraitKey: 'krabPortrait',
      shipKey: 'krabShip2',
      shipOverlayKey: 'krabShip',
      shipScale: 1.3,
    },
  },
] as const;

export const DEFAULT_MATCH_SHIPS: readonly [ShipCatalogId, ShipCatalogId] = ['frog', 'cannonade'];

export function getShipCatalogEntry(id: ShipCatalogId): ShipCatalogEntry {
  const entry = SHIP_CATALOG.find((ship) => ship.id === id);
  if (!entry) {
    throw new Error(`Unknown ship catalog id: ${id}`);
  }

  return entry;
}
