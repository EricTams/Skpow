import type { ShipCustomState } from '../sim/types';
import type { ShipId } from '../sim/shipSpecs';

export interface NetworkFleetShip {
  readonly uid: string;
  readonly catalogId: ShipId;
  readonly alive: boolean;
  readonly persistent?: {
    readonly crew?: number;
    readonly custom?: ShipCustomState;
    readonly zizlikNodeSlots?: readonly number[];
    readonly pscoutBeaconSlots?: readonly number[];
  };
}

export type NetworkControlMessage =
  | {
      readonly type: 'fleetReady';
      readonly sideId: 0 | 1;
      readonly fleet: readonly NetworkFleetShip[];
    }
  | {
      readonly type: 'shipPicked';
      readonly sideId: 0 | 1;
      readonly uid: string;
    }
  | {
      readonly type: 'roundResolved';
      readonly outcome:
        | { readonly kind: 'winner'; readonly winnerId: 0 | 1 }
        | { readonly kind: 'draw' };
    };

export function encodeNetworkControlMessage(message: NetworkControlMessage): string {
  return JSON.stringify(message);
}

export function decodeNetworkControlMessage(message: string): NetworkControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null;
  }

  if (parsed.type === 'fleetReady') {
    if (!isPlayerSide(parsed.sideId) || !Array.isArray(parsed.fleet) || !parsed.fleet.every(isNetworkFleetShip)) {
      return null;
    }

    return { type: 'fleetReady', sideId: parsed.sideId, fleet: parsed.fleet };
  }

  if (parsed.type === 'shipPicked') {
    if (!isPlayerSide(parsed.sideId) || typeof parsed.uid !== 'string') {
      return null;
    }

    return { type: 'shipPicked', sideId: parsed.sideId, uid: parsed.uid };
  }

  if (parsed.type === 'roundResolved') {
    if (!isRecord(parsed.outcome)) {
      return null;
    }

    if (parsed.outcome.kind === 'draw') {
      return { type: 'roundResolved', outcome: { kind: 'draw' } };
    }

    if (parsed.outcome.kind === 'winner' && isPlayerSide(parsed.outcome.winnerId)) {
      return { type: 'roundResolved', outcome: { kind: 'winner', winnerId: parsed.outcome.winnerId } };
    }
  }

  return null;
}

function isNetworkFleetShip(value: unknown): value is NetworkFleetShip {
  if (!isRecord(value) || typeof value.uid !== 'string' || !isShipId(value.catalogId) || typeof value.alive !== 'boolean') {
    return false;
  }

  if (value.persistent !== undefined && !isRecord(value.persistent)) {
    return false;
  }

  return true;
}

function isPlayerSide(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function isShipId(value: unknown): value is ShipId {
  return (
    value === 'frog' ||
    value === 'cannonade' ||
    value === 'zizlik' ||
    value === 'voskum' ||
    value === 'pscout' ||
    value === 'kron' ||
    value === 'gooj' ||
    value === 'krab' ||
    value === 'nurtip' ||
    value === 'duk' ||
    value === 'discfighter' ||
    value === 'doubleship' ||
    value === 'bolter' ||
    value === 'shugg'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
