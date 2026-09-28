/**
 * @jest-environment node
 */

/**
 * #1851 — every handler under app/api/organizations/** authorizes through the
 * org permission matrix, and nothing there reads the rank ladder. A new
 * handler with neither a matrix key nor an allowlist entry below fails here.
 *
 * The same file pins the role sets the retired rank gates resolved to, so an
 * edit to the matrix that widens one of them fails loudly, and decision 9:
 * no org role deletes member content.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import type { MemberRole } from "@prisma/client";

import { ORG_PERMISSIONS, type OrgSurface } from "@/lib/auth/org-permissions";

const ROOT = join(process.cwd(), "app/api/organizations");

/** Handlers that are deliberately not role-gated, with the reason. */
const ALLOWLIST: Record<string, string> = {
  "route.ts#GET": "self: the caller's own orgs",
  "route.ts#POST": "self: creating an org makes the caller its OWNER",
  "public/route.ts#GET": "public directory",
  "invitations/accept/route.ts#POST": "self: the invitee accepts",
  "[orgId]/route.ts#GET":
    "any member reads the shell; redactOrgDetailsForRole shapes money by key",
  "[orgId]/consent/route.ts#POST": "self-only (#1527 decision 5)",
  "[orgId]/consent/route.ts#DELETE": "self-only (#1527 decision 5)",
  "[orgId]/checkout/consent-preview/route.ts#GET": "self: own checkout",
  "[orgId]/checkout/overage-preview/route.ts#GET": "self: own checkout",
  "[orgId]/members/route.ts#POST": "405: direct-add retired (#1846)",
  "[orgId]/documents/route.ts#GET": "libraryScopeFor reads operations.read",
  "[orgId]/recordings/route.ts#GET": "libraryScopeFor reads operations.read",
  ...Object.fromEntries(
    ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => [
      `[orgId]/members/bulk/route.ts#${m}`,
      "405 stub",
    ]),
  ),
};

const RANK_CHECK =
  /\bminimumRole\b|\bisAtLeastRole\b|\brequireOrgOwner\b|\brequireOrgBillingAdminOrOwner\b|\bORG_ROLE_RANK\b|requireOrgAccess\([^,)]+,\s*"[A-Z_]+"|\.role\s*[!=]==\s*"(OWNER|MAINTAINER|BILLING_ADMIN|MANAGER|SUPPORT)"/;
const MATRIX_CALL =
  /\bpermission:\s*(?:"[\w.]+"|\[|[A-Z_]+\b)|\bhasOrgPermission\(|\bhasAnyOrgPermission\(/;
const HANDLER =
  /^export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE)\b/gm;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

/**
 * Source without comments, so a comment naming a key never counts as a gate
 * (and a comment naming a retired helper never fails the rank check). The
 * `[^:]` keeps a URL's `//` inside a string.
 */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Each exported handler's source, up to the next top-level export. */
function handlers(src: string): Array<[method: string, body: string]> {
  const starts = [...src.matchAll(HANDLER)];
  return starts.map((m, i) => {
    const end = starts[i + 1]?.index ?? src.length;
    return [m[1], src.slice(m.index, end)];
  });
}

const routes = routeFiles(ROOT).map((path) => ({
  rel: relative(ROOT, path),
  src: code(readFileSync(path, "utf8")),
}));

describe("every org route reads the matrix (#1851)", () => {
  it("no file under app/api/organizations reads the rank ladder", () => {
    const offenders = routes
      .filter(({ src }) => RANK_CHECK.test(src))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("every handler names a matrix key or is allowlisted with a reason", () => {
    const seen = new Set<string>();
    const missing: string[] = [];
    for (const { rel, src } of routes) {
      for (const [method, body] of handlers(src)) {
        const id = `${rel}#${method}`;
        seen.add(id);
        if (!ALLOWLIST[id] && !MATRIX_CALL.test(body)) missing.push(id);
      }
    }
    expect(missing).toEqual([]);
    // A stale entry would silently exempt a future handler at that path.
    expect(Object.keys(ALLOWLIST).filter((id) => !seen.has(id))).toEqual([]);
    expect(seen.size).toBeGreaterThan(120);
  });
});

describe("the retired rank gates keep their resolved roles (#1851)", () => {
  const RANK: Record<MemberRole, number> = {
    OWNER: 100,
    MAINTAINER: 80,
    BILLING_ADMIN: 70,
    MANAGER: 60,
    EXPERT: 40,
    SUPPORT: 30,
    LEARNER: 20,
  };
  const ALL = Object.keys(RANK) as MemberRole[];
  const floor = (min: MemberRole) =>
    ALL.filter((r) => RANK[r] >= RANK[min]).sort();
  const ownerOrBillingAdmin = ["BILLING_ADMIN", "OWNER"];

  it.each<[OrgSurface, string[]]>([
    ["billing.read", floor("MANAGER")],
    ["invitations.manage", floor("MAINTAINER")],
    ["members.manage", floor("MAINTAINER")],
    ["settings.verification.resubmit", floor("MAINTAINER")],
    ["settings.manage", floor("MAINTAINER")],
    ["identity.manage", floor("OWNER")],
    ["org.delete", floor("OWNER")],
    ["settings.ownerFields", floor("OWNER")],
    ["settings.cancellationPolicy.publish", floor("OWNER")],
    ["payouts.account.manage", floor("OWNER")],
    ["webhooks.rotateSecret", floor("OWNER")],
    ["webhooks.delete", floor("OWNER")],
    ["members.role.grant.governance", floor("OWNER")],
    ["members.remove.force", floor("OWNER")],
    ["billing.manage", ownerOrBillingAdmin],
    ["purchaseOrders.manage", ownerOrBillingAdmin],
    ["payouts.manage", ownerOrBillingAdmin],
    ["integrations.manage", ownerOrBillingAdmin],
    ["billing.fundingSource.switch", ownerOrBillingAdmin],
    ["members.payoutRecipient.change", ownerOrBillingAdmin],
    ["payouts.approve", ownerOrBillingAdmin],
    ["appointments.allocate.calendarRead", floor("MAINTAINER")],
    ["webhooks.subscribe.memberEvents", ["OWNER"]],
  ])("%s", (key, roles) => {
    expect([...ORG_PERMISSIONS[key]].sort()).toEqual(roles);
  });
});

describe("no org role deletes member content (#1851 decision 9)", () => {
  it("the key is empty and no org route deletes an upload or a recording", () => {
    expect(ORG_PERMISSIONS["memberContent.delete"].size).toBe(0);
    const deletes = routes.flatMap(({ rel, src }) =>
      handlers(src)
        .filter(
          ([m, body]) =>
            m === "DELETE" && /appointmentDocument|recording/i.test(body),
        )
        .map(() => rel),
    );
    expect(deletes).toEqual([]);
  });

  it.each([
    "app/api/appointments/[appointmentId]/documents/[documentId]/route.ts",
    "app/api/stream/recordings/[recordingId]/publish/route.ts",
    "app/api/stream/recordings/[recordingId]/preview/route.ts",
  ])("%s DELETE never consults an org role", (file) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    const del = handlers(src).find(([m]) => m === "DELETE")?.[1] ?? "";
    expect(del).not.toBe("");
    expect(del).not.toMatch(/requireOrgAccess|OrgPermission|membership/i);
  });
});
