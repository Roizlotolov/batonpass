#!/usr/bin/env node
// SessionStart hook: if the orchestrator left a pendingHandoff marker in
// .batonpass/state.json, read that handoff.md and inject it as additionalContext
// so the fresh session resumes where the last one left off. No-op otherwise
// (never breaks vanilla `claude` usage when Batonpass isn't orchestrating).
import { promises as fs } from 'node:fs';
import { batonpassPaths, isSafeHandoffDirName, readJson, readStdin, writeFileAtomic } from './_lib.mjs';

// Claude Code caps hookSpecificOutput.additionalContext at 10,000 characters.
const MAX_ADDITIONAL_CONTEXT_CHARS = 10_000;

function buildResumePrompt(handoffMdContent, handoffsDirDisplayPath) {
  const lines = [
    'You are continuing prior work via an automatic handoff from a previous session. Read it fully before doing anything else.',
    '',
    'After reading: run the commands listed under "Verification" to confirm the current state matches the document, then begin at item 1 of "Next steps".',
    `Full handoff history is available at: ${handoffsDirDisplayPath}`,
    '',
    '--- BEGIN HANDOFF ---',
    handoffMdContent.trim(),
    '--- END HANDOFF ---',
  ];
  return lines.join('\n');
}

function fitToCap(handoffMdContent, handoffsDirDisplayPath) {
  let prompt = buildResumePrompt(handoffMdContent, handoffsDirDisplayPath);
  if (prompt.length <= MAX_ADDITIONAL_CONTEXT_CHARS) return prompt;

  // Over budget: truncate the handoff body (keep head+tail, note the cut) rather
  // than dropping whole sections blindly.
  const overhead = prompt.length - handoffMdContent.length;
  const budget = Math.max(0, MAX_ADDITIONAL_CONTEXT_CHARS - overhead - 200);
  const head = handoffMdContent.slice(0, Math.floor(budget * 0.7));
  const tail = handoffMdContent.slice(-Math.floor(budget * 0.3));
  const truncated = `${head}\n\n[... truncated to fit Claude Code's 10,000-character additionalContext limit; see full document on disk at the path below ...]\n\n${tail}`;
  prompt = buildResumePrompt(truncated, handoffsDirDisplayPath);
  return prompt.slice(0, MAX_ADDITIONAL_CONTEXT_CHARS);
}

async function main() {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  const paths = batonpassPaths(cwd);

  const state = await readJson(paths.stateJson, null);
  if (!state?.pendingHandoff) {
    process.exit(0);
    return;
  }
  if (!isSafeHandoffDirName(state.pendingHandoff)) {
    console.error(`[batonpass] refusing to use unsafe pendingHandoff value: ${JSON.stringify(state.pendingHandoff)}`);
    process.exit(0);
    return;
  }

  const handoffDir = `${paths.handoffsDir}/${state.pendingHandoff}`;
  let mdContent;
  try {
    mdContent = await fs.readFile(`${handoffDir}/handoff.md`, 'utf8');
  } catch {
    // Referenced handoff is missing/unreadable — don't block session start, just skip injection.
    process.exit(0);
    return;
  }

  const additionalContext = fitToCap(mdContent, `${cwd}/.batonpass/handoffs/`);

  // Clear pendingHandoff so a later plain `claude --resume` doesn't re-inject it.
  const nextState = { ...state, pendingHandoff: null };
  await writeFileAtomic(paths.stateJson, JSON.stringify(nextState, null, 2) + '\n');

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  process.exit(0);
}

main().catch((err) => {
  console.error('[batonpass] session-start hook error:', err);
  process.exit(0); // never block session start on our own bug
});
