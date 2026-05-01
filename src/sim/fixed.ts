export type Fixed = number & { readonly __brand: 'Fixed' };

export const FIXED_SHIFT = 16;
export const FIXED_ONE = (1 << FIXED_SHIFT) as Fixed;

export function fixed(value: number): Fixed {
  return Math.trunc(value * FIXED_ONE) as Fixed;
}

export function fixedFromInt(value: number): Fixed {
  return (value << FIXED_SHIFT) as Fixed;
}

export function fixedToNumber(value: Fixed): number {
  return value / FIXED_ONE;
}

export function fixedAdd(a: Fixed, b: Fixed): Fixed {
  return (a + b) as Fixed;
}

export function fixedSub(a: Fixed, b: Fixed): Fixed {
  return (a - b) as Fixed;
}

export function fixedMul(a: Fixed, b: Fixed): Fixed {
  return Math.trunc((a * b) / FIXED_ONE) as Fixed;
}

export function fixedDiv(a: Fixed, b: Fixed): Fixed {
  if (b === 0) {
    throw new Error('Cannot divide fixed-point value by zero.');
  }

  return Math.trunc((a * FIXED_ONE) / b) as Fixed;
}

export function fixedClamp(value: Fixed, min: Fixed, max: Fixed): Fixed {
  return Math.min(Math.max(value, min), max) as Fixed;
}

export function fixedAbs(value: Fixed): Fixed {
  return Math.abs(value) as Fixed;
}

export function fixedSquared(value: Fixed): Fixed {
  return fixedMul(value, value);
}

export function fixedSqrt(value: Fixed): Fixed {
  if (value < 0) {
    throw new Error('Cannot take square root of a negative fixed-point value.');
  }

  return Math.trunc(Math.sqrt(value / FIXED_ONE) * FIXED_ONE) as Fixed;
}
