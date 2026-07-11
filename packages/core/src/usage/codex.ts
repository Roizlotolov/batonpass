import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Usage, UsageSource } from './types.js';
import { contextSizeForModel } from './types.js';
import { readTailUntil } from './tail.js';

/** One line of a Codex `rollout-*.jsonl` session file (only fields Batonpass reads). */
interface RolloutLine {
  type?: string;
  payload?: {
    type?: string;
    model?: string;
    info?: { total_token_usage?: { total_tokens?: number } };
    'total-token-usage'?: { total_tokens?: number };
    total_tokens?: number;
  };
}

export class CodexUsageSource implements UsageSource {
  constructor(
    private readonly rolloutPath: string | (() => Promise<string | null>),
    private readonly modelContextOverrides: Record<string, number> = {},
  ) {}

  async getUsage(): Promise<Usage | null> {
    const rolloutPath =
      typeof this.rolloutPath === 'function' ? await this.rolloutPath() : this.rolloutPath;
    if (!rolloutPath) return null;

    const last = await lastTokenCountEvent(rolloutPath);
    if (!last) return null;

    const max = contextSizeForModel(last.model, this.modelContextOverrides);
    return { pct: last.totalTokens / max, tokens: last.totalTokens, max, source: 'rollout-jsonl' };
  }
}

/** Pure scan of already-loaded text, from the end, for the last token-count event. */
export function extractLastTokenCountEvent(text: string): { totalTokens: number; model?: string } | null {
  const lines = text.split('\n');
  let model: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: RolloutLine;
    try {
      parsed = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    if (!model && parsed.payload?.model) model = parsed.payload.model;
    const totalTokens =
      parsed.payload?.info?.total_token_usage?.total_tokens ??
      parsed.payload?.['total-token-usage']?.total_tokens ??
      parsed.payload?.total_tokens;
    if (typeof totalTokens === 'number') {
      return { totalTokens, model: model ?? parsed.payload?.model };
    }
  }
  return null;
}

/**
 * Scan a (potentially huge, potentially mid-write) rollout JSONL file from the
 * end for the last token-count event. Reads only a bounded tail of the file
 * (growing the window if needed) rather than loading the whole session history
 * into memory on every poll. Tolerant of multiple historical payload shapes and
 * truncated trailing lines.
 */
export async function lastTokenCountEvent(
  rolloutPath: string,
): Promise<{ totalTokens: number; model?: string } | null> {
  const text = await readTailUntil(rolloutPath, (t) => extractLastTokenCountEvent(t) !== null);
  if (text === null) return null;
  return extractLastTokenCountEvent(text);
}

/** Finds today's-or-latest `rollout-*.jsonl` under `~/.codex/sessions/YYYY/MM/DD/`. */
export async function findLatestRollout(codexSessionsRoot: string): Promise<string | null> {
  const candidates: { p: string; mtime: number }[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        await walk(p, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        const stat = await fs.stat(p).catch(() => null);
        candidates.push({ p, mtime: stat?.mtimeMs ?? 0 });
      }
    }
  }

  await walk(codexSessionsRoot, 0);
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.p ?? null;
}
