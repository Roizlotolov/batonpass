import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..', 'hooks', 'scripts');

function runHook(scriptName: string, stdin: unknown) {
  const result = spawnSync('node', [path.join(SCRIPTS_DIR, scriptName)], {
    input: JSON.stringify(stdin),
    encoding: 'utf8',
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('session-start.mjs (codex)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-codex-hooktest-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('does nothing when there is no pendingHandoff', () => {
    const { stdout, status } = runHook('session-start.mjs', { cwd, session_id: 's1', source: 'startup' });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('injects additionalContext in the Codex hookSpecificOutput shape and clears pendingHandoff', async () => {
    const handoffDir = path.join(cwd, '.batonpass', 'handoffs', '1-x');
    await fs.mkdir(handoffDir, { recursive: true });
    await fs.writeFile(path.join(handoffDir, 'handoff.md'), '# Handoff 1\n\n## Objective\n\nDo the thing.\n');
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.batonpass', 'state.json'), JSON.stringify({ pendingHandoff: '1-x' }));

    const { stdout, status } = runHook('session-start.mjs', { cwd, session_id: 's2', source: 'resume' });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Do the thing.');

    const state = JSON.parse(await fs.readFile(path.join(cwd, '.batonpass', 'state.json'), 'utf8'));
    expect(state.pendingHandoff).toBeNull();
  });
});

describe('stop.mjs (codex)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-codex-hooktest-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('writes a turn-idle marker and produces NO stdout (must not trigger decision:block)', async () => {
    const { stdout, status } = runHook('stop.mjs', { cwd, session_id: 's1', turn_id: 't1', stop_hook_active: false });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(''); // silence is required — any JSON here risks Codex's continuation mechanism
    const marker = JSON.parse(await fs.readFile(path.join(cwd, '.batonpass', 'turn-idle'), 'utf8'));
    expect(marker.sessionId).toBe('s1');
    expect(marker.turnId).toBe('t1');
  });
});

describe('session-start.mjs security (codex): unsafe pendingHandoff values', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-codex-hooktest-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('refuses a path-traversal pendingHandoff value', async () => {
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.batonpass', 'state.json'), JSON.stringify({ pendingHandoff: '../../etc/passwd' }));

    const { stdout, status, stderr } = runHook('session-start.mjs', { cwd, session_id: 's1' });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
    expect(stderr).toContain('unsafe pendingHandoff');
  });
});
