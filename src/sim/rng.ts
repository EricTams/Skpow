export type RngSeed = number & { readonly __brand: 'RngSeed' };

export function rngSeed(value: number): RngSeed {
  return (value >>> 0) as RngSeed;
}

export function nextSeed(seed: RngSeed): RngSeed {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) as RngSeed;
}

export function randomUnit(seed: RngSeed): { seed: RngSeed; value: number } {
  const next = nextSeed(seed);
  return { seed: next, value: (next >>> 0) / 0x1_0000_0000 };
}
