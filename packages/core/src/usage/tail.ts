import { promises as fs } from 'node:fs';

const DEFAULT_TAIL_BYTES = 256 * 1024; // 256 KiB — comfortably covers many turns of usage lines
const MAX_TAIL_BYTES = 8 * 1024 * 1024; // 8 MiB hard cap before giving up

/**
 * Reads only the last `tailBytes` of a (potentially huge, potentially still being
 * written) file, doubling the window up to `MAX_TAIL_BYTES` if the caller-supplied
 * `isUsable` predicate can't find what it needs in the initial window. Never reads
 * more of the file than necessary — long-running sessions can produce multi-GB
 * transcripts/rollouts, and slurping the whole file on every poll would be both
 * slow and memory-hungry.
 */
export async function readTailUntil(
  filePath: string,
  isUsable: (text: string) => boolean,
  startBytes = DEFAULT_TAIL_BYTES,
): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return null;
  }

  try {
    const stat = await handle.stat();
    let window = Math.min(startBytes, stat.size) || stat.size;
    if (stat.size === 0) return '';

    for (;;) {
      const length = Math.min(window, stat.size);
      const position = stat.size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      const text = buffer.toString('utf8');

      if (isUsable(text) || length >= stat.size || window >= MAX_TAIL_BYTES) {
        return text;
      }
      window = Math.min(window * 2, MAX_TAIL_BYTES);
    }
  } finally {
    await handle.close();
  }
}
