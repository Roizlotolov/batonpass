// Minimal, dependency-free text-level handling of the one TOML fact Batonpass cares
// about: `[features]\ncodex_hooks = true`. Deliberately not a full TOML parser —
// we only ever need to read/set one boolean key in one well-known table, and a
// real parser would be a heavyweight, still-imperfect round-trip risk for a file
// we don't otherwise touch.

const FEATURES_HEADER_RE = /^\s*\[features\]\s*$/;
const ANY_HEADER_RE = /^\s*\[.+\]\s*$/;
const CODEX_HOOKS_LINE_RE = /^\s*codex_hooks\s*=\s*(true|false)\s*(#.*)?$/;

export function isCodexHooksEnabled(tomlText: string): boolean {
  const lines = tomlText.split('\n');
  let inFeatures = false;
  for (const line of lines) {
    if (FEATURES_HEADER_RE.test(line)) {
      inFeatures = true;
      continue;
    }
    if (inFeatures && ANY_HEADER_RE.test(line)) break; // left the [features] table
    if (inFeatures) {
      const m = line.match(CODEX_HOOKS_LINE_RE);
      if (m) return m[1] === 'true';
    }
  }
  return false;
}

/** Returns updated TOML text with `codex_hooks = true` set inside `[features]` (creating the table if absent). */
export function enableCodexHooks(tomlText: string): string {
  if (isCodexHooksEnabled(tomlText)) return tomlText;

  const lines = tomlText.length > 0 ? tomlText.split('\n') : [];
  let featuresStart = -1;
  let featuresEnd = -1; // exclusive
  for (let i = 0; i < lines.length; i++) {
    if (FEATURES_HEADER_RE.test(lines[i]!)) {
      featuresStart = i;
      featuresEnd = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (ANY_HEADER_RE.test(lines[j]!)) {
          featuresEnd = j;
          break;
        }
      }
      break;
    }
  }

  if (featuresStart === -1) {
    // No [features] table at all — append one.
    const prefix = lines.length > 0 && lines[lines.length - 1] !== '' ? '\n' : '';
    return `${tomlText}${prefix}\n[features]\ncodex_hooks = true\n`;
  }

  // [features] exists; does it already have a (false) codex_hooks line to replace?
  let replaced = false;
  const next = [...lines];
  for (let i = featuresStart + 1; i < featuresEnd; i++) {
    if (CODEX_HOOKS_LINE_RE.test(next[i]!)) {
      next[i] = 'codex_hooks = true';
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    next.splice(featuresEnd, 0, 'codex_hooks = true');
  }
  return next.join('\n');
}
