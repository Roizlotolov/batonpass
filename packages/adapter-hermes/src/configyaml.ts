// Minimal, dependency-free text-level handling of the one Hermes config.yaml
// fact Batonpass cares about: `compression.threshold`. Deliberately not a real
// YAML parser — a round-trip through a full YAML library risks reformatting a
// file we don't otherwise touch (comments, quoting style, key order). Mirrors
// adapter-codex/src/configtoml.ts's philosophy for a nested (indentation-based)
// format instead of TOML's `[section]` headers.
//
// Batonpass never hand-edits `plugins.enabled` (see index.ts's install()) — that
// list is written by shelling out to `hermes plugins enable batonpass`, which is
// the sanctioned path (§2.2 re-verification: no `plugin_config`/`get_config()`
// mechanism exists, and blindly guessing the writer's exact format was
// explicitly flagged as risky). Reading it back here (`isPluginEnabledInConfig`)
// is read-only and only used for `isInstalled`/`doctor` diagnostics.

const BATONPASS_MARKER_RE = /#\s*batonpass: raised threshold to [0-9.]+ \(was (absent|[0-9.]+)\) — see docs\/adapters\.md/;
const THRESHOLD_LINE_RE = /^(\s+)threshold:\s*([0-9]*\.?[0-9]+)\s*(#.*)?$/;

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/** Finds a top-level (column-0) `key:` line and the exclusive end of its indented block. */
function findTopLevelBlock(lines: string[], key: string): { start: number; end: number } | null {
  const headerRe = new RegExp(`^${key}:\\s*(#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i]!)) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (isBlankOrComment(line)) continue;
        if (/^\S/.test(line)) {
          end = j;
          break;
        }
      }
      return { start: i, end };
    }
  }
  return null;
}

function findNestedKeyLine(lines: string[], block: { start: number; end: number }, key: string): number | null {
  const re = new RegExp(`^\\s+${key}:\\s*(\\[.*\\])?\\s*(#.*)?$`);
  for (let i = block.start + 1; i < block.end; i++) {
    if (re.test(lines[i]!)) return i;
  }
  return null;
}

/** Reads a YAML block-sequence (`- item` lines, or an inline `[a, b]`) starting right after `afterLineIdx`. */
function readSequenceItems(lines: string[], afterLineIdx: number, blockEnd: number): string[] {
  const inlineMatch = lines[afterLineIdx]!.match(/\[(.*)\]/);
  if (inlineMatch) {
    return inlineMatch[1]!
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }
  const items: string[] = [];
  for (let i = afterLineIdx + 1; i < blockEnd; i++) {
    const line = lines[i]!;
    if (isBlankOrComment(line)) continue;
    const m = line.match(/^\s*-\s*(.+?)\s*(#.*)?$/);
    if (!m) break;
    items.push(m[1]!.replace(/^["']|["']$/g, ''));
  }
  return items;
}

/** Read-only: is `pluginName` present in `plugins.enabled`? Used only for diagnostics — never written by this module. */
export function isPluginEnabledInConfig(yamlText: string, pluginName: string): boolean {
  const lines = yamlText.split('\n');
  const pluginsBlock = findTopLevelBlock(lines, 'plugins');
  if (!pluginsBlock) return false;
  const enabledLine = findNestedKeyLine(lines, pluginsBlock, 'enabled');
  if (enabledLine === null) return false;
  return readSequenceItems(lines, enabledLine, pluginsBlock.end).includes(pluginName);
}

/** Current effective `compression.threshold`, or `null` if the key isn't present (Hermes' own default is 0.50). */
export function getCompressionThreshold(yamlText: string): number | null {
  const lines = yamlText.split('\n');
  const block = findTopLevelBlock(lines, 'compression');
  if (!block) return null;
  for (let i = block.start + 1; i < block.end; i++) {
    const m = lines[i]!.match(THRESHOLD_LINE_RE);
    if (m) return Number.parseFloat(m[2]!);
  }
  return null;
}

export function isBatonpassThresholdOverrideApplied(yamlText: string): boolean {
  return BATONPASS_MARKER_RE.test(yamlText);
}

/**
 * Ensures `compression.threshold >= target` (default 0.90), tagging the line with a
 * marker comment recording the prior value so `revertCompressionThresholdOverride` can
 * undo it later — but only if nothing else has touched the line since. No-op (returns
 * the input unchanged) when the current threshold is already `>= target`.
 */
export function enableCompressionThresholdOverride(yamlText: string, target = 0.9): string {
  const lines = yamlText.length > 0 ? yamlText.split('\n') : [];
  const block = findTopLevelBlock(lines, 'compression');

  if (!block) {
    const prefix = lines.length > 0 && lines[lines.length - 1] !== '' ? '\n' : '';
    return `${yamlText}${prefix}\ncompression:\n  threshold: ${target}  # batonpass: raised threshold to ${target} (was absent) — see docs/adapters.md\n`;
  }

  let thresholdLineIdx = -1;
  let currentValue: number | null = null;
  let indent = '  ';
  for (let i = block.start + 1; i < block.end; i++) {
    const m = lines[i]!.match(THRESHOLD_LINE_RE);
    if (m) {
      thresholdLineIdx = i;
      indent = m[1]!;
      currentValue = Number.parseFloat(m[2]!);
      break;
    }
  }

  if (currentValue !== null && currentValue >= target) return yamlText;

  const next = [...lines];
  if (thresholdLineIdx === -1) {
    let childIndent = '  ';
    for (let i = block.start + 1; i < block.end; i++) {
      const m = lines[i]!.match(/^(\s+)\S/);
      if (m) {
        childIndent = m[1]!;
        break;
      }
    }
    next.splice(
      block.start + 1,
      0,
      `${childIndent}threshold: ${target}  # batonpass: raised threshold to ${target} (was absent) — see docs/adapters.md`,
    );
  } else {
    next[thresholdLineIdx] =
      `${indent}threshold: ${target}  # batonpass: raised threshold to ${target} (was ${currentValue}) — see docs/adapters.md`;
  }
  return next.join('\n');
}

/**
 * Reverts a threshold edit made by `enableCompressionThresholdOverride`, but only if
 * the line still carries batonpass's own marker comment — if the user (or another
 * tool) has since edited it, this is a no-op, per PLAN.md §9's "never destructively
 * edit user config" doctrine.
 */
export function revertCompressionThresholdOverride(yamlText: string): string {
  const lines = yamlText.split('\n');
  const block = findTopLevelBlock(lines, 'compression');
  if (!block) return yamlText;

  for (let i = block.start + 1; i < block.end; i++) {
    const m = lines[i]!.match(THRESHOLD_LINE_RE);
    if (!m) continue;
    const markerMatch = lines[i]!.match(BATONPASS_MARKER_RE);
    if (!markerMatch) return yamlText; // not ours (or already reverted) — leave alone
    const was = markerMatch[1]!;
    const next = [...lines];
    if (was === 'absent') {
      next.splice(i, 1);
    } else {
      next[i] = `${m[1]}threshold: ${was}`;
    }
    return next.join('\n');
  }
  return yamlText;
}
