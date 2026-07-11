import { promises as fs } from 'node:fs';
import path from 'node:path';

interface Candidate {
  p: string;
  mtime: number;
  cwd: string | null;
}

async function readFirstLineCwd(filePath: string): Promise<string | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const firstLine = text.split('\n').find((l) => l.trim().length > 0);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as { payload?: { cwd?: string; session_meta?: { cwd?: string } } };
    return parsed.payload?.cwd ?? parsed.payload?.session_meta?.cwd ?? null;
  } catch {
    return null;
  }
}

async function walk(dir: string, depth: number, out: { p: string; mtime: number }[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) {
      await walk(p, depth + 1, out);
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      const stat = await fs.stat(p).catch(() => null);
      out.push({ p, mtime: stat?.mtimeMs ?? 0 });
    }
  }
}

/**
 * Finds the most recently modified rollout file whose recorded session cwd matches
 * `targetCwd`, falling back to the most recent rollout overall if no file's cwd could
 * be determined (rollout session_meta shape isn't guaranteed stable across versions —
 * see §2.2 re-verification notes on rollout files being an unconfirmed implementation
 * detail). This matters because `~/.codex/sessions/` is shared across every project,
 * not scoped per-cwd the way Claude Code's `~/.claude/projects/<slug>/` is.
 */
export async function findLatestRolloutForCwd(sessionsRoot: string, targetCwd: string): Promise<string | null> {
  const found: { p: string; mtime: number }[] = [];
  await walk(sessionsRoot, 0, found);
  if (found.length === 0) return null;

  const withCwd: Candidate[] = await Promise.all(
    found.map(async (f) => ({ ...f, cwd: await readFirstLineCwd(f.p) })),
  );

  const matching = withCwd.filter((c) => c.cwd === targetCwd);
  const pool = matching.length > 0 ? matching : withCwd;
  pool.sort((a, b) => b.mtime - a.mtime);
  return pool[0]?.p ?? null;
}
