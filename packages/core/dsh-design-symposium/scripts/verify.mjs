/**
 * Verification harness.
 *
 * Builds the shipped artifacts, then bundles `test/verify-entry.ts` with the
 * Harness packages aliased to stubs so the whole engine can be exercised
 * offline — no API key, no provider, no Harness installation.
 *
 * Usage: `npm run verify`
 * Exit code 0 only when every check passes.
 *
 * @module dsh-design-symposium/scripts/verify
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = resolve(root, 'test/.build');

/** Bundle the verification entry against stubbed Harness packages. */
async function bundleVerifyEntry(esbuild) {
  mkdirSync(workDir, { recursive: true });
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['test/verify-entry.ts'],
    outfile: 'test/.build/verify-entry.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    minify: false,
    alias: {
      '@deepseek-ai/dsh-llm': resolve(root, 'test/stubs/dsh-llm.ts'),
      '@deepseek-ai/dsh-tools': resolve(root, 'test/stubs/dsh-tools.ts'),
      '@deepseek-ai/schemastery': resolve(root, 'test/stubs/schemastery.ts'),
    },
    logLevel: 'warning',
  });
  return resolve(workDir, 'verify-entry.mjs');
}



async function main() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch (error) {
    console.error(`[verify] 需要 esbuild 才能运行验证：${error.message}`);
    console.error('[verify] 先执行 npm install（或 pnpm install）。');
    process.exitCode = 1;
    return;
  }

  console.log('[verify] 构建 lib/index.js …');
  const { outfiles } = await build({ esbuild, logLevel: 'warning' });
  for (const path of outfiles) console.log(`[verify]   ✓ ${path}`);

  console.log('[verify] 打包离线验证入口 …');
  const entry = await bundleVerifyEntry(esbuild);

  // A mock run must not sleep through cost-meter's write debounce.
  process.env.SYMPOSIUM_LEDGER_SETTLE_MS = process.env.SYMPOSIUM_LEDGER_SETTLE_MS ?? '0';
  process.env.DSH_HOME = resolve(workDir, 'dsh-home');

  const module = await import(`${pathToFileURL(entry).href}?t=${Date.now()}`);
  const results = await module.runAllChecks();
  results.push(...await module.runCrashPathChecks());
  results.push(await module.runWiringCheck());
  results.push(module.checkModelCostWait());
  results.push(module.checkChairBudget());
  results.push(module.checkBriefContract());
  results.push(module.checkBriefReplace());
  results.push(await module.checkContextPrefixStability());
  results.push(await module.checkFixedRounds());
  results.push(await module.checkTierBudget());
  results.push(module.checkTierModel());
  results.push(module.checkJournalManual());
  results.push(await module.checkPauseResume());
  results.push(await module.checkChairRawMinutes());
  results.push(await module.checkP4Topology());

  let failed = 0;
  console.log('');
  for (const [index, result] of results.entries()) {
    const mark = result.ok ? '✓' : '✗';
    if (!result.ok) failed += 1;
    console.log(`[verify] ${mark} ${index + 1}. ${result.name}`);
    console.log(`[verify]     ${result.detail}`);
  }
  console.log('');
  console.log(`[verify] ${results.length - failed}/${results.length} 项通过`);

  try {
    rmSync(resolve(workDir, 'dsh-home'), { recursive: true, force: true });
  } catch {
    // Leaving an empty temp home behind is harmless.
  }
  if (failed > 0) process.exitCode = 1;
}

await main();
