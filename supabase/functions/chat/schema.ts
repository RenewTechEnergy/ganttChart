// Shared contract types + normalisation. No I/O here — pure data shaping so
// every provider (OpenRouter, Anthropic, future) produces the same output.

export const MODEL_KEYS = ["haiku", "sonnet", "opus"] as const;
export type ModelKey = typeof MODEL_KEYS[number];

export type Operation =
  | "shift_item"
  | "create_project_candidate"
  | "create_item"
  | "update_item"
  | "update_progress"
  | "assign_owner"
  | "add_dependency"
  | "delete_item"
  | "query_schedule"
  | "N/A";

export type Confidence = "high" | "medium" | "low";

export type Target = {
  project: string;
  item: string;
  item_type: "project" | "task" | "subtask" | "unknown" | "N/A";
  parent: string;
};

export type Parameters = {
  direction: "earlier" | "later" | "N/A";
  amount: number | "N/A";
  unit: "days" | "weeks" | "months" | "N/A";
  date: string;
  deadline: string;
  duration: string;
  owner: string;
  status: string;
  percent_done: number | "N/A";
  budget: string;
  capacity: string;
  project_type: string;
  scheduling_goal: string;
  predecessor: string;
  predecessors: string[];
  new_name: string;
  preferred_start: string;
};

export type Reasoning = {
  requires_schedule_computation: boolean;
  requires_dependency_check: boolean;
  requires_capacity_check: boolean;
  requires_user_confirmation: boolean;
};

export type ExtractedOperation = {
  operation: Operation;
  target: Target;
  parameters: Parameters;
  reasoning: Reasoning;
  confidence: Confidence;
  needs_clarification: boolean;
  missing_fields: string[];
};

export const fallbackExtraction: ExtractedOperation = {
  operation: "N/A",
  target: { project: "N/A", item: "N/A", item_type: "N/A", parent: "N/A" },
  parameters: {
    direction: "N/A", amount: "N/A", unit: "N/A", date: "N/A",
    deadline: "N/A", duration: "N/A", owner: "N/A", status: "N/A",
    percent_done: "N/A", budget: "N/A", capacity: "N/A",
    project_type: "N/A", scheduling_goal: "N/A", predecessor: "N/A",
    predecessors: [], new_name: "N/A", preferred_start: "N/A",
  },
  reasoning: {
    requires_schedule_computation: false,
    requires_dependency_check: false,
    requires_capacity_check: false,
    requires_user_confirmation: false,
  },
  confidence: "low",
  needs_clarification: false,
  missing_fields: [],
};

const OPERATION_VALUES: Operation[] = [
  "shift_item", "create_project_candidate", "create_item", "update_item",
  "update_progress", "assign_owner", "add_dependency", "delete_item",
  "query_schedule", "N/A",
];

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function strOrNA(v: unknown): string {
  return isStr(v) && v.trim() ? v.trim() : "N/A";
}

function numOrNA(v: unknown): number | "N/A" {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (isStr(v) && v.trim() && v.trim() !== "N/A") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return "N/A";
}

export function normaliseOperation(value: unknown): ExtractedOperation {
  if (!value || typeof value !== "object") return fallbackExtraction;
  const obj = value as Record<string, unknown>;

  const operation: Operation =
    isStr(obj.operation) && (OPERATION_VALUES as string[]).includes(obj.operation)
      ? (obj.operation as Operation)
      : "N/A";

  const t = (obj.target && typeof obj.target === "object") ? obj.target as Record<string, unknown> : {};
  const itemTypeVal = strOrNA(t.item_type);
  const itemType: Target["item_type"] =
    itemTypeVal === "project" || itemTypeVal === "task" ||
    itemTypeVal === "subtask" || itemTypeVal === "unknown"
      ? itemTypeVal
      : "N/A";

  const target: Target = {
    project: strOrNA(t.project),
    item: strOrNA(t.item),
    item_type: itemType,
    parent: strOrNA(t.parent),
  };

  const p = (obj.parameters && typeof obj.parameters === "object") ? obj.parameters as Record<string, unknown> : {};
  const dirVal = strOrNA(p.direction);
  const direction: Parameters["direction"] =
    dirVal === "earlier" || dirVal === "later" ? dirVal : "N/A";
  const unitVal = strOrNA(p.unit);
  const unit: Parameters["unit"] =
    unitVal === "days" || unitVal === "weeks" || unitVal === "months" ? unitVal : "N/A";

  const predecessors: string[] = Array.isArray(p.predecessors)
    ? p.predecessors.filter(isStr).map((s) => s.trim()).filter((s) => s && s !== "N/A")
    : [];

  const parameters: Parameters = {
    direction,
    amount: numOrNA(p.amount),
    unit,
    date: strOrNA(p.date),
    deadline: strOrNA(p.deadline),
    duration: strOrNA(p.duration),
    owner: strOrNA(p.owner),
    status: strOrNA(p.status),
    percent_done: numOrNA(p.percent_done),
    budget: strOrNA(p.budget),
    capacity: strOrNA(p.capacity),
    project_type: strOrNA(p.project_type),
    scheduling_goal: strOrNA(p.scheduling_goal),
    predecessor: strOrNA(p.predecessor),
    predecessors,
    new_name: strOrNA(p.new_name),
    preferred_start: strOrNA(p.preferred_start),
  };

  const r = (obj.reasoning && typeof obj.reasoning === "object") ? obj.reasoning as Record<string, unknown> : {};
  const reasoning: Reasoning = {
    requires_schedule_computation: !!r.requires_schedule_computation,
    requires_dependency_check:     !!r.requires_dependency_check,
    requires_capacity_check:       !!r.requires_capacity_check,
    requires_user_confirmation:    !!r.requires_user_confirmation,
  };

  const confidence: Confidence =
    obj.confidence === "high" || obj.confidence === "medium" || obj.confidence === "low"
      ? obj.confidence
      : "low";

  const needs_clarification = !!obj.needs_clarification;
  const missing_fields = Array.isArray(obj.missing_fields)
    ? obj.missing_fields.filter(isStr).map((s) => s.trim()).filter(Boolean)
    : [];

  return { operation, target, parameters, reasoning, confidence, needs_clarification, missing_fields };
}

export function extractJsonFromModelText(text: string): unknown {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// Parses a raw LLM completion into a normalised operations array. Accepts:
//   - { operations: [op1, op2, ...] }  (preferred, multi-op-aware)
//   - [op1, op2, ...]                  (bare array)
//   - { operation: "...", ... }        (legacy single-op object)
export function parseCompletion(content: string): ExtractedOperation[] {
  const parsed = extractJsonFromModelText(content);
  let ops: ExtractedOperation[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.operations)) {
      ops = (obj.operations as unknown[]).map(normaliseOperation);
    } else if (Array.isArray(parsed)) {
      ops = (parsed as unknown[]).map(normaliseOperation);
    } else {
      ops = [normaliseOperation(parsed)];
    }
  } else {
    ops = [fallbackExtraction];
  }
  if (!ops.length) ops = [fallbackExtraction];
  return ops;
}
