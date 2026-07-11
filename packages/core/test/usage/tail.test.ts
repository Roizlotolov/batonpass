import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTailUntil } from '../../src/usage/tail.js';

describe('readTailUntil', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-tail-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null for a nonexistent file', async () => {
    expect(await readTailUntil(path.join(dir, 'nope'), () => true)).toBeNull();
  });

  it('returns "" for an empty file without ever calling isUsable', async () => {
    const filePath = path.join(dir, 'empty.txt');
    await fs.writeFile(filePath, '');
    let called = false;
    const text = await readTailUntil(filePath, () => {
      called = true;
      return true;
    });
    expect(text).toBe('');
    expect(called).toBe(false);
  });

  it('finds content within the initial window without growing it', async () => {
    const filePath = path.join(dir, 'small.txt');
    await fs.writeFile(filePath, 'needle');
    let calls = 0;
    const text = await readTailUntil(
      filePath,
      (t) => {
        calls += 1;
        return t.includes('needle');
      },
      1024,
    );
    expect(text).toContain('needle');
    expect(calls).toBe(1);
  });

  it('grows the window when the initial one does not satisfy isUsable, and finds it once big enough', async () => {
    // Build a file where the needle is further back than a small initial window.
    const filler = 'x'.repeat(500) + '\n';
    const content = filler.repeat(20) + 'NEEDLE\n' + filler.repeat(5);
    const filePath = path.join(dir, 'grows.txt');
    await fs.writeFile(filePath, content);

    const windowSizes: number[] = [];
    const text = await readTailUntil(
      filePath,
      (t) => {
        windowSizes.push(t.length);
        return t.includes('NEEDLE');
      },
      200, // deliberately smaller than the gap between NEEDLE and EOF
    );

    expect(text).toContain('NEEDLE');
    expect(windowSizes.length).toBeGreaterThan(1); // had to grow at least once
    expect(windowSizes[0]).toBeLessThan(windowSizes[windowSizes.length - 1]!);
  });

  it('gives up and returns the full available window once the file itself is exhausted', async () => {
    const filePath = path.join(dir, 'never-found.txt');
    await fs.writeFile(filePath, 'no match here\n'.repeat(50));
    const text = await readTailUntil(filePath, (t) => t.includes('IMPOSSIBLE'), 64);
    expect(text).not.toBeNull();
    expect(text).toContain('no match here');
  });

  it('never needs more than the hard cap even on a very large file', async () => {
    // ~2MB file, needle only in the last 100 bytes -> should resolve well under the file size read.
    const bigFiller = 'y'.repeat(1024 * 1024 * 2);
    const filePath = path.join(dir, 'big.txt');
    await fs.writeFile(filePath, bigFiller + '\nNEEDLE_AT_END\n');

    const text = await readTailUntil(filePath, (t) => t.includes('NEEDLE_AT_END'), 1024);
    expect(text).toContain('NEEDLE_AT_END');
    // The returned window should be much smaller than the full ~2MB file (proves we didn't slurp it all).
    expect(text!.length).toBeLessThan(1024 * 1024);
  }, 15_000);
});
