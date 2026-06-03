// Fulcio demo — pipeline prompts (verbatim from research/fulcio/demo-prompts.md)
//
// 4-stage sequential pipeline: P1 teardown -> P2 concepts -> P3 scripts ->
// P4 UGC+persona. Each stage feeds the next. Strict-JSON output so the result
// cards render structured data. LOCKED RULES are baked into every system prompt:
// natural Norwegian (å/ø/æ), NO em-dash, no clichés, match house voice, JSON only.
//
// Model: research recommends Claude Sonnet 4.6; we run on the existing OpenAI
// key (gpt-5.4) via the pluggable provider in ./llm.ts until an Anthropic key is
// added. Temperatures per research: teardown analytical (~0.3), rest creative (~0.7).

export interface BriefInput {
  produkt: string;
  maalgruppe: string;
  tilbud: string;
  plattform: string;
  husstil_eksempler: string;
}

export interface PipelineStage<T> {
  key: string;
  label: string;
  temperature: number;
  system: string;
  user: (ctx: PipelineContext) => string;
  /** JSON Schema for the structured output (used for response_format + validation). */
  schema: Record<string, unknown>;
  /** Runtime validator: returns true if the parsed object matches the expected shape. */
  validate: (parsed: unknown) => parsed is T;
}

/** Accumulated context threaded through the pipeline. */
export interface PipelineContext {
  brief: BriefInput;
  teardown?: Teardown;
  concepts?: Concepts;
  scripts?: Scripts;
}

// --- Output types ---------------------------------------------------------

export interface Teardown {
  hook_patterns: string[];
  recurring_angles: string[];
  why_it_works: string[];
  house_voice_traits: string[];
}

export interface Concept {
  title: string;
  angle: string;
  hook: string;
  why_it_lands: string;
}
export interface Concepts {
  concepts: Concept[];
}

export interface Script {
  concept_title: string;
  platform: string;
  hook: string;
  body: string;
  cta: string;
}
export interface Scripts {
  scripts: Script[];
}

export interface UgcResult {
  ugc_script: {
    hook: string;
    talking_points: string[];
    cta: string;
    tone_note: string;
  };
  creator_persona: {
    archetype: string;
    age_range: string;
    style: string;
    why_this_creator: string;
  };
}

// --- Shared rule block (locked) -------------------------------------------

const RULES =
  'REGLER: Skriv på naturlig norsk (å/ø/æ). ALDRI bruk em-dash (—); bruk komma, punktum eller kolon. Ingen klisjéer eller fyllord. Svar KUN med gyldig JSON i det angitte skjemaet, ingen tekst utenfor.';

// --- Validators -----------------------------------------------------------

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function validateTeardown(p: unknown): p is Teardown {
  return isObj(p) && isStrArr(p.hook_patterns) && isStrArr(p.recurring_angles) && isStrArr(p.why_it_works) && isStrArr(p.house_voice_traits);
}
function validateConcepts(p: unknown): p is Concepts {
  // Must be non-empty: an empty batch is schema-shaped but useless (empty card +
  // downstream stages run with no selected concept). The prompt asks for 3-5.
  return isObj(p) && Array.isArray(p.concepts) && p.concepts.length > 0 && p.concepts.every(c => isObj(c) && typeof c.title === 'string' && typeof c.angle === 'string' && typeof c.hook === 'string' && typeof c.why_it_lands === 'string');
}
function validateScripts(p: unknown): p is Scripts {
  return isObj(p) && Array.isArray(p.scripts) && p.scripts.length > 0 && p.scripts.every(s => isObj(s)
    && typeof s.concept_title === 'string' && typeof s.platform === 'string'
    && typeof s.hook === 'string' && typeof s.body === 'string' && typeof s.cta === 'string');
}
function validateUgc(p: unknown): p is UgcResult {
  if (!isObj(p) || !isObj(p.ugc_script) || !isObj(p.creator_persona)) return false;
  const u = p.ugc_script as Record<string, unknown>;
  const c = p.creator_persona as Record<string, unknown>;
  return typeof u.hook === 'string' && isStrArr(u.talking_points) && typeof u.cta === 'string' && typeof u.tone_note === 'string'
    && typeof c.archetype === 'string' && typeof c.age_range === 'string' && typeof c.style === 'string' && typeof c.why_this_creator === 'string';
}

// --- Stage definitions ----------------------------------------------------

export const P1_TEARDOWN: PipelineStage<Teardown> = {
  key: 'teardown',
  label: 'River ned vinner-mønstre',
  temperature: 0.3,
  system: `Du er senior performance-kreatør i et norsk UGC/paid-social-byrå. Du analyserer vinner-annonser for å trekke ut HVA som funker og HVORFOR, slik at nye annonser kan bygges i samme vinnende mønster. Du er presis, konkret og mønster-orientert, ikke generisk.\n\n${RULES}`,
  user: ({ brief }) => `Produkt/kunde: ${brief.produkt}
Plattform: ${brief.plattform}
Vinner-annonser (husstil-eksempler) å analysere:
${brief.husstil_eksempler}

Analyser disse vinner-annonsene. Trekk ut: gjentakende hook-mønstre, vinkler som går igjen, hvorfor de stopper scrollen, og 3-5 konkrete stemme-/stil-kjennetegn som definerer husstilen.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['hook_patterns', 'recurring_angles', 'why_it_works', 'house_voice_traits'],
    properties: {
      hook_patterns: { type: 'array', items: { type: 'string' } },
      recurring_angles: { type: 'array', items: { type: 'string' } },
      why_it_works: { type: 'array', items: { type: 'string' } },
      house_voice_traits: { type: 'array', items: { type: 'string' } },
    },
  },
  validate: validateTeardown,
};

export const P2_CONCEPTS: PipelineStage<Concepts> = {
  key: 'concepts',
  label: 'Genererer konsepter',
  temperature: 0.7,
  system: `Du er kreativ strateg i et norsk UGC/paid-social-byrå. Du genererer distinkte annonse-konsepter (vinkler), ikke ferdige manus. Hvert konsept er en egen strategisk vinkel med en scroll-stoppende hook. Du tenker som en performance-marketer: hva får akkurat denne målgruppen til å stoppe og kjøpe.\n\n${RULES} Konseptene skal være DISTINKTE (ikke varianter av samme vinkel). Match husstil-stemmen fra teardownen.`,
  user: ({ brief, teardown }) => `Produkt/kunde: ${brief.produkt}
Målgruppe: ${brief.maalgruppe}
Tilbud/vinkel: ${brief.tilbud}
Plattform: ${brief.plattform}
Husstil + vinner-mønstre (fra teardown): ${JSON.stringify(teardown)}

Generer 3-5 DISTINKTE annonse-konsepter for denne kampanjen, i husstilen. Hvert konsept: en kort konsept-tittel, den strategiske vinkelen (1 setning), en konkret scroll-stoppende hook, og hvorfor den treffer målgruppen.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['concepts'],
    properties: {
      concepts: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'angle', 'hook', 'why_it_lands'],
          properties: {
            title: { type: 'string' }, angle: { type: 'string' }, hook: { type: 'string' }, why_it_lands: { type: 'string' },
          },
        },
      },
    },
  },
  validate: validateConcepts,
};

export const P3_SCRIPTS: PipelineStage<Scripts> = {
  key: 'scripts',
  label: 'Skriver manus',
  temperature: 0.7,
  system: `Du er manusforfatter for UGC/kortform-annonser i et norsk paid-social-byrå. Du skriver ferdige, innspillingsklare annonse-manus med tydelig hook, body og CTA, tilpasset plattformen og leverbart av en UGC-creator. Hook-en må fange innen de første 2 sekundene.\n\n${RULES} Match husstil-stemmen. Manuset skal kunne LESES/FREMFOERES av en creator (muntlig, naturlig).`,
  user: ({ brief, teardown, concepts }) => `Produkt/kunde: ${brief.produkt}
Målgruppe: ${brief.maalgruppe}
Tilbud: ${brief.tilbud}
Plattform: ${brief.plattform}
Husstil + vinner-mønstre: ${JSON.stringify(teardown)}
Valgte konsepter: ${JSON.stringify(concepts)}

Skriv 2-3 ferdige annonse-manus basert på de sterkeste konseptene. Hvert manus: hook (de første 2 sek), body (selve budskapet), CTA (call-to-action), og hvilken plattform-tone det er tilpasset.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['scripts'],
    properties: {
      scripts: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['concept_title', 'platform', 'hook', 'body', 'cta'],
          properties: {
            concept_title: { type: 'string' }, platform: { type: 'string' }, hook: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' },
          },
        },
      },
    },
  },
  validate: validateScripts,
};

export const P4_UGC: PipelineStage<UgcResult> = {
  key: 'ugc',
  label: 'Definerer creator-persona',
  temperature: 0.7,
  system: `Du er creator-koordinator og manusforfatter i et norsk UGC-byrå. Du gjør et annonse-konsept om til et innspillingsklart UGC-manus OG definerer den optimale creatoren til å fremføre det (arketype, alder, stil, tone), slik at koordinatoren kan matche riktig creator.\n\n${RULES} UGC-manuset skal være muntlig og autentisk (slik ekte creators snakker), ikke reklame-stivt.`,
  user: ({ brief, teardown, concepts, scripts }) => `Produkt/kunde: ${brief.produkt}
Målgruppe: ${brief.maalgruppe}
Plattform: ${brief.plattform}
Valgt konsept + manus: ${JSON.stringify({ concept: concepts?.concepts?.[0], script: scripts?.scripts?.[0] })}
Husstil: ${JSON.stringify(teardown)}

Lag ett innspillingsklart UGC-manus (muntlig, autentisk) + definer den optimale creator-personaen som bør fremføre det.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ugc_script', 'creator_persona'],
    properties: {
      ugc_script: {
        type: 'object', additionalProperties: false,
        required: ['hook', 'talking_points', 'cta', 'tone_note'],
        properties: {
          hook: { type: 'string' }, talking_points: { type: 'array', items: { type: 'string' } }, cta: { type: 'string' }, tone_note: { type: 'string' },
        },
      },
      creator_persona: {
        type: 'object', additionalProperties: false,
        required: ['archetype', 'age_range', 'style', 'why_this_creator'],
        properties: {
          archetype: { type: 'string' }, age_range: { type: 'string' }, style: { type: 'string' }, why_this_creator: { type: 'string' },
        },
      },
    },
  },
  validate: validateUgc,
};

/** Static-ad image prompt (P5 stretch). Built from the chosen concept; fed to GPT Image. */
export function staticAdImagePrompt(produkt: string, plattform: string, conceptTitle: string): string {
  return `A high-converting static social ad for ${produkt}, ${plattform}-native style, concept: "${conceptTitle}". Clean composition, bold short headline overlay (Norwegian), product hero, scroll-stopping. Match the visual energy of a performance UGC brand. No watermark.`;
}
