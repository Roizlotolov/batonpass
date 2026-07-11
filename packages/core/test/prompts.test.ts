import { describe, expect, it } from 'vitest';
import { REQUIRED_SECTIONS } from '../src/schema.js';
import { HANDOFF_WRITTEN_SENTINEL, correctivePrompt, handoffPrompt, resumePrompt } from '../src/prompts.js';

describe('handoffPrompt', () => {
  it('includes every required section header and the sentinel', () => {
    const prompt = handoffPrompt('/tmp/repo/.batonpass/handoffs/1-x/handoff.md');
    for (const section of REQUIRED_SECTIONS) {
      expect(prompt).toContain(`## ${section}`);
    }
    expect(prompt).toContain(HANDOFF_WRITTEN_SENTINEL);
    expect(prompt).toContain('/tmp/repo/.batonpass/handoffs/1-x/handoff.md');
  });
});

describe('resumePrompt', () => {
  it('embeds the handoff content verbatim', () => {
    const content = '# Handoff 1\n\n## Objective\n\nDo the thing.';
    const prompt = resumePrompt(content);
    expect(prompt).toContain(content);
    expect(prompt).toContain('Next steps');
  });
});

describe('correctivePrompt', () => {
  it('lists issues and repeats the sentinel', () => {
    const prompt = correctivePrompt('/tmp/h.md', ['Missing section X', 'Empty section Y']);
    expect(prompt).toContain('Missing section X');
    expect(prompt).toContain('Empty section Y');
    expect(prompt).toContain(HANDOFF_WRITTEN_SENTINEL);
  });
});
