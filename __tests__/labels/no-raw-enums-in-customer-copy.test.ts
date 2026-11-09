/**
 * @jest-environment node
 */

/**
 * Customer-facing source never prints an enum by turning its underscores into
 * spaces, and never interpolates a raw `.status` / `.role` / `.method` /
 * `.planType` / `.reason` field into rendered text. Both read as database
 * vocabulary ("CO HOST", "SCHEDULED") to the person using the product; a label
 * map in `lib/labels/*` is the way to name a value.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

const SCAN_DIRS = [
  "app",
  "components",
  "emails",
  "lib/novu/templates",
  "lib/errors/mapping",
];

type Rule = "underscore-replace" | "raw-field";

interface Allowed {
  /** A repo-relative file, or a directory prefix ending in "/". */
  path: string;
  rules: readonly Rule[];
  /** For `raw-field`: only these field names are allowed in the file. */
  fields?: readonly string[];
  reason: string;
}

const BACKOFFICE_REASON =
  "Staff-only console: operators read the enum vocabulary, customers never see this surface.";

const ALLOWED: readonly Allowed[] = [
  {
    path: "app/dashboard/(backoffice)/",
    rules: ["underscore-replace", "raw-field"],
    reason: BACKOFFICE_REASON,
  },
  {
    path: "components/dashboard/backoffice/",
    rules: ["underscore-replace", "raw-field"],
    reason: BACKOFFICE_REASON,
  },
  {
    path: "components/admin/",
    rules: ["underscore-replace", "raw-field"],
    reason: BACKOFFICE_REASON,
  },
  {
    path: "app/api/admin/",
    rules: ["underscore-replace", "raw-field"],
    reason: "Admin-only API: the response is read by staff, not customers.",
  },
  {
    path: "app/api/staff/",
    rules: ["raw-field"],
    reason: "Staff-only API: the response is read by staff, not customers.",
  },
  {
    path: "components/dashboard/account/AccountDetailsSection.tsx",
    rules: ["underscore-replace"],
    reason:
      "Spaces out IANA timezone names (America/New_York), which are not enums.",
  },
  {
    path: "app/explore/programs/plans/classes/[classPlanId]/components/BatchSchedule.tsx",
    rules: ["raw-field"],
    fields: ["status"],
    reason:
      "SessionInfo.status is already the words Upcoming / Completed / Happening Now, never a database enum.",
  },
  {
    path: "app/meetings/[id]/components/MeetingRoom.tsx",
    rules: ["raw-field"],
    fields: ["status"],
    reason:
      "clock.status is a ready sentence from readClock (Starts in 5 min, 10 min over), not an enum.",
  },
  {
    path: "components/chat/DebugDialog.tsx",
    rules: ["raw-field"],
    fields: ["role"],
    reason: "Developer tool shown only on localhost.",
  },
  {
    path: "components/dashboard/MaintenanceBookingRemediation.tsx",
    rules: ["raw-field"],
    fields: ["reason"],
    reason: "Operator-typed audit reason, shown on the operator console.",
  },
  {
    path: "components/dashboard/MaintenanceControls.tsx",
    rules: ["raw-field"],
    fields: ["reason"],
    reason: "Operator-typed maintenance reason, shown on the operator console.",
  },
  {
    path: "components/dashboard/shared/AppointmentTimeline.tsx",
    rules: ["raw-field"],
    fields: ["reason"],
    reason:
      "entry.reason is already copy: the booking-history read maps scheduling tokens to words.",
  },
  {
    path: "app/dashboard/organization/[orgId]/billing/InvoiceDetailSheet.tsx",
    rules: ["raw-field"],
    fields: ["reason"],
    reason: "Credit-note reason is prose an operator typed.",
  },
  {
    path: "components/dashboard/shared/PaymentDetailPage.tsx",
    rules: ["raw-field"],
    fields: ["reason"],
    reason: "Refund.reason is the operator's prose reason for the refund.",
  },
  {
    path: "app/dashboard/consultant/[consultantId]/(features)/settings/get-paid/ReversePennyDrop.tsx",
    rules: ["raw-field"],
    fields: ["reason"],
    reason:
      "phase.reason is a sentence the verification API wrote for the user.",
  },
  {
    path: "components/support/resolution/FinancialPanel.tsx",
    rules: ["raw-field"],
    fields: ["reason"],
    reason: "Support-agent resolution panel, not a customer surface.",
  },
  {
    path: "emails/organizations/SsoProviderEmail.tsx",
    rules: ["raw-field"],
    fields: ["reason"],
    reason:
      "The reason is prose the platform reviewer typed for the org admin.",
  },
];

function allowedFor(
  file: string,
  rule: Rule,
  field?: string,
): Allowed | undefined {
  return ALLOWED.find(
    (a) =>
      a.rules.includes(rule) &&
      (a.path.endsWith("/") ? file.startsWith(a.path) : file === a.path) &&
      (!a.fields || (field !== undefined && a.fields.includes(field))),
  );
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(rel);
    }
  }
}

const UNDERSCORE_REPLACE = /\.replace(?:All)?\(\s*(?:\/_\/g|["']_["'])/;

const CHAIN = String.raw`[A-Za-z_$][\w$]*(?:\??\.[\w$]+)*\??\.(status|role|method|planType|reason)`;

/**
 * `{x.status}` as JSX text, or `({x.role})` / `(${x.role})` as a parenthetical.
 * Attribute values (`key={x.status}`), URLs, log lines and HTTP `res.status`
 * are not rendered enum text and do not match.
 */
const RAW_FIELD = new RegExp(
  String.raw`(?:(?<!=)>[^<>{}]*|^\s*)\{\s*${CHAIN}\s*\}|\(\$?\{\s*(?!res(?:ponse)?\.)${CHAIN}\s*\}\)`,
);

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function scan(): { file: string; line: number; rule: Rule; text: string }[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) walk(dir, files);
  const hits: { file: string; line: number; rule: Rule; text: string }[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      if (isComment(text)) return;
      if (
        UNDERSCORE_REPLACE.test(text) &&
        !allowedFor(file, "underscore-replace")
      ) {
        hits.push({ file, line: i + 1, rule: "underscore-replace", text });
      }
      const raw = RAW_FIELD.exec(text);
      if (raw) {
        const field = raw[1] ?? raw[2];
        if (!allowedFor(file, "raw-field", field)) {
          hits.push({ file, line: i + 1, rule: "raw-field", text });
        }
      }
    });
  }
  return hits;
}

describe("customer-facing copy never prints a raw enum", () => {
  it("has no underscore-to-space enum rendering and no raw enum field interpolation", () => {
    const hits = scan();
    expect(
      hits.map((h) => `${h.file}:${h.line} [${h.rule}] ${h.text.trim()}`),
    ).toEqual([]);
  });

  it("keeps every allow-list entry pointing at a real file or directory", () => {
    for (const a of ALLOWED) {
      expect(fs.existsSync(path.join(ROOT, a.path))).toBe(true);
      expect(a.reason.length).toBeGreaterThan(10);
    }
  });

  it("detects the patterns it exists to forbid", () => {
    expect(UNDERSCORE_REPLACE.test('role.replace(/_/g, " ")')).toBe(true);
    expect(UNDERSCORE_REPLACE.test('zone.replaceAll("_", " ")')).toBe(true);
    expect(RAW_FIELD.test("<Badge>{session.status}</Badge>")).toBe(true);
    expect(RAW_FIELD.test("`${c.name} (${c.role})`")).toBe(true);
    expect(RAW_FIELD.test("`HTTP error (${res.status})`")).toBe(false);
    expect(RAW_FIELD.test("<Tab key={t} value={tab.status} />")).toBe(false);
    expect(RAW_FIELD.test("<span>{LABEL[row.status]}</span>")).toBe(false);
  });
});
