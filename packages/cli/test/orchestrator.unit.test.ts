import { DEFAULT_CONFIG } from '@batonpass/core';
import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import type { PtyProcess } from '../src/pty.js';
import { FakeAdapter } from './fake-adapter.js';

function fakeChild(): { child: PtyProcess; written: string[] } {
  const written: string[] = [];
  const child: PtyProcess = {
    pid: 4242,
    write: (data: string) => written.push(data),
    onData: () => {},
    onExit: () => {},
    kill: () => {},
    resize: () => {},
  };
  return { child, written };
}

describe('Orchestrator input queueing', () => {
  it('forwards input directly to the child while forwardingInput is true', () => {
    const orchestrator = new Orchestrator({
      adapter: new FakeAdapter(),
      cwd: '/tmp/does-not-matter',
      config: DEFAULT_CONFIG,
      spawnPty: () => fakeChild().child,
    });
    const { child, written } = fakeChild();
    // @ts-expect-error -- reaching into private state deliberately for this focused unit test
    orchestrator.child = child;

    orchestrator.feedUserInput('hello');
    expect(written).toEqual(['hello']);
  });

  it('queues input while forwardingInput is false, then flushes it in order once re-enabled', () => {
    const orchestrator = new Orchestrator({
      adapter: new FakeAdapter(),
      cwd: '/tmp/does-not-matter',
      config: DEFAULT_CONFIG,
      spawnPty: () => fakeChild().child,
    });
    const { child, written } = fakeChild();
    // @ts-expect-error -- private access for test
    orchestrator.child = child;
    // @ts-expect-error -- private access for test
    orchestrator.forwardingInput = false;

    orchestrator.feedUserInput('a');
    orchestrator.feedUserInput('b');
    expect(written).toEqual([]); // nothing forwarded yet

    // @ts-expect-error -- private method access for test
    orchestrator.flushQueuedInput();
    expect(written).toEqual(['a', 'b']);

    // subsequent input goes straight through again
    orchestrator.feedUserInput('c');
    expect(written).toEqual(['a', 'b', 'c']);
  });
});
