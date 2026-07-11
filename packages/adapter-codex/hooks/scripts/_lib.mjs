// Zero-dependency helpers shared by Batonpass's Codex hook scripts. Deliberately
// duplicates a slice of @batonpass/core's state.ts logic (see the same note
// in the Claude Code adapter's _lib.mjs) so these scripts have no node_modules
// dependency regardless of how the hooks directory got onto a user's machine.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function batonpassPaths(cwd) {
  const root = path.join(cwd, '.batonpass');
  return {
    root,
    handoffsDir: path.join(root, 'handoffs'),
    stateJson: path.join(root, 'state.json'),
    turnIdleMarker: path.join(root, 'turn-idle'),
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
