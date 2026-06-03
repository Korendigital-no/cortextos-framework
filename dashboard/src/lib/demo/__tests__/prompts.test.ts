/**
 * Unit tests for the Fulcio demo pipeline stage validators. These are the guard
 * between a raw LLM response and the result cards: an output that doesn't match
 * the schema must be rejected (so the demo surfaces a real failure rather than
 * rendering half-empty cards).
 */

import { describe, it, expect } from 'vitest';
import { P1_TEARDOWN, P2_CONCEPTS, P3_SCRIPTS, P4_UGC } from '@/lib/demo/prompts';
import { stageDependencies } from '@/lib/demo/pipeline';

describe('P1 teardown validator', () => {
  it('accepts a well-formed teardown', () => {
    expect(P1_TEARDOWN.validate({
      hook_patterns: ['a'], recurring_angles: ['b'], why_it_works: ['c'], house_voice_traits: ['d'],
    })).toBe(true);
  });
  it('rejects when a field is missing or wrong-typed', () => {
    expect(P1_TEARDOWN.validate({ hook_patterns: ['a'], recurring_angles: ['b'], why_it_works: ['c'] })).toBe(false);
    expect(P1_TEARDOWN.validate({ hook_patterns: 'not-array', recurring_angles: [], why_it_works: [], house_voice_traits: [] })).toBe(false);
    expect(P1_TEARDOWN.validate(null)).toBe(false);
  });
});

describe('P2 concepts validator', () => {
  it('accepts a list of well-formed concepts', () => {
    expect(P2_CONCEPTS.validate({ concepts: [{ title: 't', angle: 'a', hook: 'h', why_it_lands: 'w' }] })).toBe(true);
  });
  it('rejects a concept missing a field', () => {
    expect(P2_CONCEPTS.validate({ concepts: [{ title: 't', angle: 'a', hook: 'h' }] })).toBe(false);
    expect(P2_CONCEPTS.validate({ concepts: 'nope' })).toBe(false);
  });
  it('rejects an empty concept batch (schema-shaped but useless)', () => {
    expect(P2_CONCEPTS.validate({ concepts: [] })).toBe(false);
  });
});

describe('P3 scripts validator', () => {
  it('accepts well-formed scripts', () => {
    expect(P3_SCRIPTS.validate({ scripts: [{ concept_title: 'c', platform: 'TikTok', hook: 'h', body: 'b', cta: 'c' }] })).toBe(true);
  });
  it('rejects a script missing hook/body/cta', () => {
    expect(P3_SCRIPTS.validate({ scripts: [{ concept_title: 'c', platform: 'TikTok' }] })).toBe(false);
  });
  it('rejects a script missing concept_title or platform (cards would render undefined)', () => {
    expect(P3_SCRIPTS.validate({ scripts: [{ hook: 'h', body: 'b', cta: 'c' }] })).toBe(false);
    expect(P3_SCRIPTS.validate({ scripts: [{ concept_title: 'c', hook: 'h', body: 'b', cta: 'c' }] })).toBe(false);
  });
  it('rejects an empty scripts batch', () => {
    expect(P3_SCRIPTS.validate({ scripts: [] })).toBe(false);
  });
});

describe('P4 ugc validator', () => {
  it('accepts a well-formed ugc + persona', () => {
    expect(P4_UGC.validate({
      ugc_script: { hook: 'h', talking_points: ['p'], cta: 'c', tone_note: 't' },
      creator_persona: { archetype: 'a', age_range: '25-35', style: 's', why_this_creator: 'w' },
    })).toBe(true);
  });
  it('rejects when persona or script is malformed', () => {
    expect(P4_UGC.validate({ ugc_script: { hook: 'h', talking_points: 'x', cta: 'c', tone_note: 't' }, creator_persona: {} })).toBe(false);
    expect(P4_UGC.validate({ ugc_script: {}, creator_persona: {} })).toBe(false);
  });
});

describe('pipeline stage dependencies', () => {
  it('declares the correct upstream stages for each stage', () => {
    expect(stageDependencies('teardown')).toEqual([]);
    expect(stageDependencies('concepts')).toEqual(['teardown']);
    expect(stageDependencies('scripts')).toEqual(['teardown', 'concepts']);
    expect(stageDependencies('ugc')).toEqual(['teardown', 'concepts', 'scripts']);
  });
});
