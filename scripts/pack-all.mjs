import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const layers = ['core', 'forks', 'vcp-side'];
const failed = [];

for (const layer of layers) {
  const base = path.join(root, 'packages', layer);
  if (!fs.existsSync(base)) continue;
  const out = path.join(root, 'dist', layer);
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(base).sort()) {
    const dir = path.join(base, name);
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      console.log(`skip ${layer}/${name} (no package.json)`);
      continue;
    }
    try {
      const file = execSync('npm pack --pack-destination "' + out + '" --silent', {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      console.log(`ok   ${layer}/${name} -> ${file}`);
    } catch (e) {
      failed.push(`${layer}/${name}`);
      const msg = String(e.stderr || e.message).split('\n').find(Boolean) || 'unknown';
      console.error(`FAIL ${layer}/${name}: ${msg}`);
    }
  }
}

console.log(`\ndone: ${layers.length} layers, ${failed.length} failed`);
if (failed.length) process.exit(1);
