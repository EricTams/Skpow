import type { Fixed } from './fixed';

export type Angle = number & { readonly __brand: 'Angle' };

export const ANGLE_STEPS = 256;
export const ANGLE_MASK = ANGLE_STEPS - 1;

const SIN_LUT = buildTrigLut(Math.sin);
const COS_LUT = buildTrigLut(Math.cos);

export function angle(value: number): Angle {
  return (value & ANGLE_MASK) as Angle;
}

export function turn(current: Angle, delta: number): Angle {
  return angle(current + delta);
}

export function sinFixed(current: Angle): Fixed {
  return SIN_LUT[current & ANGLE_MASK];
}

export function cosFixed(current: Angle): Fixed {
  return COS_LUT[current & ANGLE_MASK];
}

function buildTrigLut(fn: (radians: number) => number): readonly Fixed[] {
  return Array.from({ length: ANGLE_STEPS }, (_, index) =>
    Math.trunc(fn((index / ANGLE_STEPS) * Math.PI * 2) * 65536),
  ) as Fixed[];
}
