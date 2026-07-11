// Cross-platform test runner: executes every test/*.test.mjs directly with
// node (the repo convention is standalone assert scripts, not node:test).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, [join(dir, file)], { stdio: 'inherit' });
  if (res.status !== 0) {
    failed++;
    console.error(`FAIL ${file}`);
  }
}

if (failed > 0) {
  console.error(`${failed}/${files.length} test files failed`);
  process.exit(1);
}
console.log(`${files.length} test files passed`);
