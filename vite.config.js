import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Dev config for the examples. Serves the `examples/` folder but still allows
// importing the library source one level up.
const allowedHosts = process.env.VITE_ALLOWED_HOSTS
  ?.split(',')
  .map((host) => host.trim())
  .filter(Boolean);

const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'examples');

// Build EVERY example page — vite only builds index.html by default, which
// left the other demos out of `build:example` and out of its import checks.
const pages = Object.fromEntries(
  readdirSync(examplesDir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f.replace(/\.html$/, ''), resolve(examplesDir, f)]),
);

export default defineConfig({
  root: 'examples',
  // GitHub Pages serves the demo from /<repo>/ — the deploy workflow sets this.
  base: process.env.PAGES_BASE || '/',
  server: {
    allowedHosts,
    // '..' = repo root; the sibling speedball checkout keeps `npm install
    // ../speedball` (npm-link workflow) servable in dev.
    fs: { allow: ['..', '../../speedball'] },
  },
  build: {
    target: 'esnext',
    rollupOptions: { input: pages },
  },
  // dedupe resolves these from THIS project's node_modules even when imported
  // by the symlinked ../speedball checkout (whose real path has none).
  resolve: { dedupe: ['three', 'three-mesh-bvh'] },
  // Don't prebundle speedball — its optimizeDeps cache can stick on an older
  // build across npm upgrades (lockfile hash alone didn't invalidate here),
  // which silently drops new kernel flags like envBackground.
  optimizeDeps: { exclude: ['speedball-gi'] },
});
