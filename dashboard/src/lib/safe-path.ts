// Safe-path helpers for filesystem operations on user-controlled identifiers.
//
// The dashboard takes `org` and `agent` strings from URL query parameters and
// uses them to build filesystem paths via path.join(CTX_ROOT, 'orgs', org, ...).
// Without validation, an attacker (or curious authenticated user) can pass
// `../../etc/passwd` or similar to escape the intended directory.
//
// These helpers enforce the same lexical shape that cortextos itself uses for
// org and agent names at creation time: lowercase letters, digits, hyphen,
// underscore, 1-64 chars, must start with letter or digit.

export const SAFE_IDENT_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export class UnsafeIdentError extends Error {
  constructor(kind: string, value: unknown) {
    super(`Unsafe ${kind} identifier: ${JSON.stringify(value)}`);
    this.name = "UnsafeIdentError";
  }
}

export function isSafeIdent(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENT_REGEX.test(value);
}

export function assertSafeOrgIdent(org: unknown): asserts org is string {
  if (!isSafeIdent(org)) throw new UnsafeIdentError("org", org);
}

export function assertSafeAgentIdent(agent: unknown): asserts agent is string {
  if (!isSafeIdent(agent)) throw new UnsafeIdentError("agent", agent);
}
