export type BenchmarkPlan = {
  version: 1;
  spaces: Array<{ id: string; bounds: [number, number, number, number]; designCfm: number }>;
  equipment: Array<{ id: string; kind: "ahu" }>;
  terminals: Array<{ id: string; spaceId: string; position: [number, number]; cfm: number; connections: string[] }>;
  segments: Array<{ id: string; diameterIn: number; connections: string[] }>;
};

export type BenchmarkTaskId = "T1" | "T2" | "T3" | "T4" | "T5" | "T6";
export type BenchmarkTask = {
  id: BenchmarkTaskId;
  prompt: string;
  promptVariants?: Record<string, string>;
  target: Record<string, unknown>;
  approvedMutation: {
    paths: string[];
    additions?: Partial<Record<"spaces" | "equipment" | "terminals" | "segments", string[]>>;
  };
};

export type Finding = {
  severity: "error" | "warning";
  check: string;
  itemId?: string;
  spaceId?: string;
  [key: string]: unknown;
};

export type ValidationReport = {
  errors: Finding[];
  warnings: Finding[];
  findings: Finding[];
};

export type GradeResult = {
  taskId: BenchmarkTaskId;
  passed: boolean;
  target: { baselineFailed: boolean; resolved: boolean };
  mutationGuard: { passed: boolean; violations: string[] };
  baseline: ValidationReport;
  current: ValidationReport;
  newErrors: Finding[];
};

export class BenchmarkInputError extends Error {}
export function validatePlan(value: unknown): BenchmarkPlan;
export function validateTask(value: unknown): BenchmarkTask;
export function report(plan: unknown, task?: unknown): ValidationReport;
export function grade(task: unknown, starter: unknown, candidate: unknown): GradeResult;
export const fixtureRoot: string;
export const resultsRoot: string;
export const TASK_IDS: readonly BenchmarkTaskId[];
export function fixtureSets(root?: string): string[];
export function verifyFixtures(root?: string): { passed: true; files: string[] };
export function verifyRecordedResults(root?: string): { passed: true; files: string[] };
export type { RoundDuctSize } from "@mep/hvac-domain";
export function sizeSegment(input: { cfm: number; airflowType: import("@mep/hvac-domain").AirflowType; role: import("@mep/hvac-domain").DuctRole }): import("@mep/hvac-domain").RoundDuctSize;
