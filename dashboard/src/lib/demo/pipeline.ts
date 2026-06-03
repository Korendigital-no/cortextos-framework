// Fulcio demo — pipeline orchestration.
//
// Four sequential stages (teardown -> concepts -> scripts -> ugc). The client
// drives them one at a time, threading the accumulated context forward, so the
// UI can show each step completing ("the agent works"). Each stage validates its
// own output before returning.

import { runStructured, type Provider } from './llm';
import {
  P1_TEARDOWN, P2_CONCEPTS, P3_SCRIPTS, P4_UGC,
  type BriefInput, type PipelineContext,
} from './prompts';

export const STAGE_ORDER = ['teardown', 'concepts', 'scripts', 'ugc'] as const;
export type StageKey = (typeof STAGE_ORDER)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STAGES: Record<StageKey, any> = {
  teardown: P1_TEARDOWN,
  concepts: P2_CONCEPTS,
  scripts: P3_SCRIPTS,
  ugc: P4_UGC,
};

export interface StageResult {
  stage: StageKey;
  label: string;
  data: unknown;
  provider: Provider;
  model: string;
}

/** The earlier-stage outputs a given stage needs to run. */
export function stageDependencies(stage: StageKey): StageKey[] {
  switch (stage) {
    case 'teardown': return [];
    case 'concepts': return ['teardown'];
    case 'scripts': return ['teardown', 'concepts'];
    case 'ugc': return ['teardown', 'concepts', 'scripts'];
  }
}

/**
 * Run a single pipeline stage. `context` must already contain the outputs of all
 * earlier stages (the client threads them through; the API re-validates).
 */
export async function runStage(stage: StageKey, brief: BriefInput, context: Omit<PipelineContext, 'brief'>): Promise<StageResult> {
  const def = STAGES[stage];
  if (!def) throw new Error(`Unknown stage: ${stage}`);

  for (const dep of stageDependencies(stage)) {
    if (!(dep in context) || context[dep as keyof typeof context] == null) {
      throw new Error(`Stage "${stage}" requires "${dep}" but it was not provided`);
    }
  }

  const ctx: PipelineContext = { brief, ...context };
  const { data, provider, model } = await runStructured({
    system: def.system,
    user: def.user(ctx),
    schema: def.schema,
    schemaName: def.key,
    temperature: def.temperature,
    validate: def.validate,
  });

  return { stage, label: def.label, data, provider, model };
}
