export interface Usage {
  /** Fraction of context window used, 0..~1 (can exceed 1 slightly if over budget). */
  pct: number;
  /** Estimated tokens currently occupying the context window. */
  tokens: number;
  /** Context window size used for the pct calculation. */
  max: number;
  /** Where this reading came from — useful for diagnostics/`batonpass doctor`. */
  source: string;
}

export interface UsageSource {
  getUsage(): Promise<Usage | null>;
}

/** Default context window sizes by model family, used when not overridden in config. */
export const DEFAULT_MODEL_CONTEXT_SIZE: Record<string, number> = {
  'claude-*': 200_000,
  'gpt-5*': 272_000,
  'o*': 200_000,
  default: 200_000,
};

export function contextSizeForModel(
  model: string | undefined,
  overrides: Record<string, number>,
): number {
  if (model && overrides[model]) return overrides[model]!;
  if (!model) return overrides.default ?? DEFAULT_MODEL_CONTEXT_SIZE.default!;
  for (const [pattern, size] of Object.entries({ ...DEFAULT_MODEL_CONTEXT_SIZE, ...overrides })) {
    if (pattern === 'default') continue;
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    if (re.test(model)) return size;
  }
  return overrides.default ?? DEFAULT_MODEL_CONTEXT_SIZE.default!;
}
