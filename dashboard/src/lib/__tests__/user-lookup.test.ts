/**
 * Unit test for the case-insensitive username helpers (auth login footgun fix).
 *
 * Background: authorize() did a case-sensitive `WHERE username = ?` lookup, so
 * mobile autocaps ("Vilhelm" typed as "vilhelm"/"VILHELM") locked the owner out.
 * The fix matches COLLATE NOCASE and trims whitespace, and stores normalized.
 *
 * Tested against a real in-memory better-sqlite3 with the same users schema the
 * dashboard uses, via dependency injection (no NextAuth boot).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { findUserByUsername, normalizeUsername } from '../user-lookup';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  // Mirrors dashboard/src/lib/schema.ts users table.
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
  `);
});

describe('normalizeUsername', () => {
  it('trims and lowercases', () => {
    expect(normalizeUsername('  Vilhelm ')).toBe('vilhelm');
    expect(normalizeUsername('ADMIN')).toBe('admin');
    expect(normalizeUsername('admin')).toBe('admin');
  });
});

describe('findUserByUsername (case-insensitive)', () => {
  beforeEach(() => {
    // An existing, mixed-case admin row (as older installs seeded it).
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      'Vilhelm',
      'hash',
    );
  });

  it('matches an existing mixed-case row regardless of input case', () => {
    for (const input of ['vilhelm', 'VILHELM', 'Vilhelm', 'ViLhElM']) {
      expect(findUserByUsername(input, db)?.username).toBe('Vilhelm');
    }
  });

  it('trims surrounding whitespace on the input', () => {
    expect(findUserByUsername('  vilhelm  ', db)?.username).toBe('Vilhelm');
  });

  it('returns undefined for a genuinely unknown user', () => {
    expect(findUserByUsername('mallory', db)).toBeUndefined();
  });

  it('fixes the bug: case-sensitive lookup misses, NOCASE lookup hits', () => {
    // The OLD behavior (the footgun): a plain case-sensitive query does not
    // match lowercased input against the "Vilhelm" row.
    const caseSensitive = db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get('vilhelm');
    expect(caseSensitive).toBeUndefined();
    // The FIX: the helper matches it.
    expect(findUserByUsername('vilhelm', db)).toBeDefined();
  });

  it('returns a deterministic single row even if case-variant rows coexist', () => {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      'vilhelm',
      'hash2',
    );
    // LIMIT 1 → exactly one row, never throws on multiple NOCASE matches.
    const found = findUserByUsername('VILHELM', db);
    expect(found).toBeDefined();
    expect(['Vilhelm', 'vilhelm']).toContain(found?.username);
  });
});
