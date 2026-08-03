import { z } from "zod";
import {
  attachFactoryWorkflow,
  cancelFactory,
  claimFactoryApproval,
  closeFactory,
  createFactory,
  failFactoryLaunch,
  getFactory,
  getOpenFactoryForThread,
  proposeFactoryBrief,
  recoverFactoryApprovals,
  syncFactoryFromWorkflow,
  type Db,
  type FactoryRow,
} from "./data.js";
import type { WorkflowService } from "./service.js";

const boundedText = z.string().trim().min(1).max(4_000);
const boundedList = z.array(z.string().trim().min(1).max(1_000)).max(20);

export const factoryBriefSchema = z
  .object({
    outcome: boundedText,
    userJourney: boundedText,
    acceptanceCriteria: boundedList.min(1),
    constraints: boundedList,
    nonGoals: boundedList,
    evidence: boundedList,
  })
  .strict();

export type FactoryBrief = z.infer<typeof factoryBriefSchema>;

export interface FactoryInspection extends FactoryRow {
  brief: FactoryBrief | null;
}

const PLAN_SCHEMA = `{
  type: "object",
  additionalProperties: false,
  required: ["summary", "steps", "risks"],
  properties: {
    summary: { type: "string", minLength: 1 },
    steps: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    risks: { type: "array", items: { type: "string", minLength: 1 } }
  }
}`;
const BUILD_SCHEMA = `{
  type: "object",
  additionalProperties: false,
  required: ["summary", "changedFiles", "checks"],
  properties: {
    summary: { type: "string", minLength: 1 },
    changedFiles: { type: "array", items: { type: "string", minLength: 1 } },
    checks: { type: "array", items: { type: "string", minLength: 1 } }
  }
}`;
const REVIEW_SCHEMA = `{
  type: "object",
  additionalProperties: false,
  required: ["approved", "summary", "blocking", "evidence"],
  properties: {
    approved: { type: "boolean" },
    summary: { type: "string", minLength: 1 },
    blocking: { type: "array", items: { type: "string", minLength: 1 } },
    evidence: { type: "array", items: { type: "string", minLength: 1 } }
  }
}`;
const FACTORY_OUTPUT_SCHEMA = `{
  type: "object",
  additionalProperties: false,
  required: ["build", "acceptance"],
  properties: {
    build: ${BUILD_SCHEMA},
    acceptance: ${REVIEW_SCHEMA}
  }
}`;

export const BUILT_IN_FACTORY_WORKFLOW_SOURCE = `export const meta = {
  name: "factory",
  description: "Turn an approved product shape into an independently reviewed candidate.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["request", "brief"],
    properties: {
      request: { type: "string", minLength: 1 },
      brief: {
        type: "object",
        additionalProperties: false,
        required: ["outcome", "userJourney", "acceptanceCriteria", "constraints", "nonGoals", "evidence"],
        properties: {
          outcome: { type: "string", minLength: 1 },
          userJourney: { type: "string", minLength: 1 },
          acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          constraints: { type: "array", items: { type: "string", minLength: 1 } },
          nonGoals: { type: "array", items: { type: "string", minLength: 1 } },
          evidence: { type: "array", items: { type: "string", minLength: 1 } }
        }
      }
    }
  },
  outputSchema: ${FACTORY_OUTPUT_SCHEMA},
  phases: [
    { title: "Plan", detail: "Translate the approved shape into an implementation path." },
    { title: "Build", detail: "Produce the complete candidate in the workspace." },
    { title: "Verify", detail: "Independently exercise the candidate against the approved shape." },
    { title: "Revise", detail: "Close verified blocking gaps once." },
    { title: "Acceptance", detail: "Re-run independent acceptance after revision." }
  ]
};
const context = JSON.stringify(args);
phase("Plan");
const plan = await agent(
  "Read the repository and approved Factory brief below. Do not edit files. Produce a concrete implementation plan grounded in existing code, commands, and behavior. Do not invent product decisions outside the brief. Context: " + context,
  { title: "Plan approved shape", outputSchema: ${PLAN_SCHEMA} }
);
phase("Build");
let build = await agent(
  "Implement the approved Factory brief completely in the current workspace. Read the repository instructions first. Use the plan as guidance, not authority. Run the repository-owned checks that cover your changes. Do not commit, push, merge, deploy, or weaken checks. Context: " + context + " Plan: " + JSON.stringify(plan),
  { title: "Build candidate", outputSchema: ${BUILD_SCHEMA} }
);
phase("Verify");
let review = await agent(
  "Act as a fresh acceptance verifier. Inspect the actual workspace and diff. Independently run the relevant repository checks and exercise the approved user journey where possible. Reject placeholders, mocked-only proof, missing states, stale checks, and claims without evidence. Context: " + context + " Builder report: " + JSON.stringify(build),
  { title: "Verify candidate", outputSchema: ${REVIEW_SCHEMA} }
);
if (!review.approved) {
  phase("Revise");
  build = await agent(
    "Revise the candidate to close every blocking acceptance finding. Inspect the actual workspace and rerun relevant checks. Do not broaden scope, commit, push, merge, or deploy. Context: " + context + " Prior build: " + JSON.stringify(build) + " Blocking review: " + JSON.stringify(review),
    { title: "Revise candidate", outputSchema: ${BUILD_SCHEMA} }
  );
  phase("Acceptance");
  review = await agent(
    "Re-run acceptance from fresh evidence after the revision. Inspect the actual workspace, rerun relevant checks, and judge only against the approved Factory brief. Reject unsupported claims. Context: " + context + " Revised builder report: " + JSON.stringify(build),
    { title: "Accept candidate", outputSchema: ${REVIEW_SCHEMA} }
  );
}
if (!review.approved) {
  throw new Error("Factory candidate did not pass independent acceptance: " + JSON.stringify(review.blocking));
}
return { build, acceptance: review };`;

function inspection(row: FactoryRow): FactoryInspection {
  return {
    ...row,
    brief:
      row.briefJson === null
        ? null
        : factoryBriefSchema.parse(JSON.parse(row.briefJson)),
  };
}

function requireThread(row: FactoryRow | null, threadId: string): FactoryRow {
  if (row === null || row.originThreadId !== threadId) {
    throw new Error("This Factory engagement is not available in this thread");
  }
  return row;
}

export interface FactoryService {
  start(input: {
    projectId: string;
    originThreadId: string;
    request: string;
  }): FactoryInspection;
  propose(id: string, threadId: string, brief: FactoryBrief): FactoryInspection;
  approve(id: string, threadId: string): Promise<FactoryInspection>;
  inspect(id: string): FactoryInspection | null;
  inspectOpenForThread(threadId: string): FactoryInspection | null;
  cancel(id: string, threadId: string): Promise<FactoryInspection>;
  close(id: string, threadId: string): FactoryInspection;
}

export function createFactoryService(
  db: Db,
  workflows: WorkflowService,
): FactoryService {
  recoverFactoryApprovals(db);

  function inspect(id: string): FactoryInspection | null {
    const row = getFactory(db, id);
    return row === null ? null : inspection(syncFactoryFromWorkflow(db, id));
  }

  return {
    start(input) {
      const request = boundedText.parse(input.request);
      return inspection(createFactory(db, { ...input, request }));
    },
    propose(id, threadId, value) {
      requireThread(getFactory(db, id), threadId);
      const brief = factoryBriefSchema.parse(value);
      const row = proposeFactoryBrief(db, id, JSON.stringify(brief));
      if (row === null) {
        throw new Error("Factory is not accepting a shape proposal");
      }
      return inspection(row);
    },
    async approve(id, threadId) {
      const current = requireThread(getFactory(db, id), threadId);
      if (
        current.status !== "awaiting_approval" ||
        current.briefJson === null
      ) {
        throw new Error("Factory is not awaiting approval");
      }
      const claimed = claimFactoryApproval(db, id);
      if (claimed === null)
        throw new Error("Factory approval was already handled");
      const brief = factoryBriefSchema.parse(JSON.parse(current.briefJson));
      try {
        const run = await workflows.start({
          projectId: current.projectId,
          originThreadId: current.originThreadId,
          source: BUILT_IN_FACTORY_WORKFLOW_SOURCE,
          args: { request: current.request, brief },
          resumedFromRunId: null,
        });
        const attached = attachFactoryWorkflow(db, id, run.id);
        if (attached === null) {
          await workflows.stop(run.id);
          throw new Error("Factory approval lost its launch claim");
        }
        return inspection(attached);
      } catch (error) {
        failFactoryLaunch(
          db,
          id,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
    inspect,
    inspectOpenForThread(threadId) {
      const row = getOpenFactoryForThread(db, threadId);
      return row === null ? null : inspect(row.id);
    },
    async cancel(id, threadId) {
      const current = requireThread(inspect(id), threadId);
      if (current.workflowRunId !== null && current.status === "running") {
        await workflows.stop(current.workflowRunId);
      }
      const row = cancelFactory(db, id);
      if (row === null)
        throw new Error("Factory engagement is already terminal");
      return inspection(row);
    },
    close(id, threadId) {
      requireThread(inspect(id), threadId);
      const row = closeFactory(db, id);
      if (row === null)
        throw new Error("Factory candidate is not ready to close");
      return inspection(row);
    },
  };
}
