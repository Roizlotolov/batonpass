import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  HandoffJsonSchema,
  REQUIRED_SECTIONS,
  type HandoffJson,
  type HandoffMd,
  type SectionName,
} from './schema.js';
import { writeFileAtomic } from './state.js';

export class ArtifactValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = 'ArtifactValidationError';
  }
}

/** Render a parsed handoff back into the canonical `handoff.md` markdown text. */
export function renderHandoffMd(md: HandoffMd): string {
  const lines: string[] = [`# Handoff ${md.seq}`, ''];
  for (const section of REQUIRED_SECTIONS) {
    lines.push(`## ${section}`, '', (md.sections[section] ?? '').trim(), '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Parse `handoff.md` text into sections. Tolerant of extra whitespace and
 * extra (non-required) sections, which are preserved but not validated.
 */
export function parseHandoffMd(text: string): HandoffMd {
  const headerMatch = text.match(/^#\s*Handoff\s+(\d+)/m);
  const seq = headerMatch?.[1] ? Number.parseInt(headerMatch[1], 10) : NaN;

  const sectionRe = /^##\s+(.+?)\s*$/gm;
  const matches = [...text.matchAll(sectionRe)];
  const sections: Record<string, string> = {};

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const name = m[1]!.trim();
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    sections[name] = text.slice(start, end).trim();
  }

  return { seq, sections };
}

/** Validate that every required section is present and non-empty. Returns issue strings (empty = valid). */
export function validateHandoffMd(md: HandoffMd): string[] {
  const issues: string[] = [];
  if (Number.isNaN(md.seq)) {
    issues.push('Missing or malformed "# Handoff <seq>" header.');
  }
  for (const section of REQUIRED_SECTIONS) {
    const body = md.sections[section];
    if (body === undefined) {
      issues.push(`Missing required section: "## ${section}"`);
    } else if (body.trim().length === 0) {
      issues.push(`Section "## ${section}" is empty.`);
    }
  }
  return issues;
}

export function sectionText(md: HandoffMd, name: SectionName): string {
  return md.sections[name] ?? '';
}

export interface HandoffDirPaths {
  dir: string;
  mdPath: string;
  jsonPath: string;
}

export function handoffDirName(seq: number, createdAt: string): string {
  const ts = createdAt.replace(/[:.]/g, '-');
  return `${seq}-${ts}`;
}

/**
 * A handoff directory name must be a single path segment matching our own
 * `handoffDirName` output — no `/`, no `..`, no absolute paths. Defense in depth
 * against a malformed/tampered `state.json.pendingHandoff` value being used to
 * construct a filesystem path (hook scripts read this value from disk).
 */
export function isSafeHandoffDirName(name: string): boolean {
  return /^\d+-[A-Za-z0-9_-]+$/.test(name);
}

export function handoffPaths(handoffsRoot: string, seq: number, createdAt: string): HandoffDirPaths {
  const dir = path.join(handoffsRoot, handoffDirName(seq, createdAt));
  return { dir, mdPath: path.join(dir, 'handoff.md'), jsonPath: path.join(dir, 'handoff.json') };
}

/** Write a validated handoff (md + json) atomically. Throws ArtifactValidationError on invalid content. */
export async function writeHandoff(
  handoffsRoot: string,
  meta: HandoffJson,
  md: HandoffMd,
): Promise<HandoffDirPaths> {
  const jsonIssues: string[] = [];
  const jsonResult = HandoffJsonSchema.safeParse(meta);
  if (!jsonResult.success) {
    jsonIssues.push(...jsonResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const mdIssues = validateHandoffMd(md);
  const issues = [...jsonIssues, ...mdIssues];
  if (issues.length > 0) {
    throw new ArtifactValidationError('Handoff artifact failed validation', issues);
  }

  const paths = handoffPaths(handoffsRoot, meta.seq, meta.createdAt);
  await fs.mkdir(paths.dir, { recursive: true });
  await writeFileAtomic(paths.mdPath, renderHandoffMd(md));
  await writeFileAtomic(paths.jsonPath, JSON.stringify(meta, null, 2) + '\n');
  return paths;
}

/** Read + validate an existing handoff directory. Throws ArtifactValidationError on invalid/missing content. */
export async function readHandoff(
  dir: string,
): Promise<{ meta: HandoffJson; md: HandoffMd; mdText: string }> {
  const mdPath = path.join(dir, 'handoff.md');
  const jsonPath = path.join(dir, 'handoff.json');

  const [mdText, jsonText] = await Promise.all([
    fs.readFile(mdPath, 'utf8').catch(() => {
      throw new ArtifactValidationError('Cannot read handoff.md', [`missing file: ${mdPath}`]);
    }),
    fs.readFile(jsonPath, 'utf8').catch(() => {
      throw new ArtifactValidationError('Cannot read handoff.json', [`missing file: ${jsonPath}`]);
    }),
  ]);

  const md = parseHandoffMd(mdText);
  const mdIssues = validateHandoffMd(md);

  let meta: HandoffJson;
  try {
    meta = HandoffJsonSchema.parse(JSON.parse(jsonText));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ArtifactValidationError('handoff.json failed validation', [message, ...mdIssues]);
  }

  if (mdIssues.length > 0) {
    throw new ArtifactValidationError('handoff.md failed validation', mdIssues);
  }

  return { meta, md, mdText };
}

/** List handoff directories under a handoffs root, sorted by seq ascending. */
export async function listHandoffs(handoffsRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(handoffsRoot);
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^\d+-/.test(e))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((e) => path.join(handoffsRoot, e));
}
