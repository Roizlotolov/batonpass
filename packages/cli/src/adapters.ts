import { ClaudeCodeAdapter } from '@batonpass/adapter-claude-code';
import { CodexAdapter } from '@batonpass/adapter-codex';
import type { Adapter, ToolId } from '@batonpass/core';

const registry: Record<ToolId, () => Adapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
};

export function getAdapter(tool: ToolId): Adapter {
  const factory = registry[tool];
  if (!factory) throw new Error(`Unknown agent tool: ${tool}`);
  return factory();
}

export const SUPPORTED_TOOLS: ToolId[] = ['claude-code', 'codex'];
