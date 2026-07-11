import { describe, expect, it } from 'vitest';
import { enableCodexHooks, isCodexHooksEnabled } from '../src/configtoml.js';

describe('isCodexHooksEnabled', () => {
  it('is false for an empty file', () => {
    expect(isCodexHooksEnabled('')).toBe(false);
  });

  it('is false when [features] exists without codex_hooks', () => {
    expect(isCodexHooksEnabled('[features]\nother_flag = true\n')).toBe(false);
  });

  it('is true when codex_hooks = true is inside [features]', () => {
    expect(isCodexHooksEnabled('[features]\ncodex_hooks = true\n')).toBe(true);
  });

  it('is false when codex_hooks = false', () => {
    expect(isCodexHooksEnabled('[features]\ncodex_hooks = false\n')).toBe(false);
  });

  it('ignores a codex_hooks-looking line outside [features]', () => {
    const toml = '[other]\ncodex_hooks = true\n\n[features]\nsomething_else = true\n';
    expect(isCodexHooksEnabled(toml)).toBe(false);
  });

  it('handles a trailing comment on the line', () => {
    expect(isCodexHooksEnabled('[features]\ncodex_hooks = true # enabled by batonpass\n')).toBe(true);
  });
});

describe('enableCodexHooks', () => {
  it('appends a new [features] table to an empty file', () => {
    const result = enableCodexHooks('');
    expect(isCodexHooksEnabled(result)).toBe(true);
  });

  it('appends [features] after existing unrelated content', () => {
    const result = enableCodexHooks('[model]\nname = "gpt-5"\n');
    expect(result).toContain('[model]');
    expect(result).toContain('name = "gpt-5"');
    expect(isCodexHooksEnabled(result)).toBe(true);
  });

  it('adds codex_hooks = true inside an existing [features] table without one', () => {
    const result = enableCodexHooks('[features]\nother_flag = true\n');
    expect(result).toContain('other_flag = true');
    expect(isCodexHooksEnabled(result)).toBe(true);
  });

  it('flips an existing codex_hooks = false to true in place', () => {
    const result = enableCodexHooks('[features]\ncodex_hooks = false\nother_flag = true\n');
    expect(isCodexHooksEnabled(result)).toBe(true);
    expect(result).toContain('other_flag = true');
    expect(result.match(/codex_hooks/g)).toHaveLength(1); // no duplicate line
  });

  it('is a no-op when already enabled', () => {
    const toml = '[features]\ncodex_hooks = true\n';
    expect(enableCodexHooks(toml)).toBe(toml);
  });

  it('preserves a later table that comes after [features]', () => {
    const toml = '[features]\nfoo = true\n\n[model]\nname = "x"\n';
    const result = enableCodexHooks(toml);
    expect(isCodexHooksEnabled(result)).toBe(true);
    expect(result.indexOf('[model]')).toBeGreaterThan(result.indexOf('codex_hooks'));
    expect(result).toContain('name = "x"');
  });
});
