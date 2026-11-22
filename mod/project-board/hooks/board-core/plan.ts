/**
 * The plan.md format: phases as `## Phase A — name` headings, steps as `- [ ] A1 name` checkboxes.
 * The first unchecked step is the next step.
 *
 * @module board-core/plan
 */
import { firstPara } from "./text.ts";

const STEP =
  /^(\s*[-*]\s+\[)([ xX])(\]\s+)([A-Za-z]*\d+[A-Za-z0-9.]*|[A-Z][A-Za-z0-9.]*)[:.)]?\s*(.*)$/;

export interface PlanStep {
  readonly id: string;
  readonly text: string;
}

export function nextStep(plan: string): PlanStep | null {
  for (const line of plan.split(/\r?\n/)) {
    const m = STEP.exec(line);
    if (m && m[2] === " ")
      return { id: m[4] ?? "", text: (m[5] ?? "").replace(/\s*→\s*\(task [A-Za-z0-9-]+\)/, "") };
  }
  return null;
}

export function tickStep(plan: string, id: string): string {
  return plan
    .split(/\r?\n/)
    .map((line) => {
      const m = STEP.exec(line);
      return m && (m[4] ?? "").toLowerCase() === id.toLowerCase()
        ? line.replace(/\[ \]/, "[x]")
        : line;
    })
    .join("\n");
}

/** Marks a parent plan step as taken over by a subtask: `- [ ] A2 name → (task <id>)`. */
export function markStepDelegated(plan: string, stepId: string, taskId: string): string {
  return plan
    .split(/\r?\n/)
    .map((line) => {
      const m = STEP.exec(line);
      return m && (m[4] ?? "").toLowerCase() === stepId.toLowerCase() && !line.includes("(task ")
        ? `${line} → (task ${taskId})`
        : line;
    })
    .join("\n");
}

/** The `Objective:` / `Goal:` line of a handoff or plan, else its first paragraph. */
export const objectiveLine = (md: string): string =>
  (
    md.split(/\r?\n/).find((l) => /^\s*(objective|goal)\s*:/i.test(l)) ??
    firstPara(md.replace(/<!--[\s\S]*?-->/g, ""))
  ).trim();
