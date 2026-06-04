import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { safeAddColumn } from "../schema";

// Race-safety regression: `next build` collects page data in parallel worker
// processes sharing one SQLite file, so a check-then-ALTER column migration
// races and the loser throws "duplicate column name", flaking the build.
// safeAddColumn must be idempotent: a second add of an existing column is a
// no-op, not a throw.

function freshDb() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  return db;
}

function columns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((c) => c.name);
}

describe("safeAddColumn", () => {
  it("adds a missing column", () => {
    const db = freshDb();
    safeAddColumn(db, "t", "needs_review", "INTEGER DEFAULT 0");
    expect(columns(db)).toContain("needs_review");
    db.close();
  });

  it("is idempotent — adding an existing column does not throw (the race outcome)", () => {
    const db = freshDb();
    safeAddColumn(db, "t", "needs_review", "INTEGER DEFAULT 0");
    // Second call models the losing build worker: the ALTER throws
    // "duplicate column name" internally and must be swallowed.
    expect(() => safeAddColumn(db, "t", "needs_review", "INTEGER DEFAULT 0")).not.toThrow();
    expect(columns(db).filter((c) => c === "needs_review")).toHaveLength(1);
    db.close();
  });

  it("tolerates a column added out-of-band (real concurrent ALTER)", () => {
    const db = freshDb();
    db.exec("ALTER TABLE t ADD COLUMN match_confidence REAL DEFAULT 1.0");
    expect(() => safeAddColumn(db, "t", "match_confidence", "REAL DEFAULT 1.0")).not.toThrow();
    db.close();
  });

  it("still throws on a genuine error (e.g. unknown table)", () => {
    const db = freshDb();
    expect(() => safeAddColumn(db, "no_such_table", "x", "INTEGER")).toThrow();
    db.close();
  });
});
