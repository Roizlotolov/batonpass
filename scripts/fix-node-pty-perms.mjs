// node-pty publishes its darwin `spawn-helper` prebuild without the execute
// bit in the npm tarball. pnpm preserves tarball permissions on extraction
// (npm/yarn happen to mask this), so every PTY spawn fails with
// "posix_spawnp failed." until the helper is chmod +x.
// Upstream: https://github.com/microsoft/node-pty/issues/850
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

if (process.platform !== 'win32') {
  /** All node-pty package roots, whichever linker layout is in use. */
  const roots = [];

  // pnpm store layout: node_modules/.pnpm/node-pty@<ver>/node_modules/node-pty
  const pnpmStore = 'node_modules/.pnpm';
  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      if (entry.startsWith('node-pty@')) {
        roots.push(path.join(pnpmStore, entry, 'node_modules', 'node-pty'));
      }
    }
  }
  // hoisted layout (npm/yarn or node-linker=hoisted)
  roots.push('node_modules/node-pty');

  for (const root of roots) {
    const candidates = [path.join(root, 'build', 'Release', 'spawn-helper')];
    const prebuilds = path.join(root, 'prebuilds');
    if (existsSync(prebuilds)) {
      for (const platform of readdirSync(prebuilds)) {
        candidates.push(path.join(prebuilds, platform, 'spawn-helper'));
      }
    }
    for (const file of candidates) {
      if (existsSync(file)) chmodSync(file, 0o755);
    }
  }
}
