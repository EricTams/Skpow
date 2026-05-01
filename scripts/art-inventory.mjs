/**
 * Lists all files under `art/` and writes `art/inventory.json`.
 * Run: npm run art:inventory
 */
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const artDir = join(projectRoot, 'art');
const outFile = join(artDir, 'inventory.json');

async function main() {
  const entries = await readdir(artDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const name = entry.name;
    if (name === 'inventory.json') {
      continue;
    }
    const abs = join(artDir, name);
    const st = await stat(abs);
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot) : '';
    files.push({
      name,
      ext,
      relativePath: relative(projectRoot, abs).replaceAll('\\', '/'),
      sizeBytes: st.size,
      kind: kindForExt(ext),
    });
  }

  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const payload = {
    generatedAt: new Date().toISOString(),
    root: 'art',
    fileCount: files.length,
    files,
  };

  await writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${files.length} entries to ${relative(projectRoot, outFile)}`);
}

function kindForExt(ext) {
  const lower = ext.toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(lower)) {
    return 'image';
  }
  if (lower === '.xml') {
    return 'manifest';
  }
  return 'other';
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
