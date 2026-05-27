import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { initializeCrmSchema } from '../../../src/bus/crm-schema.js';

describe('CRM schema', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crm-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeCrmSchema(db);
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all CRM tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'crm_%' ORDER BY name"
    ).all() as { name: string }[];

    expect(tables.map(t => t.name)).toEqual([
      'crm_activities',
      'crm_companies',
      'crm_contacts',
      'crm_deals',
      'crm_meetings',
      'crm_webhook_log',
    ]);
  });

  it('enforces foreign keys between contacts and companies', () => {
    expect(() => {
      db.prepare(
        "INSERT INTO crm_contacts (id, name, company_id, created_at, updated_at) VALUES ('fk_test', 'Test', 'nonexistent', datetime('now'), datetime('now'))"
      ).run();
    }).toThrow();
  });

  it('creates indexes for common queries', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_crm_%' ORDER BY name"
    ).all() as { name: string }[];

    expect(indexes.length).toBeGreaterThanOrEqual(6);
  });

  it('is idempotent', () => {
    expect(() => initializeCrmSchema(db)).not.toThrow();
  });
});
