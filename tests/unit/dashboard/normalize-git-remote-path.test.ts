import { describe, it, expect } from 'vitest';
import { normalizeGitRemotePath } from '../../../dashboard/src/lib/content-publish';

describe('normalizeGitRemotePath', () => {
  it('handles HTTPS with .git suffix', () => {
    expect(normalizeGitRemotePath('https://github.com/Korendigital-no/Korendigital-nettside.git'))
      .toBe('korendigital-no/korendigital-nettside');
  });

  it('handles HTTPS without .git suffix', () => {
    expect(normalizeGitRemotePath('https://github.com/Korendigital-no/Korendigital-nettside'))
      .toBe('korendigital-no/korendigital-nettside');
  });

  it('handles HTTPS with trailing slash', () => {
    expect(normalizeGitRemotePath('https://github.com/Korendigital-no/Korendigital-nettside/'))
      .toBe('korendigital-no/korendigital-nettside');
  });

  it('handles SSH style with .git', () => {
    expect(normalizeGitRemotePath('git@github.com:Korendigital-no/Korendigital-nettside.git'))
      .toBe('korendigital-no/korendigital-nettside');
  });

  it('handles SSH style without .git', () => {
    expect(normalizeGitRemotePath('git@github.com:Korendigital-no/Korendigital-nettside'))
      .toBe('korendigital-no/korendigital-nettside');
  });

  it('lowercases for case-insensitive comparison', () => {
    expect(normalizeGitRemotePath('https://github.com/FOO/BAR.git'))
      .toBe(normalizeGitRemotePath('https://github.com/foo/bar'));
  });

  it('distinguishes different repos', () => {
    expect(normalizeGitRemotePath('https://github.com/vkoren04/Korendigital-nettside.git'))
      .not.toBe(normalizeGitRemotePath('https://github.com/Korendigital-no/Korendigital-nettside.git'));
  });

  it('returns lowercase input unchanged when not URL-shaped (caller hard-fails on mismatch)', () => {
    expect(normalizeGitRemotePath('not-a-url')).toBe('not-a-url');
  });
});
