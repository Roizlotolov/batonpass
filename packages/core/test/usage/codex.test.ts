import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexUsageSource, findLatestRollout, lastTokenCountEvent } from '../../src/usage/codex.js';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

describe('lastTokenCountEvent', () => {
  it('returns the last token_count event total from a well-formed rollout', async () => {
    const event = await lastTokenCountEvent(path.join(FIXTURES, 'codex-rollout.jsonl'));
    expect(event?.totalTokens).toBe(42890);
    expect(event?.model).toBe('gpt-5.1-codex');
  });

  it('does not throw and still finds the last valid event when the file ends truncated', async () => {
    const event = await lastTokenCountEvent(path.join(FIXTURES, 'codex-rollout-truncated.jsonl'));
    expect(event?.totalTokens).toBe(42890);
  });

  it('returns null for a nonexistent file', async () => {
    expect(await lastTokenCountEvent('/nope/nope.jsonl')).toBeNull();
  });
});

describe('CodexUsageSource', () => {
  it('computes pct from total tokens / model context size', async () => {
    const source = new CodexUsageSource(path.join(FIXTURES, 'codex-rollout.jsonl'), {
      'gpt-5.1-codex': 100_000,
    });
    const usage = await source.getUsage();
    expect(usage?.tokens).toBe(42890);
    expect(usage?.max).toBe(100_000);
    expect(usage?.pct).toBeCloseTo(0.4289);
    expect(usage?.source).toBe('rollout-jsonl');
  });

  it('returns null when the rollout resolver yields null', async () => {
    const source = new CodexUsageSource(async () => null);
    expect(await source.getUsage()).toBeNull();
  });
});

describe('findLatestRollout', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-rollouts-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('finds a rollout file nested under YYYY/MM/DD', async () => {
    const nested = path.join(dir, '2026', '07', '11');
    await fs.mkdir(nested, { recursive: true });
    const rolloutFile = path.join(nested, 'rollout-2026-07-11T12-00-00-abc.jsonl');
    await fs.writeFile(rolloutFile, '{}');
    expect(await findLatestRollout(dir)).toBe(rolloutFile);
  });

  it('returns null when nothing matches', async () => {
    expect(await findLatestRollout(dir)).toBeNull();
  });
});

describe('lastTokenCountEvent on a huge rollout', () => {
  it('finds the last token-count event in a multi-MB file without slurping the whole thing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-huge-rollout-'));
    try {
      const fillerLine = JSON.stringify({ type: 'turn', payload: { type: 'agent_message', content: 'x'.repeat(500) } });
      const tokenLine = JSON.stringify({
        type: 'turn',
        payload: { type: 'token_count', model: 'gpt-5.1-codex', info: { total_token_usage: { total_tokens: 77_777 } } },
      });
      const lines = Array(5000).fill(fillerLine);
      lines.push(tokenLine);
      const filePath = path.join(dir, 'huge-rollout.jsonl');
      await fs.writeFile(filePath, lines.join('\n') + '\n');

      const result = await lastTokenCountEvent(filePath);
      expect(result?.totalTokens).toBe(77_777);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
