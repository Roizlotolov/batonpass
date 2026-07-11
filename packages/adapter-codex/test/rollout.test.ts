import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLatestRolloutForCwd } from '../src/rollout.js';

describe('findLatestRolloutForCwd', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-codex-sessions-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('prefers a rollout whose session_meta cwd matches the target, even if an unrelated one is newer', async () => {
    const dir = path.join(root, '2026', '07', '11');
    await fs.mkdir(dir, { recursive: true });

    const otherProject = path.join(dir, 'rollout-other.jsonl');
    await fs.writeFile(otherProject, JSON.stringify({ payload: { cwd: '/some/other/project' } }) + '\n');
    await new Promise((r) => setTimeout(r, 10));

    const ourProject = path.join(dir, 'rollout-ours.jsonl');
    await fs.writeFile(ourProject, JSON.stringify({ payload: { cwd: '/my/project' } }) + '\n');

    // otherProject is technically not newer here, so bump its mtime to be newest to prove filtering works.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(otherProject, future, future);

    const result = await findLatestRolloutForCwd(root, '/my/project');
    expect(result).toBe(ourProject);
  });

  it('falls back to the most recent rollout overall when no cwd metadata matches', async () => {
    const dir = path.join(root, '2026', '07', '11');
    await fs.mkdir(dir, { recursive: true });
    const f1 = path.join(dir, 'rollout-1.jsonl');
    await fs.writeFile(f1, '{}\n');
    await new Promise((r) => setTimeout(r, 10));
    const f2 = path.join(dir, 'rollout-2.jsonl');
    await fs.writeFile(f2, '{}\n');

    const result = await findLatestRolloutForCwd(root, '/nonexistent/project');
    expect(result).toBe(f2);
  });

  it('returns null for an empty sessions root', async () => {
    expect(await findLatestRolloutForCwd(root, '/x')).toBeNull();
  });
});
