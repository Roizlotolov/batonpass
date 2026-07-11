import { describe, expect, it } from 'vitest';
import { ConfigSchema, DEFAULT_CONFIG, HandoffJsonSchema, StateJsonSchema } from '../src/schema.js';

describe('HandoffJsonSchema', () => {
  const valid = {
    version: '1' as const,
    seq: 1,
    tool: 'claude-code' as const,
    sessionId: 'sess-1',
    createdAt: new Date().toISOString(),
    cwd: '/tmp/repo',
    gitHead: 'abc123',
    gitDirty: true,
    contextPctAtHandoff: 76,
    previousHandoff: null,
    status: 'pending' as const,
  };

  it('accepts a valid handoff', () => {
    expect(HandoffJsonSchema.parse(valid)).toEqual(valid);
  });

  it('rejects wrong version', () => {
    expect(() => HandoffJsonSchema.parse({ ...valid, version: '2' })).toThrow();
  });

  it('rejects unknown tool', () => {
    expect(() => HandoffJsonSchema.parse({ ...valid, tool: 'cursor' })).toThrow();
  });

  it('rejects negative seq', () => {
    expect(() => HandoffJsonSchema.parse({ ...valid, seq: -1 })).toThrow();
  });
});

describe('StateJsonSchema defaults', () => {
  it('fills in defaults from an empty object', () => {
    const state = StateJsonSchema.parse({});
    expect(state.lastSeq).toBe(0);
    expect(state.orchestratorPid).toBeNull();
    expect(state.pendingHandoff).toBeNull();
  });
});

describe('ConfigSchema defaults', () => {
  it('DEFAULT_CONFIG has expected values', () => {
    expect(DEFAULT_CONFIG.threshold).toBe(0.75);
    expect(DEFAULT_CONFIG.pollIntervalMs).toBe(5000);
    expect(DEFAULT_CONFIG.maxChainedHandoffs).toBe(Infinity);
  });

  it('merges partial overrides', () => {
    const cfg = ConfigSchema.parse({ threshold: 0.5 });
    expect(cfg.threshold).toBe(0.5);
    expect(cfg.pollIntervalMs).toBe(5000);
  });
});
