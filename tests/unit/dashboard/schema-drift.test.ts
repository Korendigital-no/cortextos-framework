/**
 * CRM schema parity: dashboard schema must be a SUPERSET of the framework's
 * canonical CRM schema (task_1780542355137).
 *
 * THE BUG CLASS: two parallel definitions of the same SQLite database exist —
 *   - framework: src/bus/crm-schema.ts (canonical; applied via getCrmDb())
 *   - dashboard: dashboard/src/lib/schema.ts (applied on Next.js boot)
 * When a migration lands only in the framework file, a FRESH dashboard-only DB
 * (framework CLI never ran against it) is missing the column, and every
 * dashboard query touching it throws SQLITE_ERROR. Found twice by codex review
 * (PR #58 bycatch, re-confirmed in PR #63): crm_documents.client_id/project_id
 * and crm_meetings.ai_parsed/email_draft existed only in the framework schema
 * while dashboard routes queried them (project-detail GET/DELETE, deal/contact
 * detail pages).
 *
 * THE GUARD: build both schemas into in-memory DBs and assert, for every
 * crm_* table in the framework schema, that the dashboard schema has the
 * table, every column (with the same normalized type), and every index.
 * Direction is dashboard ⊇ framework: dashboard-only extensions (e.g.
 * billable) are legitimate; the framework never queries them. Scope is
 * crm_* only — that is exactly the framework's footprint in the shared DB
 * (src/bus/crm-db.ts applies only initializeCrmSchema); all other tables are
 * dashboard-owned read caches with no second schema definition to drift from.
 *
 * MUTATION CHECKS (documented, executed during development):
 * - With the four safeAddColumn mirrors and index mirrors removed from
 *   dashboard/src/lib/schema.ts, the parity tests fail enumerating exactly
 *   the missing columns/indexes, and the behaviour tests throw
 *   "no such column: project_id".
 * - Structural assertions: a same-name index re-pointed at a different column
 *   fails with the cols=() drift; a mirrored column stripped of its DEFAULT
 *   fails with the default= drift; an index given DESC order (invisible to
 *   the pragmas read here) fails via the normalized sql= component; a
 *   partial-index WHERE predicate fails via partial= and sql=; a
 *   literal-case-only predicate drift (WHERE x = 'lead' vs 'LEAD', identical
 *   structure otherwise) fails via the case-preserved sql=; a mirrored FK
 *   re-targeted at the wrong table (crm_documents.project_id ->
 *   crm_clients instead of crm_client_projects) fails the FK parity test.
 *   Name-presence alone is NOT trusted — uniqueness/partiality/key-columns,
 *   the normalized CREATE INDEX SQL, FK targets/actions, and
 *   type/notnull/default/pk/hidden are pinned for everything the framework
 *   defines (dashboard-only extras stay free to evolve). Accepted residual:
 *   column-level COLLATE and table CHECK constraints are not pinned — neither
 *   appears in any crm_* table in either schema today, and pinning them needs
 *   raw table-DDL comparison, which false-fails on legitimate formatting and
 *   ALTER-vs-inline column-order differences between the two files.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { initializeCrmSchema } from '../../../src/bus/crm-schema.js';
import { initializeSchema } from '../../../dashboard/src/lib/schema';

interface ColumnInfo {
  name: string;
  /** Normalized "type|notnull|default|pk" signature — drift in ANY of these
   *  changes INSERT/UPSERT behavior, not just query resolution. */
  signature: string;
}

interface IndexRow {
  name: string;
  tbl_name: string;
}

function crmTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'crm_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(r => r.name);
}

function columns(db: Database.Database, table: string): ColumnInfo[] {
  // table_xinfo (not table_info) so hidden/generated columns participate too.
  return (
    db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>
  ).map(c => ({
    name: c.name,
    signature: [
      c.type.toUpperCase().trim(),
      `notnull=${c.notnull}`,
      // Whitespace-collapsed but case-PRESERVED: 'pending' vs 'PENDING' is
      // semantic data drift (different default rows), not cosmetics.
      `default=${c.dflt_value === null ? 'NULL' : String(c.dflt_value).replace(/\s+/g, ' ')}`,
      `pk=${c.pk}`,
      `hidden=${c.hidden}`,
    ].join('|'),
  }));
}

/** Per-FK-group signatures for a table: source columns → target table(columns)
 *  plus ON UPDATE / ON DELETE actions. db.ts runs with foreign_keys = ON, so a
 *  mirror that references the wrong table or drops an action is real runtime
 *  drift (constraint failures / missing cascades), not cosmetics. Grouped by
 *  the FK id so composite keys compare as one unit. */
function fkSignatures(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string | null;
    on_update: string;
    on_delete: string;
  }>;
  const groups = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.id) ?? [];
    group.push(row);
    groups.set(row.id, group);
  }
  return [...groups.values()]
    .map(group => {
      const ordered = [...group].sort((a, b) => a.seq - b.seq);
      const froms = ordered.map(r => r.from).join(',');
      const tos = ordered.map(r => r.to ?? '<pk>').join(',');
      const { table: target, on_update, on_delete } = ordered[0];
      return `(${froms})->${target}(${tos})|on_update=${on_update}|on_delete=${on_delete}`;
    })
    .sort();
}

function crmIndexes(db: Database.Database): IndexRow[] {
  return db
    .prepare(
      `SELECT name, tbl_name FROM sqlite_master
       WHERE type = 'index'
         AND tbl_name LIKE 'crm_%'
         AND name NOT LIKE 'sqlite_autoindex_%'
       ORDER BY name`,
    )
    .all() as IndexRow[];
}

/** Structural index signature: uniqueness, partiality, the ordered key
 *  columns, AND the normalized CREATE INDEX SQL. The pragmas give readable
 *  diagnostics for the common drifts (a same-name index silently becoming
 *  non-unique or indexing a different column is real drift — unique indexes
 *  drive UPSERT/conflict behavior). The normalized sqlite_master.sql closes
 *  everything the pragmas cannot see: partial-index WHERE predicates,
 *  expression bodies, COLLATE clauses, and DESC sort order. */
function indexSignature(db: Database.Database, table: string, name: string): string {
  const list = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const meta = list.find(i => i.name === name);
  if (!meta) return '<absent>';
  const keyCols = (
    db.prepare(`PRAGMA index_xinfo(${name})`).all() as Array<{
      seqno: number;
      name: string | null;
      key: number;
    }>
  )
    .filter(c => c.key === 1)
    .sort((a, b) => a.seqno - b.seqno)
    .map(c => c.name ?? `<expr:${c.seqno}>`);
  const sqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql: string | null } | undefined;
  // Normalize ONLY whitespace and the optional IF NOT EXISTS. Case is
  // PRESERVED: case-folding the whole statement would mask semantic case
  // drift inside string literals (e.g. a partial predicate WHERE stage =
  // 'lead' vs 'LEAD') — the same bug class as the column-default comparison.
  // Identifier/keyword case matches between the two schema files because the
  // dashboard mirrors the framework DDL verbatim.
  const normalizedSql = (sqlRow?.sql ?? '<no-sql>')
    .replace(/\s+/g, ' ')
    .replace(/IF NOT EXISTS /i, '')
    .trim();
  return `unique=${meta.unique}|partial=${meta.partial}|cols=(${keyCols.join(',')})|sql=${normalizedSql}`;
}

describe('CRM schema parity — dashboard ⊇ framework', () => {
  let framework: Database.Database;
  let dashboard: Database.Database;

  beforeAll(() => {
    framework = new Database(':memory:');
    dashboard = new Database(':memory:');
    initializeCrmSchema(framework);
    initializeSchema(dashboard);
  });

  afterAll(() => {
    framework.close();
    dashboard.close();
  });

  it('sanity: framework schema defines crm_* tables at all', () => {
    // Guards the guard: if the framework export ever stops creating tables,
    // every subset assertion below would pass vacuously.
    expect(crmTables(framework).length).toBeGreaterThan(5);
  });

  it('dashboard has every crm_* table the framework defines', () => {
    const dashTables = new Set(crmTables(dashboard));
    const missing = crmTables(framework).filter(t => !dashTables.has(t));
    expect(missing, `dashboard schema is missing framework crm tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('dashboard has every column of every framework crm_* table, with matching type/notnull/default/pk', () => {
    const problems: string[] = [];
    for (const table of crmTables(framework)) {
      const dashCols = new Map(columns(dashboard, table).map(c => [c.name, c.signature]));
      for (const col of columns(framework, table)) {
        const dashSig = dashCols.get(col.name);
        if (dashSig === undefined) {
          problems.push(`${table}.${col.name} (missing)`);
        } else if (dashSig !== col.signature) {
          problems.push(
            `${table}.${col.name} (drift: framework=[${col.signature}] dashboard=[${dashSig}])`,
          );
        }
      }
    }
    expect(
      problems,
      `dashboard/src/lib/schema.ts has drifted from src/bus/crm-schema.ts — ` +
        `mirror these in the dashboard migration block:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('dashboard has every foreign key of every framework crm_* table, with matching target and actions', () => {
    const problems: string[] = [];
    for (const table of crmTables(framework)) {
      const dashFks = new Set(fkSignatures(dashboard, table));
      for (const fk of fkSignatures(framework, table)) {
        if (!dashFks.has(fk)) {
          problems.push(`${table}: FK ${fk}`);
        }
      }
    }
    expect(
      problems,
      `dashboard schema is missing or has drifted framework crm foreign keys:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('dashboard has every crm_* index the framework defines, structurally identical', () => {
    const dashIndexes = new Map(crmIndexes(dashboard).map(i => [i.name, i.tbl_name]));
    const problems: string[] = [];
    for (const idx of crmIndexes(framework)) {
      if (!dashIndexes.has(idx.name)) {
        problems.push(`${idx.name} on ${idx.tbl_name} (missing)`);
        continue;
      }
      const fwSig = indexSignature(framework, idx.tbl_name, idx.name);
      const dashSig = indexSignature(dashboard, dashIndexes.get(idx.name)!, idx.name);
      if (fwSig !== dashSig) {
        problems.push(`${idx.name} on ${idx.tbl_name} (drift: framework=[${fwSig}] dashboard=[${dashSig}])`);
      }
    }
    expect(problems, 'dashboard schema is missing or has drifted framework crm indexes').toEqual([]);
  });
});

describe('project-detail route queries against a fresh dashboard-only DB', () => {
  // The original symptom: a DB initialized ONLY by the dashboard schema
  // (framework CLI never ran) must satisfy every crm_documents query the
  // project-detail route prepares — both the GET listing and the DELETE
  // detach. Before the fix both threw "no such column: project_id".
  it('GET documents listing does not throw', () => {
    const db = new Database(':memory:');
    try {
      initializeSchema(db);
      expect(() =>
        db.prepare('SELECT * FROM crm_documents WHERE project_id = ? ORDER BY created_at DESC').all('p1'),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('DELETE-path document detach does not throw', () => {
    const db = new Database(':memory:');
    try {
      initializeSchema(db);
      expect(() =>
        db.prepare('UPDATE crm_documents SET project_id = NULL WHERE project_id = ?').run('p1'),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('accounting personal-type migration survives the schema.ts extraction', () => {
  // initializeSchema was extracted from db.ts into schema.ts so it can run
  // against in-memory DBs (this file). migrateAccountsForPersonalType is a
  // DATA migration (backup → drop → recreate → restore) that moved with it —
  // pin its behaviour so the refactor cannot have changed it: rows created
  // under the OLD CHECK constraint survive, and 'personal' is accepted after.
  it("migrates an old-constraint table in place, keeping rows and accepting 'personal'", () => {
    const db = new Database(':memory:');
    try {
      // Pre-migration shape: CHECK list without 'personal'.
      db.exec(`
        CREATE TABLE accounting_accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('operating','tax','vat','other')),
          starting_balance_nok REAL NOT NULL DEFAULT 0 CHECK(starting_balance_nok = starting_balance_nok AND ABS(starting_balance_nok) < 1e12),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        "INSERT INTO accounting_accounts (id, name, type, starting_balance_nok, created_at, updated_at) VALUES ('a1', 'Bedriftskonto', 'operating', 1000, '2026-01-01', '2026-01-01')",
      ).run();

      initializeSchema(db);

      // Existing row survived the table swap.
      const row = db.prepare("SELECT name, type, starting_balance_nok FROM accounting_accounts WHERE id = 'a1'").get() as {
        name: string;
        type: string;
        starting_balance_nok: number;
      };
      expect(row).toEqual({ name: 'Bedriftskonto', type: 'operating', starting_balance_nok: 1000 });

      // New constraint accepts 'personal'.
      expect(() =>
        db
          .prepare(
            "INSERT INTO accounting_accounts (id, name, type, starting_balance_nok, created_at, updated_at) VALUES ('a2', 'Privat', 'personal', 0, '2026-01-01', '2026-01-01')",
          )
          .run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
