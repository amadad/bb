import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  closeAutomationRun,
  createAutomation,
  createManualRun,
  listAutomationRuns,
  migrations,
  reconcileTerminalTokenMigrationPreflight,
  type Db,
} from "./data.js";
import { mapScriptResultToRun } from "./script-runner.js";
import { extractTerminalToken } from "./terminal-token.js";

const STORAGE_STATE_ERROR =
  "Automations storage migration state is invalid; no changes were made.";

function migrateByIndex(db: Db, statements: readonly string[]): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare<[], { id: number }>("SELECT id FROM _bb_migrations")
      .all()
      .map((row) => row.id),
  );
  const record = db.prepare(
    "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
  );
  db.transaction(() => {
    statements.forEach((statement, index) => {
      if (applied.has(index)) return;
      db.exec(statement);
      record.run(index, 1);
    });
  })();
}

function migrationIds(db: Db): number[] {
  return db
    .prepare<[], { id: number }>("SELECT id FROM _bb_migrations ORDER BY id")
    .all()
    .map((row) => row.id);
}

function runColumns(db: Db): string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM pragma_table_info('automation_runs')",
    )
    .all()
    .map((row) => row.name);
}

function schemaSnapshot(db: Db): unknown[] {
  return db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    )
    .all();
}

function createMigratedDb(): Db {
  const db = new Database(":memory:");
  migrateByIndex(db, migrations);
  return db;
}

function createRejectedHistoryDb(schema = migrations[0]!): Db {
  const db = new Database(":memory:");
  db.exec(schema);
  db.exec(migrations[1]!);
  db.exec(`CREATE TABLE _bb_migrations (
    id INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
  INSERT INTO _bb_migrations (id, applied_at) VALUES (0, 1), (1, 1), (2, 1);`);
  return db;
}

function expectStorageStateRejection(db: Db): void {
  const before = schemaSnapshot(db);
  expect(() => reconcileTerminalTokenMigrationPreflight(db)).toThrow(
    STORAGE_STATE_ERROR,
  );
  expect(schemaSnapshot(db)).toEqual(before);
}

function createAgentAutomation(db: Db): void {
  createAutomation(db, {
    id: "auto_status",
    projectId: "proj_test",
    name: "Status",
    enabled: true,
    trigger: {
      triggerType: "schedule",
      cron: "* * * * *",
      timezone: "UTC",
    },
    runMode: "agent",
    execution: {
      mode: "agent",
      prompt: "Run",
      providerId: "codex",
      model: "gpt-5",
      permissionMode: "auto",
      environment: { type: "project-default" },
    },
    origin: "human",
    createdByThreadId: null,
    nextRunAt: 1_000,
  });
}

describe("terminal token migration", () => {
  it("uses the current migration index on a fresh database", () => {
    expect(migrations).toHaveLength(3);
    const db = new Database(":memory:");

    reconcileTerminalTokenMigrationPreflight(db);
    expect(schemaSnapshot(db)).toEqual([]);

    migrateByIndex(db, migrations);
    expect(runColumns(db)).toContain("terminal_token");
    expect(migrationIds(db)).toEqual([0, 1, 2]);
  });

  it("allows a normal parent-schema upgrade", () => {
    const db = new Database(":memory:");
    migrateByIndex(db, migrations.slice(0, 2));
    const before = schemaSnapshot(db);

    reconcileTerminalTokenMigrationPreflight(db);
    expect(schemaSnapshot(db)).toEqual(before);

    migrateByIndex(db, migrations);
    expect(runColumns(db)).toContain("terminal_token");
    expect(migrationIds(db)).toEqual([0, 1, 2]);
  });

  it("repairs only the exact rejected upgrade history", () => {
    const db = new Database(":memory:");
    migrateByIndex(db, migrations.slice(0, 2));
    migrateByIndex(db, [migrations[0]!, migrations[2]!, migrations[1]!]);
    expect(runColumns(db)).not.toContain("terminal_token");
    expect(migrationIds(db)).toEqual([0, 1, 2]);

    reconcileTerminalTokenMigrationPreflight(db);
    reconcileTerminalTokenMigrationPreflight(db);

    expect(runColumns(db).filter((name) => name === "terminal_token")).toEqual([
      "terminal_token",
    ]);
    expect(migrationIds(db)).toEqual([0, 1, 2]);
  });

  it("records the marker when a complete upgraded schema lacks it", () => {
    const db = new Database(":memory:");
    migrateByIndex(db, migrations.slice(0, 2));
    db.exec("ALTER TABLE automation_runs ADD COLUMN terminal_token TEXT");

    reconcileTerminalTokenMigrationPreflight(db);
    migrateByIndex(db, migrations);

    expect(runColumns(db).filter((name) => name === "terminal_token")).toEqual([
      "terminal_token",
    ]);
    expect(migrationIds(db)).toEqual([0, 1, 2]);
  });

  it.each([
    {
      name: "forged run thread index columns",
      mutate: (db: Db) =>
        db.exec(`DROP INDEX automation_runs_thread_idx;
          CREATE INDEX automation_runs_thread_idx ON automation_runs(status);`),
    },
    {
      name: "partial thread marks table",
      mutate: (db: Db) =>
        db.exec(`DROP TABLE automation_thread_marks;
          CREATE TABLE automation_thread_marks (thread_id TEXT PRIMARY KEY);`),
    },
    {
      name: "wrong run thread index uniqueness",
      mutate: (db: Db) =>
        db.exec(`DROP INDEX automation_runs_thread_idx;
          CREATE UNIQUE INDEX automation_runs_thread_idx
          ON automation_runs(thread_id);`),
    },
    {
      name: "wrong idempotency partial predicate",
      mutate: (db: Db) =>
        db.exec(`DROP INDEX automation_runs_idempotency_idx;
          CREATE UNIQUE INDEX automation_runs_idempotency_idx
          ON automation_runs(automation_id, idempotency_key)
          WHERE automation_id IS NOT NULL;`),
    },
    {
      name: "missing required run index",
      mutate: (db: Db) => db.exec("DROP INDEX automation_runs_thread_idx"),
    },
    {
      name: "forged automation due index columns",
      mutate: (db: Db) =>
        db.exec(`DROP INDEX automations_due_idx;
          CREATE INDEX automations_due_idx ON automations(name);`),
    },
    {
      name: "extra automation column",
      mutate: (db: Db) =>
        db.exec("ALTER TABLE automations ADD COLUMN forged TEXT"),
    },
  ])("fails without mutation for $name", ({ mutate }) => {
    const db = createRejectedHistoryDb();
    mutate(db);

    expectStorageStateRejection(db);
  });

  it("fails without mutation for a wrong automation column default", () => {
    const schema = migrations[0]!.replace(
      "enabled INTEGER NOT NULL DEFAULT 1",
      "enabled INTEGER NOT NULL DEFAULT 0",
    );
    expect(schema).not.toBe(migrations[0]);

    expectStorageStateRejection(createRejectedHistoryDb(schema));
  });

  it("fails without mutation for a wrong automation run foreign key", () => {
    const schema = migrations[0]!.replace(
      "ON DELETE CASCADE",
      "ON DELETE RESTRICT",
    );
    expect(schema).not.toBe(migrations[0]);

    expectStorageStateRejection(createRejectedHistoryDb(schema));
  });

  it.each([
    {
      name: "unknown automation_threads table",
      sql: "CREATE TABLE automation_threads (id TEXT PRIMARY KEY)",
    },
    {
      name: "unknown automation_runs trigger",
      sql: `CREATE TRIGGER automation_runs_hostile
        AFTER INSERT ON automation_runs BEGIN SELECT 1; END`,
    },
    {
      name: "unknown view",
      sql: "CREATE VIEW automation_hostile_view AS SELECT id FROM automations",
    },
    {
      name: "unknown index",
      sql: "CREATE INDEX automation_hostile_idx ON automations(name)",
    },
  ])("fails without mutation for $name", ({ sql }) => {
    const db = createRejectedHistoryDb();
    db.exec(sql);

    expectStorageStateRejection(db);
  });

  it.each([
    {
      name: "COLLATE NOCASE",
      from: "id TEXT PRIMARY KEY,\n     project_id TEXT NOT NULL",
      to: "id TEXT COLLATE NOCASE PRIMARY KEY,\n     project_id TEXT NOT NULL",
    },
    {
      name: "an extra CHECK constraint",
      from: "updated_at INTEGER NOT NULL\n   );",
      to: "updated_at INTEGER NOT NULL CHECK (updated_at >= 0)\n   );",
    },
    {
      name: "a deferred foreign key",
      from: "ON DELETE CASCADE,\n     run_mode TEXT NOT NULL",
      to: `ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
     run_mode TEXT NOT NULL`,
    },
  ])(
    "fails without mutation for table DDL containing $name",
    ({ from, to }) => {
      const schema = migrations[0]!.replace(from, to);
      expect(schema).not.toBe(migrations[0]);

      expectStorageStateRejection(createRejectedHistoryDb(schema));
    },
  );

  it("fails without mutation unless the parent migration marker pair is complete", () => {
    const db = new Database(":memory:");
    migrateByIndex(db, migrations.slice(0, 1));

    expectStorageStateRejection(db);
  });

  it.each([
    {
      name: "partial run table",
      sql: "CREATE TABLE automation_runs (id TEXT PRIMARY KEY)",
    },
    {
      name: "missing run table",
      sql: "CREATE TABLE unrelated (id TEXT PRIMARY KEY)",
    },
  ])("fails without mutation for $name", ({ sql }) => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE _bb_migrations (
      id INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO _bb_migrations (id, applied_at) VALUES (0, 1), (1, 1), (2, 1);
    ${sql};`);
    const before = schemaSnapshot(db);

    expect(() => reconcileTerminalTokenMigrationPreflight(db)).toThrow(
      STORAGE_STATE_ERROR,
    );
    expect(schemaSnapshot(db)).toEqual(before);
  });

  it("fails without mutation for an unproven migration history", () => {
    const db = new Database(":memory:");
    migrateByIndex(db, migrations.slice(0, 2));
    db.prepare("DELETE FROM _bb_migrations WHERE id = 0").run();
    const before = schemaSnapshot(db);

    expect(() => reconcileTerminalTokenMigrationPreflight(db)).toThrow(
      STORAGE_STATE_ERROR,
    );
    expect(schemaSnapshot(db)).toEqual(before);
    expect(migrationIds(db)).toEqual([1]);
  });

  it("keeps rows created before the migration domain-null", () => {
    const db = new Database(":memory:");
    migrateByIndex(db, migrations.slice(0, 2));
    db.exec(`INSERT INTO automations (
      id, project_id, name, enabled, trigger_type, trigger_config,
      run_mode, execution, origin, created_at, updated_at
    ) VALUES (
      'auto_legacy', 'proj_test', 'Legacy', 1, 'schedule',
      '{"triggerType":"schedule","cron":"* * * * *","timezone":"UTC"}',
      'agent',
      '{"mode":"agent","prompt":"Run","providerId":"codex","model":"gpt-5","permissionMode":"auto","environment":{"type":"project-default"}}',
      'human', 1, 1
    );
    INSERT INTO automation_runs (
      id, automation_id, run_mode, status, trigger, scheduled_for, started_at
    ) VALUES ('arun_legacy', 'auto_legacy', 'agent', 'succeeded', 'manual', 1, 1);`);

    reconcileTerminalTokenMigrationPreflight(db);
    migrateByIndex(db, migrations);

    expect(
      db
        .prepare("SELECT terminal_token AS terminalToken FROM automation_runs")
        .get(),
    ).toEqual({ terminalToken: null });
  });
});

describe("terminal token extraction", () => {
  it("extracts only a generic strict final non-empty line", () => {
    expect(extractTerminalToken("work\nTASK_COMPLETE\n\n")).toBe(
      "TASK_COMPLETE",
    );
    expect(extractTerminalToken("work\r\nDOMAIN_42\r\n  \r\n")).toBe(
      "DOMAIN_42",
    );
    expect(extractTerminalToken("TASK_COMPLETE\nmore output")).toBeNull();
    expect(extractTerminalToken("work\ntask_complete")).toBeNull();
    expect(extractTerminalToken("work\nTASK-COMPLETE")).toBeNull();
    expect(extractTerminalToken(`work\n${"A".repeat(129)}`)).toBeNull();
    expect(extractTerminalToken(null)).toBeNull();
  });

  it("stores a token only for successful script transport", () => {
    expect(
      mapScriptResultToRun({
        exitCode: 0,
        output: "detail\nTASK_COMPLETE\n",
        timedOut: false,
      }),
    ).toMatchObject({ status: "succeeded", terminalToken: "TASK_COMPLETE" });
    expect(
      mapScriptResultToRun({
        exitCode: 2,
        output: "detail\nTASK_COMPLETE\n",
        timedOut: false,
      }),
    ).toMatchObject({ status: "failed", terminalToken: null });
    expect(
      mapScriptResultToRun({
        exitCode: 0,
        output: "detail\nTASK_COMPLETE\n",
        timedOut: true,
      }),
    ).toMatchObject({ status: "failed", terminalToken: null });
    expect(
      mapScriptResultToRun({
        exitCode: 0,
        output: 'detail\n{"wakeAgent": false}\n',
        timedOut: false,
      }),
    ).toMatchObject({ status: "skipped", terminalToken: null });
  });
});

describe("terminal token storage", () => {
  it("suppresses non-success tokens and keeps running and legacy values null", () => {
    const db = createMigratedDb();
    createAgentAutomation(db);
    const running = createManualRun(db, {
      automationId: "auto_status",
      runMode: "agent",
      now: 1,
    }).run;
    const failed = createManualRun(db, {
      automationId: "auto_status",
      runMode: "agent",
      now: 2,
    }).run;
    const skipped = createManualRun(db, {
      automationId: "auto_status",
      runMode: "agent",
      now: 3,
    }).run;

    closeAutomationRun(db, {
      runId: failed.id,
      status: "failed",
      terminalToken: "TASK_COMPLETE",
      now: 4,
    });
    closeAutomationRun(db, {
      runId: skipped.id,
      status: "skipped",
      terminalToken: "TASK_COMPLETE",
      now: 5,
    });

    expect(
      listAutomationRuns(db, { automationId: "auto_status", limit: 10 }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: running.id, terminalToken: null }),
        expect.objectContaining({ id: failed.id, terminalToken: null }),
        expect.objectContaining({ id: skipped.id, terminalToken: null }),
      ]),
    );
  });

  it("makes close idempotent and preserves the first final state", () => {
    const db = createMigratedDb();
    createAgentAutomation(db);
    const run = createManualRun(db, {
      automationId: "auto_status",
      runMode: "agent",
      now: 1,
    }).run;

    const first = closeAutomationRun(db, {
      runId: run.id,
      status: "succeeded",
      terminalToken: "TASK_COMPLETE",
      now: 2,
    });
    const duplicate = closeAutomationRun(db, {
      runId: run.id,
      status: "failed",
      error: "late failure",
      terminalToken: "LATE_FAILURE",
      now: 3,
    });

    expect(first?.run).toMatchObject({
      status: "succeeded",
      terminalToken: "TASK_COMPLETE",
      finishedAt: 2,
    });
    expect(duplicate?.run).toEqual(first?.run);
  });
});
