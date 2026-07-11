import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeUsageSource,
  findLatestTranscript,
  lastAssistantUsageLine,
  slugifyProjectPath,
} from '../../src/usage/claude.js';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

describe('lastAssistantUsageLine', () => {
  it('returns the last line with usage from a well-formed transcript', async () => {
    const line = await lastAssistantUsageLine(path.join(FIXTURES, 'claude-transcript.jsonl'));
    expect(line?.message?.usage?.input_tokens).toBe(1600);
  });

  it('does not throw and still finds the last valid line when the file ends truncated', async () => {
    const line = await lastAssistantUsageLine(path.join(FIXTURES, 'claude-transcript-truncated.jsonl'));
    expect(line?.message?.usage?.input_tokens).toBe(1600);
  });

  it('returns null for a nonexistent file', async () => {
    expect(await lastAssistantUsageLine('/nope/nope.jsonl')).toBeNull();
  });
});

describe('slugifyProjectPath', () => {
  it('replaces / and . with -', () => {
    expect(slugifyProjectPath('/Users/roi/my.repo')).toBe('-Users-roi-my-repo');
  });
});

describe('findLatestTranscript', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-transcripts-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('picks the most recently modified .jsonl file', async () => {
    await fs.writeFile(path.join(dir, 'old.jsonl'), '{}');
    await new Promise((r) => setTimeout(r, 10));
    await fs.writeFile(path.join(dir, 'new.jsonl'), '{}');
    const latest = await findLatestTranscript(dir);
    expect(latest).toBe(path.join(dir, 'new.jsonl'));
  });

  it('returns null when the directory has no jsonl files', async () => {
    expect(await findLatestTranscript(dir)).toBeNull();
  });
});

describe('ClaudeUsageSource', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-usage-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('prefers a fresh statusline usage.json over the transcript', async () => {
    const usageJsonPath = path.join(dir, 'usage.json');
    await fs.writeFile(
      usageJsonPath,
      JSON.stringify({ pct: 0.5, tokens: 100_000, max: 200_000, updatedAt: new Date().toISOString() }),
    );
    const source = new ClaudeUsageSource(usageJsonPath, path.join(FIXTURES, 'claude-transcript.jsonl'));
    const usage = await source.getUsage();
    expect(usage?.source).toBe('statusline-file');
    expect(usage?.pct).toBe(0.5);
  });

  it('falls back to the transcript when usage.json is stale', async () => {
    const usageJsonPath = path.join(dir, 'usage.json');
    await fs.writeFile(
      usageJsonPath,
      JSON.stringify({
        pct: 0.5,
        tokens: 100_000,
        max: 200_000,
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const source = new ClaudeUsageSource(usageJsonPath, path.join(FIXTURES, 'claude-transcript.jsonl'), {}, 30_000);
    const usage = await source.getUsage();
    expect(usage?.source).toBe('transcript-jsonl');
    expect(usage?.tokens).toBe(3000); // input_tokens(1600) + cache_creation(0) + cache_read(1400)
  });

  it('falls back to the transcript when usage.json is missing entirely', async () => {
    const source = new ClaudeUsageSource(
      path.join(dir, 'does-not-exist.json'),
      path.join(FIXTURES, 'claude-transcript.jsonl'),
    );
    const usage = await source.getUsage();
    expect(usage?.source).toBe('transcript-jsonl');
  });

  it('returns null when neither source is available', async () => {
    const source = new ClaudeUsageSource(path.join(dir, 'nope.json'), path.join(dir, 'nope.jsonl'));
    expect(await source.getUsage()).toBeNull();
  });
});

describe('lastAssistantUsageLine on a huge transcript', () => {
  it('finds the last usage line in a multi-MB file without slurping the whole thing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-huge-transcript-'));
    try {
      const fillerLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(500) } });
      const usageLine = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      });
      const lines = Array(5000).fill(fillerLine); // ~2.5MB of filler
      lines.push(usageLine);
      const filePath = path.join(dir, 'huge.jsonl');
      await fs.writeFile(filePath, lines.join('\n') + '\n');

      const result = await lastAssistantUsageLine(filePath);
      expect(result?.message?.usage?.input_tokens).toBe(999);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
