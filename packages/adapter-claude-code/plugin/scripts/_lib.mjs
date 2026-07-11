// Zero-dependency helpers shared by Batonpass's Claude Code hook scripts.
// Intentionally duplicates a small slice of @batonpass/core's state.ts logic
// (rather than importing it) so these scripts have no node_modules dependency
// and work no matter how the plugin directory was copied onto a user's machine.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function batonpassPaths(cwd) {
  const root = path.join(cwd, '.batonpass');
  return {
    root,
    handoffsDir: path.join(root, 'handoffs'),
    stateJson: path.join(root, 'state.json'),
    usageJson: path.join(root, 'usage.json'),
    turnIdleMarker: path.join(root, 'turn-idle'),
    compactBlockedMarker: path.join(root, 'compact-blocked'),
  };
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * A handoff directory name must be a single path segment matching Batonpass's own
 * `<seq>-<timestamp>` format — no `/`, no `..`. Defense in depth against a
 * malformed/tampered state.json.pendingHandoff value being used to build a path.
 */
export function isSafeHandoffDirName(name) {
  return typeof name === 'string' && /^\d+-[A-Za-z0-9_-]+$/.test(name);
}
