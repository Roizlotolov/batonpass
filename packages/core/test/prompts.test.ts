import { describe, expect, it } from 'vitest';
import { REQUIRED_SECTIONS } from '../src/schema.js';
import {
  HANDOFF_WRITTEN_SENTINEL,
  correctivePrompt,
  handoffPrompt,
  resumePrompt,
  resumePromptPtyType,
} from '../src/prompts.js';

describe('handoffPrompt', () => {
  it('includes every required section header and the sentinel', () => {
    const prompt = handoffPrompt('/tmp/repo/.batonpass/handoffs/1-x/handoff.md');
    for (const section of REQUIRED_SECTIONS) {
      expect(prompt).toContain(`## ${section}`);
    }
    expect(prompt).toContain(HANDOFF_WRITTEN_SENTINEL);
    expect(prompt).toContain('/tmp/repo/.batonpass/handoffs/1-x/handoff.md');
  });

  // Regression guard: these prompts are typed into a real agent TUI followed by a
  // submit (`\r`). An embedded newline makes the TUI treat the content as a
  // multi-line edit and never submit, stalling the whole handoff cycle (found via
  // real-CLI testing against Claude Code). Keep every TYPED prompt single-line.
  it('is a single line (typed into the PTY — no embedded newline)', () => {
    expect(handoffPrompt('/tmp/repo/.batonpass/handoffs/1-x/handoff.md')).not.toContain('\n');
  });
});

describe('typed prompts are single-line', () => {
  it('correctivePrompt has no newline', () => {
    expect(correctivePrompt('/tmp/h.md', ['a', 'b'])).not.toContain('\n');
  });
  it('resumePromptPtyType has no newline', () => {
    expect(resumePromptPtyType('.batonpass/handoffs/1-x/handoff.md')).not.toContain('\n');
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
