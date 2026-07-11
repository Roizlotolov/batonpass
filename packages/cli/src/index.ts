#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BatonpassPaths,
  defaultUserConfigPath,
  isProcessAlive,
  listHandoffs,
  loadConfig,
  readHandoff,
  readState,
  type ToolId,
} from '@batonpass/core';
import { Command } from 'commander';
import { getAdapter, SUPPORTED_TOOLS } from './adapters.js';
import { Orchestrator } from './orchestrator.js';
import { spawnPty } from './pty.js';

const program = new Command();
program.name('batonpass').description('Automatic session handoff for coding agents.').version('0.1.0');

function assertTool(tool: string): asserts tool is ToolId {
  if (!SUPPORTED_TOOLS.includes(tool as ToolId)) {
    console.error(`Unknown agent "${tool}". Supported: ${SUPPORTED_TOOLS.join(', ')}`);
    process.exit(1);
  }
}

program
  .command('run <agent>')
  .description('Run an agent CLI under Batonpass\'s automatic-handoff orchestrator (e.g. `batonpass run claude`).')
  .action(async (agentArg: string) => {
    const tool: ToolId = agentArg === 'claude' ? 'claude-code' : (agentArg as ToolId);
    assertTool(tool);

    const cwd = process.cwd();
    const adapter = getAdapter(tool);
    const config = await loadConfig(cwd, defaultUserConfigPath(os.homedir()));

    const orchestrator = new Orchestrator({ adapter, cwd, config, spawnPty });
    orchestrator.on('state', (s) => process.env.BATON_DEBUG && console.error(`[batonpass] state -> ${s}`));
    orchestrator.on('handoff', (seq) => console.error(`\n⚡ batonpass: handoff #${seq} complete, resuming with a fresh session…\n`));
    orchestrator.on('fallback', (reason) => console.error(`\n⚠️  batonpass: ${reason}\n`));

    process.on('SIGINT', () => orchestrator.requestStop());
    process.on('SIGTERM', () => orchestrator.requestStop());

    await orchestrator.run();
  });

program
  .command('init')
  .description('Install Batonpass hooks/statusline for an agent.')
  .option('--agent <agent>', 'claude | codex | all', 'claude')
  .option('--project', 'install at project scope (default)', true)
  .option('--user', 'install at user scope')
  .option('--uninstall', 'remove a previous install instead')
  .action(async (opts: { agent: string; project: boolean; user: boolean; uninstall?: boolean }) => {
    const cwd = process.cwd();
    const scope: 'user' | 'project' = opts.user ? 'user' : 'project';
    const agents = opts.agent === 'all' ? (['claude-code', 'codex'] as ToolId[]) : [opts.agent === 'claude' ? 'claude-code' : (opts.agent as ToolId)];

    for (const tool of agents) {
      assertTool(tool);
      const adapter = getAdapter(tool);
      if (opts.uninstall) {
        await adapter.uninstall(scope, cwd);
        console.log(`batonpass: uninstalled ${tool} (${scope} scope).`);
      } else {
        const { backedUpFiles } = await adapter.install(scope, cwd);
        console.log(`batonpass: installed ${tool} (${scope} scope).`);
        for (const f of backedUpFiles) console.log(`  backed up: ${f}`);
      }
    }
  });

program
  .command('status')
  .description('Show current Batonpass session/orchestrator status for this project.')
  .action(async () => {
    const cwd = process.cwd();
    const paths = new BatonpassPaths(cwd);
    const state = await readState(paths);
    const handoffs = await listHandoffs(paths.handoffsDir);
    const orchestratorAlive = state.orchestratorPid ? isProcessAlive(state.orchestratorPid) : false;

    console.log(`tool:             ${state.tool ?? '(none)'}`);
    console.log(`orchestrator pid: ${state.orchestratorPid ?? '(none)'}${state.orchestratorPid ? (orchestratorAlive ? ' (alive)' : ' (dead — stale)') : ''}`);
    console.log(`pending handoff:  ${state.pendingHandoff ?? '(none)'}`);
    console.log(`handoff count:    ${handoffs.length}`);
  });

program
  .command('handoffs [show] [seq]')
  .description('List handoffs, or `batonpass handoffs show <seq>` to print one.')
  .action(async (sub?: string, seqArg?: string) => {
    const cwd = process.cwd();
    const paths = new BatonpassPaths(cwd);
    const handoffs = await listHandoffs(paths.handoffsDir);

    if (sub === 'show' && seqArg) {
      const dir = handoffs.find((d) => path.basename(d).startsWith(`${seqArg}-`));
      if (!dir) {
        console.error(`No handoff with seq ${seqArg}.`);
        process.exit(1);
      }
      const { mdText } = await readHandoff(dir!);
      console.log(mdText);
      return;
    }

    if (handoffs.length === 0) {
      console.log('No handoffs yet.');
      return;
    }
    for (const dir of handoffs) console.log(path.basename(dir));
  });

program
  .command('doctor')
  .description('Check agent binaries, hook installation, and known platform caveats.')
  .action(async () => {
    const cwd = process.cwd();
    if (process.platform === 'win32') {
      console.log('⚠️  Windows detected: Codex hooks are disabled on Windows upstream; only the Claude Code adapter is supported here.');
    }

    for (const tool of SUPPORTED_TOOLS) {
      const adapter = getAdapter(tool);
      let installed: boolean;
      try {
        installed = await adapter.detectInstalled();
      } catch {
        installed = false;
      }
      console.log(`${tool}: binary ${installed ? 'found' : 'NOT found'}`);
      for (const scope of ['project', 'user'] as const) {
        try {
          const configured = await adapter.isInstalled(scope, cwd);
          console.log(`  ${scope} hooks configured: ${configured}`);
        } catch (err) {
          console.log(`  ${scope} hooks configured: error (${(err as Error).message})`);
        }
      }
    }
  });

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { program };
