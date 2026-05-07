import type { ShipId } from './sim/shipSpecs';

import skpow160Url from '../music/Skpow160.ogg?url';
import cannonadeSpecialUrl from '../sfx/cannonade_SW.ogg?url';
import cannonadeFireUrl from '../sfx/cannonade_WF.ogg?url';
import frogshipSpecialUrl from '../sfx/frogship_SW.ogg?url';
import frogshipFireUrl from '../sfx/frogship_WF.ogg?url';
import goojSpecialUrl from '../sfx/Gooj_SW.ogg?url';
import goojFireUrl from '../sfx/Gooj_WF.ogg?url';
import krabSpecialUrl from '../sfx/Krab_SW.ogg?url';
import krabFireUrl from '../sfx/krab_WF.ogg?url';
import kronSpecialUrl from '../sfx/kron_SW.ogg?url';
import kronFireUrl from '../sfx/kron_WF.ogg?url';
import nurtipSpecialUrl from '../sfx/nurtip_SW.ogg?url';
import nurtipFireUrl from '../sfx/nurtip_WF.ogg?url';
import panthonSpecialUrl from '../sfx/panthon_SW2.ogg?url';
import panthonFireUrl from '../sfx/panthon_WF.ogg?url';
import skpowUrl from '../sfx/skpow.ogg?url';
import voskumSpecialUrl from '../sfx/voskum_SW.ogg?url';
import voskumFireUrl from '../sfx/voskum_WF.ogg?url';
import weaponHitUrl from '../sfx/weaponhit6_WH.ogg?url';
import zizlikSpecialUrl from '../sfx/zizlik_SW.ogg?url';
import zizlikFireUrl from '../sfx/zizlik_WF.ogg?url';

export const audioAssets = {
  music: {
    combat: skpow160Url,
  },
  sfx: {
    SOUND_DIE: skpowUrl,
    SOUND_HIT: weaponHitUrl,
    SOUND_FROGSHIP_FIRE: frogshipFireUrl,
    SOUND_FROGSHIP_SPECIAL: frogshipSpecialUrl,
    SOUND_CANNONADE_FIRE: cannonadeFireUrl,
    SOUND_CANNONADE_SPECIAL: cannonadeSpecialUrl,
    SOUND_NURTIP_FIRE: nurtipFireUrl,
    SOUND_NURTIP_SPECIAL: nurtipSpecialUrl,
    SOUND_ZIZLIK_FIRE: zizlikFireUrl,
    SOUND_ZIZLIK_SPECIAL: zizlikSpecialUrl,
    SOUND_GOOJ_FIRE: goojFireUrl,
    SOUND_GOOJ_SPECIAL: goojSpecialUrl,
    SOUND_KRON_FIRE: kronFireUrl,
    SOUND_KRON_SPECIAL: kronSpecialUrl,
    SOUND_PANTHON_FIRE: panthonFireUrl,
    SOUND_PANTHON_SPECIAL: panthonSpecialUrl,
    SOUND_VOSKUM_FIRE: voskumFireUrl,
    SOUND_VOSKUM_SPECIAL: voskumSpecialUrl,
    SOUND_KRAB_FIRE: krabFireUrl,
    SOUND_KRAB_SPECIAL: krabSpecialUrl,
  },
} as const;

export type SfxId = keyof typeof audioAssets.sfx;

export const shipSfx: Record<ShipId, { readonly primary: SfxId; readonly secondary: SfxId }> = {
  frog: {
    primary: 'SOUND_FROGSHIP_FIRE',
    secondary: 'SOUND_FROGSHIP_SPECIAL',
  },
  cannonade: {
    primary: 'SOUND_CANNONADE_FIRE',
    secondary: 'SOUND_CANNONADE_SPECIAL',
  },
  zizlik: {
    primary: 'SOUND_ZIZLIK_FIRE',
    secondary: 'SOUND_ZIZLIK_SPECIAL',
  },
  voskum: {
    primary: 'SOUND_VOSKUM_FIRE',
    secondary: 'SOUND_VOSKUM_SPECIAL',
  },
  pscout: {
    primary: 'SOUND_PANTHON_FIRE',
    secondary: 'SOUND_PANTHON_SPECIAL',
  },
  kron: {
    primary: 'SOUND_KRON_FIRE',
    secondary: 'SOUND_KRON_SPECIAL',
  },
  gooj: {
    primary: 'SOUND_GOOJ_FIRE',
    secondary: 'SOUND_GOOJ_SPECIAL',
  },
  krab: {
    primary: 'SOUND_KRAB_FIRE',
    secondary: 'SOUND_KRAB_SPECIAL',
  },
  nurtip: {
    primary: 'SOUND_NURTIP_FIRE',
    secondary: 'SOUND_NURTIP_SPECIAL',
  },
};
