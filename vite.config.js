import { defineConfig } from 'vite';

// Dev config for the examples. Serves the `examples/` folder but still allows
// importing the library source one level up.
export default defineConfig({
  root: 'examples',
  server: { fs: { allow: ['..'] } },
  build: { target: 'esnext' },
  resolve: { dedupe: ['three'] },
});
