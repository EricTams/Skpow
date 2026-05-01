import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import { legacyAssets } from './legacyAssets';

interface ArtInventory {
  readonly files: readonly {
    readonly name: string;
    readonly relativePath: string;
  }[];
}

describe('legacyAssets', () => {
  it('maps every semantic asset to a concrete inventory entry', async () => {
    const inventoryUrl = new URL('../../art/inventory.json', import.meta.url);
    const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8')) as ArtInventory;
    const inventoryNames = new Set(inventory.files.map((file) => file.name));
    const inventoryPaths = new Set(inventory.files.map((file) => file.relativePath));

    for (const [key, asset] of Object.entries(legacyAssets)) {
      expect(inventoryPaths.has(asset.relativePath), key).toBe(true);
      expect(inventoryNames.has(posix.basename(asset.relativePath)), key).toBe(true);
    }
  });
});
