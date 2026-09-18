/**
 * #1717 security pass — the consultation/subscription detail PATCH used to
 * include `user: true` on both parties and return `result.data` verbatim, so
 * the other party's phone/address/DOB rode in the JSON. Source-level in the
 * #946 style: what matters is which select shape every user read uses.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { PARTY_USER_SELECT } from "@/lib/booking/list-selects";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const ROUTES = [
  "app/api/bookings/consultations/[consultationId]/route.ts",
  "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
];

const PII_KEYS = [
  "phone",
  "address",
  "dateOfBirth",
  "gender",
  "city",
  "country",
  "bio",
];

describe("request detail routes never read a bare user row", () => {
  it("the party allowlist carries identity only", () => {
    const keys = Object.keys(PARTY_USER_SELECT.select);
    expect(keys.sort()).toEqual(["email", "id", "image", "name"]);
    expect(keys.filter((k) => PII_KEYS.includes(k))).toEqual([]);
  });

  it.each(ROUTES)("%s selects every user through the allowlist", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/user:\s*true/);
    // Every `user:` read is either the shared fragment or an inline select
    // limited to the same four keys.
    const reads = Array.from(
      src.matchAll(/user:\s*(PARTY_USER_SELECT|\{\s*select:\s*\{([^}]*)\})/g),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const m of reads) {
      if (m[1] === "PARTY_USER_SELECT") continue;
      const keys = m[2]
        .split(",")
        .map((k) => k.split(":")[0].trim())
        .filter(Boolean);
      expect(keys.filter((k) => PII_KEYS.includes(k))).toEqual([]);
    }
    // The count of `user:` reads equals the count of allowlisted ones.
    const all = src.match(/\buser:\s*(true|\{|PARTY_USER_SELECT)/g) ?? [];
    expect(all.length).toBe(reads.length);
  });
});
