import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRun, getRun, migrations, settleRun } from "./data.js";
import {
  BUILT_IN_FACTORY_WORKFLOW_SOURCE,
  createFactoryService,
} from "./factory.js";
import { parseWorkflowSource } from "./parser.js";
import { executeWorkflowScript } from "./runtime.js";
import type { WorkflowService } from "./service.js";
import type { JsonValue } from "./types.js";

function workflowStub(db: Database.Database): WorkflowService {
  return {
    start: vi.fn(async (input) => {
      expect(input.source).toBe(BUILT_IN_FACTORY_WORKFLOW_SOURCE);
      return createRun(db, {
        factoryId: input.factoryId,
        projectId: input.projectId,
        originThreadId: input.originThreadId,
        environmentId: "environment-1",
        originProvider: "codex",
        originModel: "gpt-test",
        originReasoningLevel: "medium",
        originPermissionMode: "full",
        name: "Factory",
        source: input.source,
        sourceHash: "hash",
        argsJson: JSON.stringify(input.args),
        settingsJson:
          '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}',
        resumedFromRunId: null,
      });
    }),
    get: (id) => getRun(db, id),
    inspect: () => null,
    inspectPage: () => null,
    inspectLatestForThread: () => null,
    inspectActiveForThread: () => [],
    list: () => [],
    stop: vi.fn(async () => true),
    updateSettings: () => undefined,
    runWorker: async () => undefined,
    onThreadIdle: () => undefined,
    onThreadFailed: () => undefined,
    onThreadDeleted: () => undefined,
    submitStructuredResult: async () => ({ ok: true }),
    agentConfiguration: () => null,
  };
}

const brief = {
  outcome: "A first-run journey that reaches useful value",
  userJourney:
    "A new user completes one useful action without setup confusion.",
  acceptanceCriteria: ["The primary journey works end to end"],
  constraints: ["Preserve existing accounts"],
  nonGoals: ["Redesigning account settings"],
  evidence: ["The current onboarding route was inspected"],
};

describe("Factory lifecycle service", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });

  afterEach(() => db.close());

  it("ships one bounded provider-independent factory workflow", () => {
    const parsed = parseWorkflowSource(BUILT_IN_FACTORY_WORKFLOW_SOURCE);
    expect(parsed.metadata).toMatchObject({
      name: "factory",
      phases: [
        { title: "Plan" },
        { title: "Build" },
        { title: "Verify" },
        { title: "Revise" },
        { title: "Acceptance" },
      ],
    });
    expect(parsed.metadata.outputSchema).toMatchObject({
      required: ["build", "acceptance"],
    });
    expect(parsed.body.match(/agent\(/g)).toHaveLength(5);
  });

  it("returns builder and fresh acceptance evidence after one bounded revision", async () => {
    const parsed = parseWorkflowSource(BUILT_IN_FACTORY_WORKFLOW_SOURCE);
    const plan = { summary: "Plan", steps: ["Build it"], risks: [] };
    const firstBuild = {
      summary: "First build",
      changedFiles: ["src/app.ts"],
      checks: ["tests passed"],
    };
    const rejected = {
      approved: false,
      summary: "Missing empty state",
      blocking: ["Add the empty state"],
      evidence: ["Inspected src/app.ts"],
    };
    const revisedBuild = {
      summary: "Revised build",
      changedFiles: ["src/app.ts"],
      checks: ["tests passed again"],
    };
    const accepted = {
      approved: true,
      summary: "Accepted",
      blocking: [],
      evidence: ["Exercised the primary journey"],
    };
    const outputs: JsonValue[] = [
      plan,
      firstBuild,
      rejected,
      revisedBuild,
      accepted,
    ];
    const phase = vi.fn();
    const result = await executeWorkflowScript({
      args: { request: "Improve onboarding", brief },
      body: parsed.body,
      capabilities: {
        agent: async () => outputs.shift() ?? null,
        log: vi.fn(),
        phase,
      },
    });

    expect(result).toEqual({ build: revisedBuild, acceptance: accepted });
    expect(phase.mock.calls.map(([name]) => name)).toEqual([
      "Plan",
      "Build",
      "Verify",
      "Revise",
      "Acceptance",
    ]);
    expect(outputs).toEqual([]);
  });

  it("returns a rejected candidate as a product result, not a runtime failure", async () => {
    const parsed = parseWorkflowSource(BUILT_IN_FACTORY_WORKFLOW_SOURCE);
    const rejected = {
      approved: false,
      summary: "Still missing the empty state",
      blocking: ["Add the empty state"],
      evidence: ["Inspected src/app.ts"],
    };
    const outputs: JsonValue[] = [
      { summary: "Plan", steps: ["Build it"], risks: [] },
      { summary: "Build", changedFiles: ["src/app.ts"], checks: [] },
      rejected,
      { summary: "Revision", changedFiles: ["src/app.ts"], checks: [] },
      rejected,
    ];

    await expect(
      executeWorkflowScript({
        args: { request: "Improve onboarding", brief },
        body: parsed.body,
        capabilities: {
          agent: async () => outputs.shift() ?? null,
          log: vi.fn(),
          phase: vi.fn(),
        },
      }),
    ).resolves.toEqual({
      build: {
        summary: "Revision",
        changedFiles: ["src/app.ts"],
        checks: [],
      },
      acceptance: rejected,
    });
  });

  it("requires a frozen brief and the configured approval authority before launching", async () => {
    const workflows = workflowStub(db);
    const factory = createFactoryService(db, workflows);
    const engagement = factory.start({
      projectId: "project-1",
      originThreadId: "thread-1",
      request: "Improve onboarding",
    });

    await expect(
      factory.approve(engagement.id, "thread-1", "user"),
    ).rejects.toThrow(/awaiting approval/i);
    expect(workflows.start).not.toHaveBeenCalled();

    await factory.propose(engagement.id, "thread-1", brief);
    await expect(
      factory.approve(engagement.id, "thread-1", "agent"),
    ).rejects.toThrow(/Light Factory requires user approval/i);
    const running = await factory.setApprovalMode(
      engagement.id,
      "thread-1",
      "agent",
    );
    expect(running).toMatchObject({
      status: "running",
      workflowRunId: expect.stringMatching(/^wfr_/),
      brief,
    });
    expect(workflows.start).toHaveBeenCalledWith({
      projectId: "project-1",
      originThreadId: "thread-1",
      source: BUILT_IN_FACTORY_WORKFLOW_SOURCE,
      args: { request: "Improve onboarding", brief },
      resumedFromRunId: null,
      factoryId: engagement.id,
    });
  });

  it("keeps settled success when cancellation loses the completion race", async () => {
    const workflows = workflowStub(db);
    const factory = createFactoryService(db, workflows);
    const engagement = factory.start({
      projectId: "project-1",
      originThreadId: "thread-1",
      request: "Build it",
    });
    await factory.propose(engagement.id, "thread-1", brief);
    const running = await factory.approve(engagement.id, "thread-1", "user");
    vi.mocked(workflows.stop).mockImplementationOnce(async (runId) => {
      settleRun(db, {
        id: runId,
        status: "succeeded",
        result: {
          build: { summary: "Built", changedFiles: [], checks: [] },
          acceptance: {
            approved: true,
            summary: "Accepted",
            blocking: [],
            evidence: [],
          },
        },
        error: null,
      });
      return false;
    });

    await expect(
      factory.cancel(engagement.id, "thread-1"),
    ).resolves.toMatchObject({
      id: engagement.id,
      workflowRunId: running.workflowRunId,
      status: "candidate",
    });
  });

  it("binds thread access and stops the linked workflow", async () => {
    const workflows = workflowStub(db);
    const factory = createFactoryService(db, workflows);
    const engagement = factory.start({
      projectId: "project-1",
      originThreadId: "thread-1",
      request: "Build it",
    });
    await expect(
      factory.propose(engagement.id, "other-thread", brief),
    ).rejects.toThrow(/not available/i);
    await factory.propose(engagement.id, "thread-1", brief);
    await factory.approve(engagement.id, "thread-1", "user");
    await factory.cancel(engagement.id, "thread-1");
    expect(workflows.stop).toHaveBeenCalledWith(expect.stringMatching(/^wfr_/));
  });
});
