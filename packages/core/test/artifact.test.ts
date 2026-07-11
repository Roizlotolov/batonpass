import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactValidationError,
  isSafeHandoffDirName,
  listHandoffs,
  parseHandoffMd,
  readHandoff,
  renderHandoffMd,
  validateHandoffMd,
  writeHandoff,
} from '../src/artifact.js';
import type { HandoffJson, HandoffMd } from '../src/schema.js';

const FIXTURES = path.join(__dirname, 'fixtures');

function makeMeta(overrides: Partial<HandoffJson> = {}): HandoffJson {
  return {
    version: '1',
    seq: 1,
    tool: 'claude-code',
    sessionId: 'sess-1',
    createdAt: '2026-07-11T12:00:00.000Z',
    cwd: '/tmp/repo',
    gitHead: 'abc123',
    gitDirty: false,
    contextPctAtHandoff: 76,
    previousHandoff: null,
    status: 'pending',
    ...overrides,
  };
}

function makeMd(overrides: Partial<HandoffMd['sections']> = {}): HandoffMd {
  return {
    seq: 1,
    sections: {
      Objective: 'Ship it.',
      'Current state': 'Done: X.',
      'Next steps': '1. Do Y',
      'Key decisions': 'Chose A.',
      'Files touched': 'a.ts -> added',
      'Gotchas & constraints': 'Watch W.',
      Verification: 'pnpm test',
      'Do NOT': 'Do not touch Z.',
      ...overrides,
    },
  };
}

describe('parseHandoffMd / validateHandoffMd', () => {
  it('parses a valid fixture with no issues', async () => {
    const text = await fs.readFile(path.join(FIXTURES, 'valid-handoff.md'), 'utf8');
    const md = parseHandoffMd(text);
    expect(md.seq).toBe(1);
    expect(validateHandoffMd(md)).toEqual([]);
  });

  it('flags a missing section and an empty section in the invalid fixture', async () => {
    const text = await fs.readFile(path.join(FIXTURES, 'invalid-handoff.md'), 'utf8');
    const md = parseHandoffMd(text);
    const issues = validateHandoffMd(md);
    expect(issues.some((i) => i.includes('Do NOT'))).toBe(true);
    expect(issues.some((i) => i.includes('Gotchas & constraints') && i.includes('empty'))).toBe(true);
  });
});

describe('renderHandoffMd', () => {
  it('round-trips through parseHandoffMd', () => {
    const md = makeMd();
    const rendered = renderHandoffMd(md);
    const reparsed = parseHandoffMd(rendered);
    expect(reparsed.seq).toBe(md.seq);
    for (const [k, v] of Object.entries(md.sections)) {
      expect(reparsed.sections[k]).toBe(v);
    }
    expect(validateHandoffMd(reparsed)).toEqual([]);
  });
});

describe('writeHandoff / readHandoff', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-artifact-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes and reads back a valid handoff', async () => {
    const meta = makeMeta();
    const md = makeMd();
    const paths = await writeHandoff(dir, meta, md);
    expect(await fs.stat(paths.mdPath)).toBeTruthy();
    expect(await fs.stat(paths.jsonPath)).toBeTruthy();

    const read = await readHandoff(paths.dir);
    expect(read.meta).toEqual(meta);
    expect(validateHandoffMd(read.md)).toEqual([]);
  });

  it('throws ArtifactValidationError for invalid metadata', async () => {
    const meta = makeMeta({ seq: -1 });
    await expect(writeHandoff(dir, meta, makeMd())).rejects.toThrow(ArtifactValidationError);
  });

  it('throws ArtifactValidationError for missing markdown sections', async () => {
    const md = makeMd();
    delete (md.sections as Record<string, string>)['Do NOT'];
    await expect(writeHandoff(dir, makeMeta(), md)).rejects.toThrow(ArtifactValidationError);
  });

  it('readHandoff throws on a directory with no files', async () => {
    const emptyDir = path.join(dir, 'empty');
    await fs.mkdir(emptyDir);
    await expect(readHandoff(emptyDir)).rejects.toThrow(ArtifactValidationError);
  });

  it('listHandoffs returns handoff dirs sorted by seq ascending', async () => {
    await writeHandoff(dir, makeMeta({ seq: 2, createdAt: '2026-07-11T12:02:00.000Z' }), makeMd());
    await writeHandoff(dir, makeMeta({ seq: 1, createdAt: '2026-07-11T12:01:00.000Z' }), makeMd());
    await writeHandoff(dir, makeMeta({ seq: 10, createdAt: '2026-07-11T12:03:00.000Z' }), makeMd());
    const list = await listHandoffs(dir);
    expect(list.map((p) => path.basename(p))).toEqual([
      '1-2026-07-11T12-01-00-000Z',
      '2-2026-07-11T12-02-00-000Z',
      '10-2026-07-11T12-03-00-000Z',
    ]);
  });

  it('listHandoffs returns [] for a nonexistent root', async () => {
    expect(await listHandoffs(path.join(dir, 'does-not-exist'))).toEqual([]);
  });
});

describe('isSafeHandoffDirName', () => {
  it('accepts a well-formed <seq>-<timestamp> name', () => {
    expect(isSafeHandoffDirName('1-2026-07-11T12-00-00-000Z')).toBe(true);
    expect(isSafeHandoffDirName('42-x')).toBe(true);
  });

  it('rejects path traversal and absolute-path attempts', () => {
    expect(isSafeHandoffDirName('../../etc/passwd')).toBe(false);
    expect(isSafeHandoffDirName('1-x/../../y')).toBe(false);
    expect(isSafeHandoffDirName('/etc/passwd')).toBe(false);
    expect(isSafeHandoffDirName('1-x/y')).toBe(false);
  });

  it('rejects names that do not start with a numeric seq', () => {
    expect(isSafeHandoffDirName('ghost')).toBe(false);
    expect(isSafeHandoffDirName('')).toBe(false);
  });
});
