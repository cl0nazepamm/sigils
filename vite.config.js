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
  resolve: { dedupe: ['three'] },
});
