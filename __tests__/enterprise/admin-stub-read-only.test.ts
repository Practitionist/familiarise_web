/**
 * @jest-environment node
 */

/**
 * A platform ADMIN reaches org routes only as a read-only OWNER stub: every
 * gate without `readOnly` refuses them, and `readOnly` appears only in GET
 * handlers and server pages, so no org write path admits the stub.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const mockMembershipFindUnique = jest.fn();

jest.mock("../../lib/auth-session-lookup", () => ({
  __esModule: true,
  lookupSession: async () => ({
    kind: "found",
    session: {
      user: { id: "admin-1", role: "ADMIN", twoFactorEnabled: true },
    },
  }),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organization: {
      findUnique: async () => ({
        id: "org-1",
        status: "ACTIVE",
        canSponsor: true,
        canHost: true,
        billingAccount: null,
      }),
    },
    membership: {
      findUnique: (...a: unknown[]) => mockMembershipFindUnique(...a),
    },
  },
}));

import { requireOrgAccess } from "@/lib/auth-helpers";

describe("requireOrgAccess for a platform ADMIN", () => {
  it("grants the OWNER stub on a readOnly gate", async () => {
    const res = await requireOrgAccess("org-1", {
      readOnly: true,
      permission: "billing.read",
    });
    if (res.error) throw new Error("expected the read to pass");
    expect(res.member.id).toBe("__admin_stub_admin-1");
    expect(res.member.role).toBe("OWNER");
    expect(mockMembershipFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ permission: "billing.manage" as const }],
    [{ permission: "members.manage" as const, requireActive: true as const }],
  ])("refuses a gate without readOnly (%o)", async (gate) => {
    const res = await requireOrgAccess("org-1", gate);
    expect(res.error?.status).toBe(403);
    expect(await res.error?.json()).toMatchObject({ code: "ADMIN_READ_ONLY" });
  });
});

const HANDLER =
  /^export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE)\b/gm;
const TOP_LEVEL_FN =
  /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/gm;

function files(dir: string, name: RegExp): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return files(path, name);
    return name.test(entry) ? [path] : [];
  });
}

describe("readOnly gates sit only on reads", () => {
  it("every readOnly gate under app/api is inside an exported GET handler", () => {
    const offenders: string[] = [];
    for (const path of files(join(process.cwd(), "app/api"), /^route\.ts$/)) {
      const src = readFileSync(path, "utf8");
      const tops = [...src.matchAll(TOP_LEVEL_FN)];
      for (const m of src.matchAll(/\breadOnly:\s*true\b/g)) {
        const owner = tops.filter((t) => (t.index ?? 0) < (m.index ?? 0)).pop();
        const isGet =
          !!owner &&
          (owner[1] ?? owner[2]) === "GET" &&
          owner[0].startsWith("export");
        if (!isGet) offenders.push(relative(process.cwd(), path));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no write handler under app/api/organizations declares readOnly", () => {
    const root = join(process.cwd(), "app/api/organizations");
    const offenders: string[] = [];
    for (const path of files(root, /^route\.ts$/)) {
      const src = readFileSync(path, "utf8");
      const starts = [...src.matchAll(HANDLER)];
      starts.forEach((m, i) => {
        const body = src.slice(m.index, starts[i + 1]?.index ?? src.length);
        if (m[1] !== "GET" && /\breadOnly:\s*true\b/.test(body)) {
          offenders.push(`${relative(root, path)}#${m[1]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the back-office invoice composer posts to the audited admin door", () => {
    const src = readFileSync(
      join(
        process.cwd(),
        "components/organization/billing/InvoiceComposer.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("/api/admin/organizations/${orgId}/invoices");
    expect(src).not.toContain("/billing-account/invoices");
  });
});
