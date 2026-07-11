import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Usage, UsageSource } from './types.js';
import { contextSizeForModel } from './types.js';
import { readTailUntil } from './tail.js';

/**
 * Shape written by Batonpass's statusline chain-command to `.batonpass/usage.json`
 * on every statusline refresh. This is the primary usage source for Claude Code.
 */
interface UsageJsonFile {
  pct: number;
  tokens: number;
  max: number;
  updatedAt: string;
}

/** One line of a Claude Code transcript JSONL file (only the fields Batonpass reads). */
interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

export class ClaudeUsageSource implements UsageSource {
  constructor(
    private readonly usageJsonPath: string,
    private readonly transcriptPath: string | (() => Promise<string | null>),
    private readonly modelContextOverrides: Record<string, number> = {},
    private readonly maxStaleMs = 30_000,
  ) {}

  async getUsage(): Promise<Usage | null> {
    const primary = await this.fromStatuslineFile();
    if (primary) return primary;
    return this.fromTranscript();
  }

  private async fromStatuslineFile(): Promise<Usage | null> {
    try {
      const text = await fs.readFile(this.usageJsonPath, 'utf8');
      const data = JSON.parse(text) as UsageJsonFile;
      const age = Date.now() - new Date(data.updatedAt).getTime();
      if (age > this.maxStaleMs) return null; // stale — fall back to transcript parsing
      return { pct: data.pct, tokens: data.tokens, max: data.max, source: 'statusline-file' };
    } catch {
      return null;
    }
  }

  private async fromTranscript(): Promise<Usage | null> {
    const transcriptPath =
      typeof this.transcriptPath === 'function' ? await this.transcriptPath() : this.transcriptPath;
    if (!transcriptPath) return null;

    const last = await lastAssistantUsageLine(transcriptPath);
    if (!last?.message?.usage) return null;

    const u = last.message.usage;
    const tokens =
      (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const max = contextSizeForModel(last.message.model, this.modelContextOverrides);
    return { pct: tokens / max, tokens, max, source: 'transcript-jsonl' };
  }
}

/** Pure scan of already-loaded text, from the end, for the last line with `message.usage`. */
export function extractLastAssistantUsageLine(text: string): TranscriptLine | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue; // truncated / mid-write line (or a partial line at the start of a tail window) — skip, don't throw
    }
    if (parsed.message?.usage) return parsed;
  }
  return null;
}

/**
 * Scan a (potentially huge, potentially mid-write) JSONL transcript file from the
 * end, returning the last well-formed line whose `message.usage` is present.
 * Reads only a bounded tail of the file (growing the window if needed) rather
 * than loading multi-GB transcripts into memory on every poll.
 */
export async function lastAssistantUsageLine(transcriptPath: string): Promise<TranscriptLine | null> {
  const text = await readTailUntil(transcriptPath, (t) => extractLastAssistantUsageLine(t) !== null);
  if (text === null) return null;
  return extractLastAssistantUsageLine(text);
}

/** Finds the most-recently-modified `<session-id>.jsonl` under a Claude Code project transcript dir. */
export async function findLatestTranscript(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(projectDir);
  } catch {
    return null;
  }
  const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) return null;

  const withMtime = await Promise.all(
    jsonlFiles.map(async (f) => {
      const p = path.join(projectDir, f);
      const stat = await fs.stat(p).catch(() => null);
      return { p, mtime: stat?.mtimeMs ?? 0 };
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0]?.p ?? null;
}

/** Claude Code slugifies the cwd for its project transcript directory name (`/` and `.` -> `-`). */
export function slugifyProjectPath(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}
