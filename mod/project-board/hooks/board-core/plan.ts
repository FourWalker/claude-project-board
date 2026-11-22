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

export interface PlanPhase {
  readonly title: string;
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly done: boolean;
    /** The subtask that took the step over (`→ (task <id>)`). */
    readonly childId: string | null;
  }>;
}

/** The plan's phases (`##`/`###` headings) and their steps; steps before any heading go in "Plan". */
export function planPhases(plan: string): ReadonlyArray<PlanPhase> {
  const phases: Array<{ title: string; steps: Array<PlanPhase["steps"][number]> }> = [];
  for (const line of plan.split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.*)$/.exec(line);
    if (heading) {
      phases.push({ title: (heading[1] ?? "").trim(), steps: [] });
      continue;
    }
    const m = STEP.exec(line);
    if (!m) continue;
    if (phases.length === 0) phases.push({ title: "Plan", steps: [] });
    const text = m[5] ?? "";
    phases.at(-1)?.steps.push({
      id: m[4] ?? "",
      text: text.replace(/\s*→\s*\(task [A-Za-z0-9-]+\)/, ""),
      done: m[2] !== " ",
      childId: /→\s*\(task ([A-Za-z0-9-]+)\)/.exec(text)?.[1] ?? null,
    });
  }
  return phases.filter((phase) => phase.steps.length > 0);
}

/** How many of the plan's steps are ticked, out of all of them. */
export function planProgress(plan: string): { readonly done: number; readonly total: number } {
  let done = 0;
  let total = 0;
  for (const line of plan.split(/\r?\n/)) {
    const m = STEP.exec(line);
    if (!m) continue;
    total++;
    if (m[2] !== " ") done++;
  }
  return { done, total };
}

export function tickStep(plan: string, id: string): string {
  return setStepDone(plan, id, true);
}

/** Ticks or unticks step `id`. */
export function setStepDone(plan: string, id: string, done: boolean): string {
  return plan
    .split(/\r?\n/)
    .map((line) => {
      const m = STEP.exec(line);
      if (!m || (m[4] ?? "").toLowerCase() !== id.toLowerCase()) return line;
      return done ? line.replace(/\[ \]/, "[x]") : line.replace(/\[[xX]\]/, "[ ]");
    })
    .join("\n");
}

/** Whether step `id` is ticked; null when the plan has no such step. */
export function stepDone(plan: string, id: string): boolean | null {
  for (const line of plan.split(/\r?\n/)) {
    const m = STEP.exec(line);
    if (m && (m[4] ?? "").toLowerCase() === id.toLowerCase()) return m[2] !== " ";
  }
  return null;
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

/**
 * Ticks (or, for a reopened subtask, unticks) the parent steps a subtask took over: the ones
 * marked `→ (task <id>)`.
 */
export function setDelegatedDone(plan: string, taskId: string, done: boolean): string {
  const marker = `→ (task ${taskId})`;
  return plan
    .split(/\r?\n/)
    .map((line) =>
      STEP.test(line) && line.trimEnd().endsWith(marker)
        ? done
          ? line.replace(/\[ \]/, "[x]")
          : line.replace(/\[[xX]\]/, "[ ]")
        : line,
    )
    .join("\n");
}

/** The `Objective:` / `Goal:` line of a handoff or plan, else its first paragraph. */
export const objectiveLine = (md: string): string =>
  (
    md.split(/\r?\n/).find((l) => /^\s*(objective|goal)\s*:/i.test(l)) ??
    firstPara(md.replace(/<!--[\s\S]*?-->/g, ""))
  ).trim();
