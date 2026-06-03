// Fulcio demo — pluggable LLM provider.
//
// Default: OpenAI (gpt-5.4) via the existing OPENAI_API_KEY (same key the CRM
// webhook pipeline uses). When ANTHROPIC_API_KEY is present we switch to Claude
// Sonnet 4.6 — that is the positioning-correct provider for a "built on Claude"
// sales asset (see mike's note). Provider selection is the ONLY thing that
// changes; callers use runStructured() and get a validated object back.
//
// Implemented with raw fetch (no SDK dependency) so the demo adds zero runtime
// deps to the dashboard.

export type Provider = 'anthropic' | 'openai';

export interface LlmResult<T> {
  data: T;
  provider: Provider;
  model: string;
}

const OPENAI_MODEL = 'gpt-5.4';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

/** Which provider is active, based on which key is configured. Anthropic wins. */
export function activeProvider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'openai';
}

export function activeModel(): string {
  return activeProvider() === 'anthropic' ? ANTHROPIC_MODEL : OPENAI_MODEL;
}

function extractJson(text: string): unknown {
  // Models occasionally wrap JSON in prose or code fences despite instructions.
  // Try a direct parse first, then fall back to the outermost {...} slice.
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('LLM did not return parseable JSON');
  }
}

async function callOpenAI(system: string, user: string, schema: Record<string, unknown>, schemaName: string, temperature: number): Promise<unknown> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, schema, strict: true },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('OpenAI returned no content');
  return extractJson(content);
}

async function callAnthropic(system: string, user: string, temperature: number): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      temperature,
      // The system prompt already mandates JSON-only output; prefill the
      // assistant turn with "{" to force a pure-JSON continuation.
      system,
      messages: [
        { role: 'user', content: user },
        { role: 'assistant', content: '{' },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('Anthropic returned no content');
  // Re-attach the prefilled "{".
  return extractJson('{' + text);
}

/**
 * Run one structured generation and return a validated object. Throws if the
 * provider errors or the output fails validation (so the pipeline surfaces a
 * real failure rather than rendering garbage).
 */
export async function runStructured<T>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  temperature: number;
  validate: (v: unknown) => v is T;
}): Promise<LlmResult<T>> {
  const provider = activeProvider();
  const parsed = provider === 'anthropic'
    ? await callAnthropic(opts.system, opts.user, opts.temperature)
    : await callOpenAI(opts.system, opts.user, opts.schema, opts.schemaName, opts.temperature);

  if (!opts.validate(parsed)) {
    throw new Error(`${provider} output failed schema validation for "${opts.schemaName}"`);
  }
  return { data: parsed, provider, model: activeModel() };
}
