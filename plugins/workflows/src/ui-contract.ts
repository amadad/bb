import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

export const factoryBriefViewSchema = z
  .object({
    outcome: z.string(),
    userJourney: z.string(),
    acceptanceCriteria: z.array(z.string()),
    constraints: z.array(z.string()),
    nonGoals: z.array(z.string()),
    evidence: z.array(z.string()),
  })
  .strict();

export const factoryStatusSchema = z.enum([
  "shaping",
  "awaiting_approval",
  "launching",
  "running",
  "candidate",
  "failed",
  "cancelled",
  "closed",
]);

export const factoryViewSchema = z
  .object({
    id: z.string(),
    request: z.string(),
    status: factoryStatusSchema,
    brief: factoryBriefViewSchema.nullable(),
    workflowRunId: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    approvedAt: z.number().nullable(),
  })
  .strict();

export const workflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const workflowCallStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const workflowCallViewSchema = z
  .object({
    id: z.string(),
    index: z.number().int().nonnegative(),
    label: z.string(),
    phase: z.string().nullable(),
    status: workflowCallStatusSchema,
    provider: z.string(),
    model: z.string(),
    reasoningLevel: z.string(),
    cached: z.boolean(),
    childThreadId: z.string().nullable(),
    providerRetryAttempts: z.number().int().nonnegative(),
    repairAttempts: z.number().int().nonnegative(),
    error: z.string().nullable(),
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
  })
  .strict();

export const workflowPhaseViewSchema = z
  .object({
    title: z.string(),
    detail: z.string().nullable(),
    calls: z.array(workflowCallViewSchema),
  })
  .strict();

export const workflowRunViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    status: workflowRunStatusSchema,
    currentPhase: z.string().nullable(),
    phases: z.array(workflowPhaseViewSchema),
    unphasedCalls: z.array(workflowCallViewSchema),
    resultAvailable: z.boolean(),
    error: z.string().nullable(),
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
  })
  .strict();

const runLookupInputSchema = z
  .object({
    threadId: z.string().trim().min(1),
    runId: z.string().trim().min(1).nullable(),
  })
  .strict();

const threadLookupInputSchema = z
  .object({ threadId: z.string().trim().min(1) })
  .strict();

export const workflowUiRpcContract = defineRpcContract({
  factoryOpenForThread: {
    input: threadLookupInputSchema,
    output: z.object({ factory: factoryViewSchema.nullable() }).strict(),
  },
  factoryApprove: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        factoryId: z.string().trim().min(1),
      })
      .strict(),
    output: z.object({ factory: factoryViewSchema }).strict(),
  },
  factoryCancel: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        factoryId: z.string().trim().min(1),
      })
      .strict(),
    output: z.object({ factory: factoryViewSchema }).strict(),
  },
  factoryClose: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        factoryId: z.string().trim().min(1),
      })
      .strict(),
    output: z.object({ factory: factoryViewSchema }).strict(),
  },
  workflowActiveRuns: {
    input: threadLookupInputSchema,
    output: z.object({ runs: z.array(workflowRunViewSchema) }).strict(),
  },
  workflowRunView: {
    input: runLookupInputSchema,
    output: z.object({ run: workflowRunViewSchema.nullable() }).strict(),
  },
  workflowStopRun: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        runId: z.string().trim().min(1),
      })
      .strict(),
    output: z
      .object({ stopped: z.boolean(), run: workflowRunViewSchema })
      .strict(),
  },
});

export type FactoryView = z.infer<typeof factoryViewSchema>;
export type WorkflowCallView = z.infer<typeof workflowCallViewSchema>;
export type WorkflowPhaseView = z.infer<typeof workflowPhaseViewSchema>;
export type WorkflowRunView = z.infer<typeof workflowRunViewSchema>;
