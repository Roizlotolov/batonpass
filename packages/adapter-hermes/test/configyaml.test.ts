import { describe, expect, it } from 'vitest';
import {
  enableCompressionThresholdOverride,
  getCompressionThreshold,
  isBatonpassThresholdOverrideApplied,
  isPluginEnabledInConfig,
  revertCompressionThresholdOverride,
} from '../src/configyaml.js';

describe('getCompressionThreshold', () => {
  it('returns null when compression: is absent', () => {
    expect(getCompressionThreshold('model:\n  name: foo\n')).toBeNull();
  });

  it('reads an existing threshold', () => {
    expect(getCompressionThreshold('compression:\n  enabled: true\n  threshold: 0.5\n')).toBe(0.5);
  });

  it('returns null when compression: exists but has no threshold key', () => {
    expect(getCompressionThreshold('compression:\n  enabled: true\n')).toBeNull();
  });
});

describe('enableCompressionThresholdOverride', () => {
  it('appends a whole new compression: block when absent', () => {
    const next = enableCompressionThresholdOverride('model:\n  name: foo\n');
    expect(getCompressionThreshold(next)).toBe(0.9);
    expect(next).toContain('name: foo'); // preserved
    expect(isBatonpassThresholdOverrideApplied(next)).toBe(true);
  });

  it('raises an existing lower threshold and tags it with a marker comment', () => {
    const original = 'compression:\n  enabled: true\n  threshold: 0.5\n';
    const next = enableCompressionThresholdOverride(original);
    expect(getCompressionThreshold(next)).toBe(0.9);
    expect(next).toContain('enabled: true'); // preserved
    expect(next).toContain('(was 0.5)');
  });

  it('is a no-op when the threshold is already >= target', () => {
    const original = 'compression:\n  threshold: 0.95\n';
    expect(enableCompressionThresholdOverride(original)).toBe(original);
  });

  it('inserts a threshold key when compression: exists but has none', () => {
    const original = 'compression:\n  enabled: true\n';
    const next = enableCompressionThresholdOverride(original);
    expect(getCompressionThreshold(next)).toBe(0.9);
    expect(next).toContain('enabled: true');
    expect(next).toContain('(was absent)');
  });

  it('preserves unrelated top-level keys and comments elsewhere in the file', () => {
    const original = '# a comment\nmodel:\n  name: foo\ncompression:\n  threshold: 0.5\nagent:\n  max_turns: 90\n';
    const next = enableCompressionThresholdOverride(original);
    expect(next).toContain('# a comment');
    expect(next).toContain('name: foo');
    expect(next).toContain('max_turns: 90');
  });
});

describe('revertCompressionThresholdOverride', () => {
  it('restores the prior numeric value and drops the marker', () => {
    const original = 'compression:\n  threshold: 0.5\n';
    const overridden = enableCompressionThresholdOverride(original);
    const reverted = revertCompressionThresholdOverride(overridden);
    expect(getCompressionThreshold(reverted)).toBe(0.5);
    expect(isBatonpassThresholdOverrideApplied(reverted)).toBe(false);
  });

  it('removes the whole line when the prior state was "absent"', () => {
    const original = 'compression:\n  enabled: true\n';
    const overridden = enableCompressionThresholdOverride(original);
    const reverted = revertCompressionThresholdOverride(overridden);
    expect(getCompressionThreshold(reverted)).toBeNull();
    expect(reverted).toContain('enabled: true');
  });

  it('is a no-op if the marker comment is missing (user touched the line since)', () => {
    const userEdited = 'compression:\n  threshold: 0.6\n'; // no batonpass marker
    expect(revertCompressionThresholdOverride(userEdited)).toBe(userEdited);
  });

  it('is a no-op when compression: is absent entirely', () => {
    const text = 'model:\n  name: foo\n';
    expect(revertCompressionThresholdOverride(text)).toBe(text);
  });
});

describe('isPluginEnabledInConfig', () => {
  it('returns false when plugins: is absent', () => {
    expect(isPluginEnabledInConfig('model:\n  name: foo\n', 'batonpass')).toBe(false);
  });

  it('reads a block-sequence enabled list (PyYAML default block style)', () => {
    const text = 'plugins:\n  enabled:\n  - other-plugin\n  - batonpass\n';
    expect(isPluginEnabledInConfig(text, 'batonpass')).toBe(true);
    expect(isPluginEnabledInConfig(text, 'not-there')).toBe(false);
  });

  it('reads an inline flow-style enabled list', () => {
    const text = 'plugins:\n  enabled: [other-plugin, batonpass]\n';
    expect(isPluginEnabledInConfig(text, 'batonpass')).toBe(true);
  });

  it('returns false when the plugin is not in the enabled list', () => {
    const text = 'plugins:\n  enabled:\n  - other-plugin\n';
    expect(isPluginEnabledInConfig(text, 'batonpass')).toBe(false);
  });
});
