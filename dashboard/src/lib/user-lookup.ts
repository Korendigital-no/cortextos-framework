// cortextOS Dashboard - case-insensitive username helpers for auth.
// Kept db-only (no NextAuth import) so they are unit-testable without booting
// the auth provider. Both the login path and the admin seed/sync use these.

import type Database from 'better-sqlite3';
import { db as defaultDb } from './db';
import type { User } from './types';

/**
 * Canonical stored form of a username: trimmed + lowercased. Usernames are
 * case-insensitive identities, so storing them normalized keeps new rows clean.
 * Existing mixed-case rows are still matched via COLLATE NOCASE in
 * {@link findUserByUsername}, so this is non-destructive to current installs.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Look up a user by username, case-insensitively. `COLLATE NOCASE` matches an
 * existing mixed-case row (e.g. a previously-seeded "Vilhelm") against any-case
 * input ("vilhelm", "VILHELM") — fixing the mobile-autocaps lockout footgun —
 * and the input is trimmed so a stray leading/trailing space does not block
 * login. `LIMIT 1` keeps the result deterministic in the (pathological) case
 * where case-variant rows coexist under the case-sensitive UNIQUE constraint.
 */
export function findUserByUsername(
  username: string,
  database: Database.Database = defaultDb,
): User | undefined {
  return database
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE LIMIT 1')
    .get(username.trim()) as User | undefined;
}
