// Shared helpers for __tests__/security/consultant-projection-*.test.ts.
import { readFileSync } from "fs";
import { join } from "path";

/** Repo file contents with block and full-line comments stripped. */
export const readSource = (rel: string) =>
  readFileSync(join(__dirname, "../..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Every value stored under `key`, at any depth of a captured Prisma args tree. */
export function valuesAtKey(node: unknown, key: string): unknown[] {
  if (Array.isArray(node)) return node.flatMap((n) => valuesAtKey(n, key));
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) => [
    ...(k === key ? [v] : []),
    ...valuesAtKey(v, key),
  ]);
}

export function hasKey(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => hasKey(n, key));
  if (typeof node !== "object" || node === null) return false;
  return Object.entries(node).some(([k, v]) => k === key || hasKey(v, key));
}

/** Every key name present at any depth. */
export function allKeys(node: unknown, keys: string[] = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => allKeys(item, keys));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      keys.push(key);
      allKeys(value, keys);
    }
  }
  return keys;
}

/** Every value found under a `consultantProfile` key, at any depth. */
export const consultantProfileValues = (node: unknown) =>
  valuesAtKey(node, "consultantProfile");

/** A `consultantProfile` value that is `true` or carries an `include`. */
export const isBare = (value: unknown) =>
  value === true ||
  (typeof value === "object" && value !== null && "include" in value);

/** Asserts at least one consultantProfile is captured and none is bare; returns them. */
export function expectNoBareProfile(args: unknown) {
  const profiles = valuesAtKey(args, "consultantProfile");
  expect(profiles.length).toBeGreaterThan(0);
  expect(profiles).not.toContain(true);
  expect(profiles.some((p) => hasKey(p, "include"))).toBe(false);
  return profiles;
}
