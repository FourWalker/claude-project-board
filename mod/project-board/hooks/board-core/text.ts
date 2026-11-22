// @effect-diagnostics globalDate:off globalRandom:off
/**
 * Path and text helpers shared by the board's store, context and tools. Paths are kept in the
 * board's own form: forward slashes, no trailing slash, upper-case drive letter.
 *
 * @module board-core/text
 */

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";

export const norm = (p: string): string =>
  p
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^([a-z]):/, (_m: string, d: string) => d.toUpperCase() + ":");

export const base = (p: string): string =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || p;

export const parent = (p: string): string =>
  /^[A-Za-z]:\/?$|^\/$/.test(p)
    ? ""
    : (p.replace(/\/[^/]*$/, "") || "/").replace(/^([A-Za-z]:)$/, "$1/");

export const clip = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;

export const firstPara = (s: string): string =>
  s
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)
    .map((x) =>
      x
        .replace(/[#*_`>|]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((x) => x.length > 0) ?? "";

export const sameRoot = (a?: string, b?: string): boolean =>
  !!a && !!b && norm(a).toLowerCase() === norm(b).toLowerCase();

/** `true` when `dir` is `root` or inside it (case-insensitive, like Windows paths). */
export const isInside = (dir: string, root: string): boolean => {
  const c = norm(dir).toLowerCase();
  const r = norm(root).toLowerCase();
  return c === r || c.startsWith(r + "/");
};

/** The board app's file-name rule (app/server.js `safe`): both sides must name a record alike. */
export const safeFileName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "");

export const stamp = (at: number): string =>
  new Date(at).toISOString().replace("T", " ").slice(0, 16);
