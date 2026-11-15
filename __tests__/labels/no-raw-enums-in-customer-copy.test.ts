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
import {
  PLAN_EMAIL_SUPPORT_LABEL,
  planLevelLabel,
} from "@/lib/labels/plan-labels";
import ALREADY_WORDS from "./raw-enum-already-words.json";
import {
  BOOKING_WORDS,
  bookingStatus,
  type StatusViewer,
} from "@/lib/appointments/booking-status";

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

const BOTH: readonly Rule[] = ["underscore-replace", "raw-field"];

/** A staff-only surface: operators read the enum vocabulary, customers never see it. */
const staffOnly = (
  path: string,
  rules: readonly Rule[] = BOTH,
  surface = "console",
): Allowed => ({
  path,
  rules,
  reason: `Staff-only ${surface}: read by operators, not customers.`,
});

/** One field of one file that is already words, not an enum. */
const alreadyWords = (
  path: string,
  field: string,
  reason: string,
): Allowed => ({ path, rules: ["raw-field"], fields: [field], reason });

const ALLOWED: readonly Allowed[] = [
  staffOnly("app/dashboard/(backoffice)/"),
  staffOnly("components/dashboard/backoffice/"),
  staffOnly("components/admin/"),
  staffOnly("app/api/admin/", BOTH, "API"),
  staffOnly("app/api/staff/", ["raw-field"], "API"),
  {
    path: "components/dashboard/account/AccountDetailsSection.tsx",
    rules: ["underscore-replace"],
    reason:
      "Spaces out IANA timezone names (America/New_York), which are not enums.",
  },
  ...ALREADY_WORDS.map((a) => alreadyWords(a.path, a.field, a.reason)),
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

interface Hit {
  file: string;
  line: number;
  rule: Rule;
  text: string;
}

function scan(): Hit[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) walk(dir, files);
  const hits: Hit[] = [];
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

describe("the checkout details", () => {
  const ADAPTERS = ["consultation", "subscription", "webinar", "class"];
  const read = (kind: string) =>
    fs.readFileSync(
      path.join(ROOT, `app/checkout/plans/adapters/use-${kind}-checkout.tsx`),
      "utf8",
    );

  it.each(ADAPTERS)(
    "the %s adapter prints the level through its label, never the enum",
    (kind) => {
      const source = read(kind);
      expect(source).not.toMatch(/\{\s*[\w?.]*\?\.(level|emailSupport)\b/);
      expect(source).toContain("planLevelLabel(");
      expect(source).not.toMatch(/toLocale(Date|Time)String\(/);
    },
  );

  it("prints email support through its label", () => {
    expect(read("subscription")).toContain("PLAN_EMAIL_SUPPORT_LABEL[");
  });

  it("labels every plan level and email support tier", () => {
    expect(planLevelLabel("BEGINNER")).toBe("Beginner");
    expect(planLevelLabel(null)).toBe("All levels");
    expect(PLAN_EMAIL_SUPPORT_LABEL.GENERAL).toBe("General");
    expect(Object.values(PLAN_EMAIL_SUPPORT_LABEL)).toEqual([
      "General",
      "Priority",
      "Dedicated",
    ]);
  });
});

describe("the one booking status", () => {
  const KINDS = ["CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS", "TRIAL"];
  const STATUSES = [
    "PENDING",
    "APPROVED_PENDING_PAYMENT",
    "APPROVED",
    "AWAITING_PAYMENT",
    "SCHEDULED",
    "COMPLETED",
    "CONVERTED",
    "REJECTED",
    "CANCELLED",
    "EXPIRED",
    "DRAFT",
  ];
  const VIEWERS: StatusViewer[] = [
    "CONSULTEE",
    "CONSULTANT",
    "ORG_ADMIN",
    "STAFF",
  ];
  const EVENT_WORDS = ["Draft", "Scheduled", "Completed", "Cancelled"];

  it("speaks only the seven words (or a host's event words) and plain reason lines", () => {
    for (const kind of KINDS) {
      for (const status of STATUSES) {
        for (const viewer of VIEWERS) {
          for (const source of ["DIRECT_CHECKOUT", "REQUEST_SUBMITTED"]) {
            const s = bookingStatus({ kind, status, source }, viewer);
            const host =
              viewer === "CONSULTANT" &&
              (kind === "WEBINAR" || kind === "CLASS");
            expect([...BOOKING_WORDS, ...(host ? EVENT_WORDS : [])]).toContain(
              s.label,
            );
            expect(s.line).not.toMatch(/\b[A-Z]+_[A-Z_]+\b/);
          }
        }
      }
    }
  });
});
