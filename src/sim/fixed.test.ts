import { describe, expect, it } from 'vitest';

import { fixed, fixedAdd, fixedDiv, fixedFromInt, fixedMul, fixedSqrt, fixedToNumber } from './fixed';

describe('fixed-point helpers', () => {
  it('converts integers and decimals into fixed-point values', () => {
    expect(fixedFromInt(4)).toBe(262144);
    expect(fixedToNumber(fixed(1.5))).toBe(1.5);
  });

  it('performs deterministic fixed-point arithmetic', () => {
    expect(fixedToNumber(fixedAdd(fixed(1.25), fixed(2.5)))).toBe(3.75);
    expect(fixedToNumber(fixedMul(fixed(3), fixed(0.5)))).toBe(1.5);
    expect(fixedToNumber(fixedDiv(fixed(3), fixed(2)))).toBe(1.5);
  });

  it('takes square roots in fixed-point space', () => {
    expect(fixedToNumber(fixedSqrt(fixedFromInt(9)))).toBe(3);
    expect(fixedToNumber(fixedSqrt(fixed(2.25)))).toBe(1.5);
  });
});
