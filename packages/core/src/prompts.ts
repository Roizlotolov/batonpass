import { REQUIRED_SECTIONS } from './schema.js';

export const HANDOFF_WRITTEN_SENTINEL = 'HANDOFF_WRITTEN';

/** Section headers as an inline, comma-separated list (no newlines — see `handoffPrompt`). */
const SECTION_LIST = REQUIRED_SECTIONS.map((s) => `"## ${s}"`).join(', ');

/**
 * Prompt injected (typed into the PTY) into the dying session once context/threshold is
 * hit and the turn is idle. Asks the agent to write its own handoff artifact.
 *
 * MUST be a single line with no embedded newlines. It is typed into the agent CLI's TUI
 * followed by a submit (`\r`); a real TUI (e.g. Claude Code) treats embedded newlines as
 * newlines *within* the input box rather than submits, so a multi-line prompt would sit
 * there unsubmitted and the handoff cycle would stall. The per-section guidance is folded
 * into one line with `;` separators; the agent still writes the FILE with real line breaks.
 */
export function handoffPrompt(artifactPath: string): string {
  return (
    `Context is nearly full and this session is about to be replaced by a fresh one with ZERO memory of this conversation. ` +
    `Stop what you are doing at a safe point, then write a handoff document to exactly this path: ${artifactPath} — ` +
    `a markdown file whose first line is "# Handoff <seq>" and which then uses these level-2 headers verbatim and in this exact order: ${SECTION_LIST}. ` +
    `Section guidance: Objective = the overall task in one paragraph (copy from the previous handoff unless it changed); ` +
    `Current state = what is DONE and verified vs. still in-progress, concrete, no vague summaries; ` +
    `Next steps = an ordered list whose item 1 is the exact next action including file paths; ` +
    `Key decisions = decisions made and WHY, so the next session does not relitigate them; ` +
    `Files touched = one "path -> one-line role/change" per file; ` +
    `Gotchas & constraints = traps you found, things that look wrong but are intentional, environment quirks; ` +
    `Verification = exact commands to confirm the current state (tests, build, lint); ` +
    `Do NOT = explicit anti-instructions for the next session. ` +
    `Be specific and exhaustive — the next session can only see this document. ` +
    `When you have finished writing the file, reply with only the single word: ${HANDOFF_WRITTEN_SENTINEL}`
  );
}

/**
 * Prompt injected into the fresh session via the SessionStart hook, carrying the
 * full content of the previous handoff.
 */
export function resumePrompt(handoffMdContent: string, handoffsDirDisplayPath = '.batonpass/handoffs/'): string {
  return [
    'You are continuing prior work via an automatic handoff from a previous session. Read it fully before doing anything else.',
    '',
    'After reading: run the commands listed under "Verification" to confirm the current state matches the document, then begin at item 1 of "Next steps".',
    `Full handoff history is available at: ${handoffsDirDisplayPath}`,
    '',
    '--- BEGIN HANDOFF ---',
    handoffMdContent.trim(),
    '--- END HANDOFF ---',
  ].join('\n');
}

/**
 * Single-line resume instruction typed directly into a fresh session's PTY by the
 * orchestrator, for adapters whose CLI has no context-injection hook (`resumeInjection()
 * === 'pty-type'`). Deliberately one line — typing multi-line content into a PTY can
 * submit prematurely on the first newline. The artifact stays on disk; the agent reads
 * it with its own file tools.
 */
export function resumePromptPtyType(handoffRelPath: string): string {
  return `Resuming from a previous session. Read ${handoffRelPath} in full before doing anything else and continue from its Next steps; honor its Do NOT section.`;
}

/**
 * Corrective prompt used for the single retry when a written artifact fails validation.
 * Like `handoffPrompt`, this is typed into the PTY, so it MUST be a single line with no
 * embedded newlines (issues are joined with `;`).
 */
export function correctivePrompt(artifactPath: string, issues: string[]): string {
  return (
    `The handoff document at ${artifactPath} is invalid and cannot be used: ${issues.join('; ')}. ` +
    `Please fix it in place (same path, same section headers) and reply again with only: ${HANDOFF_WRITTEN_SENTINEL}`
  );
}
