import { z } from 'zod';

/** Which coding agent CLI a handoff was produced by / for. */
export const ToolId = z.enum(['claude-code', 'codex']);
export type ToolId = z.infer<typeof ToolId>;

/** Lifecycle status of a single handoff artifact. */
export const HandoffStatus = z.enum(['pending', 'consumed', 'stale']);
export type HandoffStatus = z.infer<typeof HandoffStatus>;

/**
 * `handoff.json` — machine-written metadata sidecar for a handoff.
 * Kept intentionally small & flat; all narrative content lives in handoff.md.
 */
export const HandoffJsonSchema = z.object({
  version: z.literal('1'),
  seq: z.number().int().nonnegative(),
  tool: ToolId,
  sessionId: z.string().min(1),
  createdAt: z.string().datetime(),
  cwd: z.string().min(1),
  gitHead: z.string().nullable(),
  gitDirty: z.boolean(),
  contextPctAtHandoff: z.number().min(0).max(200),
  previousHandoff: z.string().nullable(),
  status: HandoffStatus,
});
export type HandoffJson = z.infer<typeof HandoffJsonSchema>;

/**
 * The required section headers in `handoff.md`, in order.
 * These are matched as level-2 markdown headers: `## <name>`.
 */
export const REQUIRED_SECTIONS = [
  'Objective',
  'Current state',
  'Next steps',
  'Key decisions',
  'Files touched',
  'Gotchas & constraints',
  'Verification',
  'Do NOT',
] as const;

export type SectionName = (typeof REQUIRED_SECTIONS)[number];

/** Parsed representation of handoff.md: header (`# Handoff <seq>`) + section bodies. */
export const HandoffMdSchema = z.object({
  seq: z.number().int().nonnegative(),
  sections: z.record(z.string(), z.string()),
});
export type HandoffMd = z.infer<typeof HandoffMdSchema>;

/** `.batonpass/state.json` — orchestrator + install-time state. */
export const StateJsonSchema = z.object({
  version: z.literal('1').default('1'),
  tool: ToolId.nullable().default(null),
  orchestratorPid: z.number().int().nullable().default(null),
  pendingHandoff: z.string().nullable().default(null),
  lastSeq: z.number().int().nonnegative().default(0),
  lastSessionId: z.string().nullable().default(null),
});
export type StateJson = z.infer<typeof StateJsonSchema>;

/** `.batonpass/config.json` (merged project + user scope; project wins). */
export const ConfigSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.75),
  pollIntervalMs: z.number().int().positive().default(5000),
  idleQuietMs: z.number().int().positive().default(3000),
  handoffTimeoutMs: z.number().int().positive().default(5 * 60 * 1000),
  maxChainedHandoffs: z.number().int().positive().or(z.literal(Infinity)).default(Infinity),
  agentBinPath: z.record(ToolId, z.string()).default({}),
  modelContextSize: z.record(z.string(), z.number().int().positive()).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});
