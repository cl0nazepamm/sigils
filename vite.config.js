import { defineConfig } from 'vite';

// Dev config for the examples. Serves the `examples/` folder but still allows
// importing the library source one level up.
const allowedHosts = process.env.VITE_ALLOWED_HOSTS
  ?.split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  root: 'examples',
  server: {
    allowedHosts,
    fs: { allow: ['..'] },
  },
  build: { target: 'esnext' },
  resolve: { dedupe: ['three'] },
});
