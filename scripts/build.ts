#!/usr/bin/env bun
// build.ts: bundles client TypeScript entrypoints in src/client/ into public/ and generates the Service Worker precache manifest.

import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = (p: string) => access(p).then(() => true, () => false);

export interface BuildTarget {
  entry: string;
  outfile: string;
  format?: 'esm' | 'iife';
}

export const CLIENT_TARGETS: BuildTarget[] = [
  { entry: 'src/client/app.ts', outfile: 'public/app.js', format: 'esm' },
  { entry: 'src/client/home.ts', outfile: 'public/home.js', format: 'esm' },
  { entry: 'src/client/theme.ts', outfile: 'public/theme.js', format: 'esm' },
  { entry: 'src/client/signin.ts', outfile: 'public/signin/signin.js', format: 'esm' },
  { entry: 'src/client/legal.ts', outfile: 'public/legal/legal.js', format: 'iife' },
  { entry: 'src/client/sw.ts', outfile: 'public/sw.js', format: 'iife' },
];

export async function buildClient(opts: { quiet?: boolean } = {}): Promise<void> {
  const t0 = performance.now();
  let builtCount = 0;

  for (const target of CLIENT_TARGETS) {
    const entryPath = path.join(REPO, target.entry);
    if (!(await exists(entryPath))) continue;
    const outPath = path.join(REPO, target.outfile);
    const result = await Bun.build({
      entrypoints: [entryPath],
      outdir: path.dirname(outPath),
      naming: path.basename(outPath),
      target: 'browser',
      format: target.format ?? 'esm',
      minify: false,
      sourcemap: 'none',
    });
    if (!result.success) {
      const msg = result.logs.map(l => l.message || String(l)).join('\n');
      throw new Error(`Bun.build failed for ${target.entry}:\n${msg}`);
    }
    builtCount++;
  }

  if (!opts.quiet && builtCount > 0) {
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`Built ${builtCount} client bundle(s) in ${ms}ms.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildClient();
}
