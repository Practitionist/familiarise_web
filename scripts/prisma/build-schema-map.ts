/**
 * Builds the schema map under `docs/prisma/` from `prisma/schema.prisma`.
 *
 * The map used to be hand-drawn and went stale: the committed file described
 * 120 models while the schema had grown past 160, and ten of the model names
 * in the diagrams no longer existed. This generator makes the diagrams a
 * function of the schema, so a schema change that forgets its diagram is
 * caught by `scripts/ci/check-schema-map.ts` instead of by a reader.
 *
 *   npm run docs:schema-map              rewrite the map
 *   npm run docs:schema-map -- --check   fail if the committed map is stale
 *
 * The map is SPLIT ACROSS FILES on purpose. A single file carrying every
 * diagram renders to roughly 16 MB of inline SVG, which is past what GitHub's
 * markdown renderer will lay out on one page: past a certain point the
 * diagrams stop rendering and the page reports "svg element not in render
 * tree". The index holds the master map, the enforcers and the enums; each
 * part file under `docs/prisma/domains/` holds one topic group's diagrams.
 *
 * The domain grouping — which models belong to which diagram, and the prose
 * around each one — lives in `scripts/prisma/schema-domains.ts`. The enforcer
 * inventory is derived from the repo's own sidecar parser, so it is exactly
 * the object list CI already asserts.
 */
import fs from "node:fs";
import path from "node:path";
import { format as prettierFormat } from "prettier";
import { parseSidecarDirectory } from "../db/sidecar-objects";
import { domains } from "./schema-domains";

const ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(ROOT, "prisma", "schema.prisma");
const SQL_DIR = path.join(ROOT, "prisma", "sql");
const OUT_DIR = path.join(ROOT, "docs", "prisma");
const OUT_PATH = path.join(OUT_DIR, "00-schema-map.md");
const DOMAINS_DIR = path.join(OUT_DIR, "domains");

// ---------------------------------------------------------------- parsing

interface Scalar {
  name: string;
  type: string;
  isId: boolean;
  isUnique: boolean;
  optional: boolean;
}

interface Relation {
  name: string;
  model: string;
  list: boolean;
  fk: string[];
  refs: string[];
  onDelete: string;
  named: string | null;
}

interface Model {
  name: string;
  table: string | null;
  scalars: Scalar[];
  relations: Relation[];
  uniques: string[][];
  indexes: string[][];
}

interface Enum {
  name: string;
  values: string[];
}

const PRIMITIVES = new Set([
  "String",
  "Boolean",
  "Int",
  "BigInt",
  "Float",
  "DateTime",
  "Json",
  "Bytes",
  "Decimal",
]);

interface Block {
  kind: "model" | "enum";
  name: string;
  body: string[];
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\/\*|\*\/\s*$/.test(line)) continue;

    if (!current) {
      const m = line.match(/^(model|enum)\s+(\w+)\s*\{/);
      if (m) {
        current = { kind: m[1] as "model" | "enum", name: m[2], body: [] };
        blocks.push(current);
      }
      continue;
    }
    if (/^\}/.test(line)) {
      current = null;
      continue;
    }
    current.body.push(line);
  }
  return blocks;
}

/** Splits a field's attribute tail from its name and type. */
function splitAttributes(rest: string): { attrs: string; rest: string } {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "@" && depth === 0) {
      return { attrs: rest.slice(i), rest: rest.slice(0, i) };
    }
  }
  return { attrs: rest, rest: "" };
}

function parseSchema(text: string): { models: Model[]; enums: Enum[] } {
  const blocks = parseBlocks(text);
  const modelNames = new Set(
    blocks.filter((b) => b.kind === "model").map((b) => b.name),
  );
  const enumNames = new Set(
    blocks.filter((b) => b.kind === "enum").map((b) => b.name),
  );

  const models: Model[] = [];
  const enums: Enum[] = [];

  for (const block of blocks) {
    if (block.kind === "enum") {
      enums.push({
        name: block.name,
        values: block.body
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
          .map((l) => l.split(/\s+/)[0]),
      });
      continue;
    }

    const model: Model = {
      name: block.name,
      table: null,
      scalars: [],
      relations: [],
      uniques: [],
      indexes: [],
    };

    for (const raw of block.body) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith("@@map(")) {
        model.table = line.match(/@@map\("([^"]+)"\)/)?.[1] ?? null;
        continue;
      }
      if (line.startsWith("@@unique(")) {
        model.uniques.push(
          line
            .slice(line.indexOf("(") + 1, line.lastIndexOf(")"))
            .split(",")
            .map((s) => s.trim()),
        );
        continue;
      }
      if (line.startsWith("@@index(")) {
        model.indexes.push(
          line
            .slice(line.indexOf("(") + 1, line.lastIndexOf(")"))
            .split(",")
            .map((s) => s.trim()),
        );
        continue;
      }
      if (line.startsWith("@@")) continue;

      const fieldMatch = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
      if (!fieldMatch) {
        throw new Error(`Unparseable field in model ${model.name}: ${line}`);
      }
      const [, fieldName, fieldType, isList, isOptional, tail] = fieldMatch;
      const { attrs } = splitAttributes(tail);

      if (modelNames.has(fieldType)) {
        const relMatch = attrs.match(
          /@relation\(\s*(?:"([^"]+)"\s*,\s*)?fields:\s*\[([^\]]*)\]\s*,\s*references:\s*\[([^\]]*)\](?:\s*,\s*onDelete:\s*(\w+))?/,
        );
        model.relations.push({
          name: fieldName,
          model: fieldType,
          list: Boolean(isList),
          fk: relMatch
            ? relMatch[2]
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          refs: relMatch
            ? relMatch[3]
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          onDelete: relMatch?.[4] ?? "",
          named: attrs.match(/@relation\(\s*"([^"]+)"/)?.[1] ?? null,
        });
        continue;
      }

      if (!PRIMITIVES.has(fieldType) && !enumNames.has(fieldType)) {
        throw new Error(
          `Unknown type "${fieldType}" on ${model.name}.${fieldName} — not a Prisma primitive, model or enum`,
        );
      }

      model.scalars.push({
        name: fieldName,
        type: fieldType,
        isId: /@id\b/.test(attrs),
        isUnique: /@unique\b/.test(attrs),
        optional: Boolean(isOptional),
      });
    }

    models.push(model);
  }

  return { models, enums };
}

// ------------------------------------------------------------- formatting

const MONEY =
  /(amount|paise|price|fee|tax|balance|share|total|subtotal|igst|cgst|sgst|gst|refundable|credit|limit|due|revenue)/i;

/**
 * The columns worth drawing. An ER box with sixteen rows is unreadable on a
 * phone and each one costs SVG payload, so the diagram keeps the columns that
 * identify the row — its key, the state it is in, the money it carries and
 * where it points — and leaves the rest to the schema.
 */
const STATE_COLUMNS = [
  "status",
  "type",
  "kind",
  "scope",
  "channel",
  "actionType",
  "role",
  "priority",
  "verificationStatus",
];

const MAX_ATTRIBUTES = 8;

function pickFields(model: Model, enumNames: Set<string>): string[] {
  const out: string[] = [];
  const fkNames = new Set(model.relations.flatMap((r) => r.fk));
  const byName = new Map(model.scalars.map((s) => [s.name, s]));

  const add = (s: Scalar) => {
    if (out.length >= MAX_ATTRIBUTES) return;
    if (out.some((x) => x.split(" ")[0] === s.name)) return;
    const key = s.isId
      ? " PK"
      : fkNames.has(s.name)
        ? " FK"
        : s.isUnique
          ? " UK"
          : "";
    out.push(`${s.name} ${mermaidType(s.type)}${key}`);
  };

  // 1. the key
  for (const s of model.scalars) if (s.isId) add(s);
  // 2. the state the row is in
  for (const name of STATE_COLUMNS) {
    const s = byName.get(name);
    if (s && enumNames.has(s.type)) add(s);
  }
  // 3. the money it carries
  for (const s of model.scalars) {
    if (MONEY.test(s.name) && ["Int", "BigInt", "Float"].includes(s.type)) {
      add(s);
      break;
    }
  }
  // 4. where it points
  for (const s of model.scalars) if (fkNames.has(s.name)) add(s);
  // 5. when it was written
  for (const s of model.scalars) if (s.name === "createdAt") add(s);
  // 6. fill the remaining slots
  for (const s of model.scalars) add(s);
  return out;
}

/** Mermaid's erDiagram has no optional marker, so nullability lives in prose. */
function mermaidType(type: string): string {
  return type === "BigInt" ? "bigint" : type.toLowerCase();
}

/** Mermaid reserves `Class`; a model with that name is aliased in the diagram. */
const MERMAID_ALIAS: Record<string, string> = { Class: "ClassBatch" };
const alias = (n: string) => MERMAID_ALIAS[n] ?? n;

function erDiagram(
  domainModels: string[],
  anchors: string[],
  models: Map<string, Model>,
  enumNames: Set<string>,
): string {
  const focal = new Set<string>([...domainModels, ...anchors]);
  const entityNames = new Set<string>(focal);

  // Cross-domain foreign-key targets become stubs so the diagram is
  // self-contained: a reader sees where the key lands without following it.
  for (const n of focal) {
    for (const r of models.get(n)!.relations) {
      if (r.fk.length && !focal.has(r.model)) entityNames.add(r.model);
    }
  }

  const lines: string[] = ["erDiagram"];

  for (const n of entityNames) {
    const model = models.get(n);
    if (!model) continue;
    // Only a domain's OWN models are drawn in full. An anchor and a
    // cross-domain target are context: the reader needs to see that the key
    // lands somewhere, not that model's whole column list.
    const isStub = !domainModels.includes(n);
    const fields = isStub
      ? model.scalars
          .filter((s) => s.isId)
          .map((s) => `${s.name} ${mermaidType(s.type)} PK`)
      : pickFields(model, enumNames);
    lines.push(`    ${alias(n)} {`);
    for (const f of fields) lines.push(`        ${f}`);
    lines.push("    }");
  }

  const seen = new Set<string>();
  for (const n of focal) {
    const model = models.get(n)!;
    for (const r of model.relations) {
      // Only the foreign-key-holding side draws the edge; the other side is
      // the back-reference and would draw the same edge backwards.
      if (!r.fk.length) continue;
      if (!entityNames.has(r.model)) continue;
      const key = `${n}->${r.model}:${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const optional = r.fk.some(
        (f) => model.scalars.find((s) => s.name === f)?.optional,
      );
      lines.push(
        `    ${alias(n)} }o--${optional ? "o|" : "||"} ${alias(r.model)} : "${r.name}"`,
      );
    }
  }

  return lines.join("\n");
}

// ------------------------------------------------------------------ parts

/**
 * The parts the map is split into, in reading order. A part is a topic, not
 * a size: the split exists so that no single page carries enough inline SVG
 * to stop GitHub rendering it.
 */
interface Part {
  file: string;
  title: string;
  summary: string;
  domainIds: string[];
}

const PARTS: Part[] = [
  {
    file: "01-identity-and-profiles.md",
    title: "Identity & Profiles",
    summary:
      "Who a person is, what role they hold, and the background they bring.",
    domainIds: ["identity", "profiles", "background", "taxonomy"],
  },
  {
    file: "02-plans-and-availability.md",
    title: "Plans & Availability",
    summary: "What is sold, who else sells it with you, and when you are open.",
    domainIds: ["plans", "collaborators", "availability"],
  },
  {
    file: "03-bookings-and-appointments.md",
    title: "Bookings & Appointments",
    summary:
      "The request-to-payment chain, and the appointment every booking resolves to.",
    domainIds: ["bookings-1to1", "bookings-group", "appointment"],
  },
  {
    file: "04-lifecycle-and-sessions.md",
    title: "Lifecycle & Sessions",
    summary:
      "Ending a booking early, moving it, and running the session it becomes.",
    domainIds: ["cancellation", "session", "documents"],
  },
  {
    file: "05-payments-and-pricing.md",
    title: "Payments & Pricing",
    summary: "Money in, money back, and the platform's own fee policy.",
    domainIds: ["payments", "pricing"],
  },
  {
    file: "06-earnings-and-tax.md",
    title: "Earnings & Tax",
    summary:
      "From a captured payment to money in a bank account, and the tax withheld on the way.",
    domainIds: ["earnings", "tax"],
  },
  {
    file: "07-invoicing-and-referrals.md",
    title: "Invoicing & Referrals",
    summary:
      "The tax documents a buyer receives, and the credits that bring them back.",
    domainIds: ["consumer-billing", "referrals", "experts"],
  },
  {
    file: "08-enterprise.md",
    title: "Enterprise",
    summary:
      "The organisation, what it buys, what it is billed, and the ledger underneath.",
    domainIds: [
      "enterprise-core",
      "enterprise-billing",
      "enterprise-invoicing",
      "ledger",
    ],
  },
  {
    file: "09-support-and-moderation.md",
    title: "Support & Moderation",
    summary:
      "The case a support conversation becomes, the rating that follows, and the moderation over both.",
    domainIds: ["support-legacy", "support-case", "feedback", "moderation"],
  },
  {
    file: "10-compliance-and-system.md",
    title: "Compliance & System",
    summary:
      "Consent, erasure and the operational substrate everything else runs on.",
    domainIds: ["leads", "compliance", "system"],
  },
];

// ------------------------------------------------------------------ build

/** GitHub's heading-slug rules: lowercase, drop punctuation, spaces to hyphens. */
function ghAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

interface BuiltFile {
  /** Path relative to the repo root. */
  path: string;
  content: string;
}

/**
 * Format a generated file exactly the way `prettier --write` would.
 *
 * The repo runs `prettier --check .` in CI, so a generator whose output is
 * not already prettier-clean makes the two checks fight each other: prettier
 * reformats the committed file, and the drift check then reports it as stale.
 * Formatting here makes the committed bytes the generator's own output.
 */
async function formatFile(relPath: string, content: string): Promise<string> {
  const parser = relPath.endsWith(".md")
    ? "markdown"
    : relPath.endsWith(".ts")
      ? "typescript"
      : undefined;
  if (!parser) return content;
  return prettierFormat(content, { parser });
}

async function build(): Promise<BuiltFile[]> {
  const schemaText = fs.readFileSync(SCHEMA_PATH, "utf8");
  const { models: modelList, enums } = parseSchema(schemaText);
  const enumNames = new Set(enums.map((e) => e.name));
  const models = new Map(modelList.map((m) => [m.name, m]));

  // Every model must be claimed by exactly one domain.
  const claimed = new Map<string, string>();
  const problems: string[] = [];
  for (const d of domains) {
    for (const m of d.models) {
      if (claimed.has(m)) {
        problems.push(`${m} claimed by both ${claimed.get(m)} and ${d.id}`);
      }
      claimed.set(m, d.id);
      if (!models.has(m))
        problems.push(`${m} is in domain ${d.id} but not in the schema`);
    }
  }
  for (const m of modelList) {
    if (!claimed.has(m.name))
      problems.push(`${m.name} is in the schema but in no domain`);
  }
  if (problems.length) {
    throw new Error(
      `Domain map does not cover the schema:\n  ${problems.join("\n  ")}\n` +
        `Add the model to scripts/prisma/schema-domains.ts.`,
    );
  }

  // Every domain must be in exactly one part.
  const partIds = PARTS.flatMap((p) => p.domainIds);
  const missing = domains
    .map((d) => d.id)
    .filter((id) => !partIds.includes(id));
  const extra = partIds.filter((id) => !domains.some((d) => d.id === id));
  if (missing.length || extra.length) {
    throw new Error(
      `Part map does not cover the domains:\n  missing: ${missing.join(", ") || "none"}\n  unknown: ${extra.join(", ") || "none"}`,
    );
  }

  const byId = new Map(domains.map((d) => [d.id, d]));
  const files: BuiltFile[] = [];

  // ---- the part files
  const partIndex: Array<{
    part: Part;
    entries: Array<{ title: string; anchor: string }>;
  }> = [];
  for (const part of PARTS) {
    const entries: Array<{ title: string; anchor: string }> = [];
    const body: string[] = [];
    body.push(`---
type: reference
title: Familiarise — Schema map, ${part.title}
---`);
    body.push(`# Schema map — ${part.title}

${part.summary}

Part ${PARTS.indexOf(part) + 1} of ${PARTS.length} of the domain map. The
[map index](../00-schema-map.md) holds the master diagram, the enforcer
inventory and the enum reference.`);

    part.domainIds.forEach((id, i) => {
      const d = byId.get(id)!;
      const heading = `${i + 1}. ${d.title}`;
      const anchor = ghAnchor(heading);
      entries.push({ title: d.title, anchor });
      body.push(`## ${heading}

${d.intro}

\`\`\`mermaid
${erDiagram(d.models, d.anchors ?? [], models, enumNames)}
\`\`\`
${d.notes && d.notes.length ? "\n" + d.notes.map((x) => `- ${x}`).join("\n") : ""}`);
    });

    files.push({
      path: path.join("docs", "prisma", "domains", part.file),
      content: body.join("\n\n") + "\n",
    });
    partIndex.push({ part, entries });
  }

  // ---- the index
  const index: string[] = [];
  index.push(`---
type: reference
title: Familiarise — Prisma schema map
---`);
  index.push(`# Familiarise — Prisma Schema Map

Every model in the database, how they relate, which state machine each enum
encodes, and which rule the database itself refuses to let you break.

**Scale.** ${modelList.length} models, ${enums.length} enums, across
${domains.length} domains.

**The map is split.** The domain diagrams live in
[\`domains/\`](./domains/) — one file per topic — because a single file
carrying every diagram renders to roughly 16 MB of inline SVG, which is past
what GitHub's markdown renderer will lay out on one page. The index below
holds the master diagram, the enforcer inventory and the enum reference.

**The Prisma schema is not the whole truth.** The rules that matter most are
often not expressible in Prisma and live in \`prisma/sql/*.sql\` as CHECK
constraints, partial unique indexes, exclusion constraints and triggers.
[Section 2](#2-enforcers--the-prismasql-sidecars) lists all of them by name
and table. Where this document says "the database refuses it", that section
names the object that does the refusing.

**Money.** Every monetary column is \`BigInt\` **paise** in Postgres, mapped to
\`number\` at the Prisma client boundary in \`lib/prisma.ts\`. Settlement is INR
only, and the database enforces that.

**The schema is additive-only** under the launch freeze: new nullable columns
and new models are allowed; renames, drops of live columns and type changes are
not, until launch cutover.

**This file is generated.** \`npm run docs:schema-map\` re-parses
\`prisma/schema.prisma\` and rewrites it and its parts;
\`scripts/ci/check-schema-map.ts\` fails the build when the committed map has
drifted from the schema. The domain grouping and the prose live in
\`scripts/prisma/schema-domains.ts\`.`);

  // The contents table: every domain, in order, with its part file.
  const contents: string[] = [];
  let n = 0;
  for (const { part, entries } of partIndex) {
    n += 1;
    contents.push(
      `| ${String(n).padStart(2, " ")}. | [${part.title}](./domains/${part.file}) | ${part.summary} |`,
    );
    for (const e of entries) {
      n += 1;
      contents.push(
        `| ${String(n).padStart(2, " ")}. | [${e.title}](./domains/${part.file}#${e.anchor}) | |`,
      );
    }
  }
  index.push(`## Contents

| # | Domain | |
| --- | --- | --- |
${contents.join("\n")}`);

  index.push(`## 1. Master domain map

The ${domains.length} domains below, and how the identity and money layers cut
across them.

\`\`\`mermaid
${MASTER_MAP()}
\`\`\`

**The three rules that shape everything else.**

1. **Identity is the only root.** Every row that belongs to a person resolves to
   \`User.id\`. Money resolves to \`Payment\`; a booking resolves to
   \`Appointment\`, never directly to a booking-type row.
2. **Money has one writer per transition.** A status change on \`Payment\`,
   \`Refund\`, \`Appointment\` or \`ConsultantPayout\` is a conditional update
   that names the expected prior status in its \`WHERE\` clause. The ledger
   behind it is append-only, and a reversal is a counter-transaction rather
   than an edited row.
3. **The database enforces the invariants, not the application.** The
   application may check first, but the object that actually refuses the bad
   write is named in the enforcers section.`);

  index.push(ENFORCERS_SECTION(enforcerRows(), 2));
  index.push(ENUM_SECTION(enums, 3));
  index.push(DEPRECATED_SECTION(4));

  files.unshift({
    path: path.join("docs", "prisma", "00-schema-map.md"),
    content: index.join("\n\n") + "\n",
  });

  for (const f of files) f.content = await formatFile(f.path, f.content);
  return files;
}

function MASTER_MAP(): string {
  return `flowchart TD
    subgraph ID["Identity & Auth"]
        User
        Account
        Session
    end
    subgraph PROF["Role Profiles"]
        ConsultantProfile
        ConsulteeProfile
        OrgWorkspaceProfile
    end
    subgraph TAX["Taxonomy"]
        Domain
        SubDomain
        Tag
        Topic
    end
    subgraph PLAN["Service Plans"]
        ConsultationPlan
        SubscriptionPlan
        WebinarPlan
        ClassPlan
    end
    subgraph AVAIL["Availability"]
        AvailabilityWindowWeekly
        AvailabilityWindowCustom
        Waitlist
    end
    subgraph BOOK["Bookings"]
        Consultation
        Subscription
        Trial
        Webinar
        Class
    end
    subgraph CORE["Appointment Core"]
        Appointment
        AppointmentOccurrence
        AppointmentParticipant
    end
    subgraph SESS["Session Infra"]
        Meeting
        Recording
    end
    subgraph PAY["Payments"]
        Payment
        PaymentLeg
        Refund
        Dispute
    end
    subgraph LED["Double-Entry Ledger"]
        LedgerAccount
        LedgerTransaction
        LedgerEntry
    end
    subgraph EARN["Earnings & Payouts"]
        ConsultantEarnings
        ConsultantPayout
        PayoutAccount
    end
    subgraph ENT["Enterprise"]
        Organization
        Membership
        BillingAccount
        Contract
        Program
    end
    subgraph EINVO["Enterprise Invoicing"]
        OrganizationInvoice
        OrganizationEarnings
        OrganizationPayout
    end
    subgraph SUP["Support"]
        SupportCase
        SupportCaseMessage
        SupportTicket
        AppointmentSupportThread
    end
    subgraph MOD["Moderation & Trust"]
        ModerationReport
        ModerationAction
    end
    subgraph CMP["Compliance"]
        ConsentArtifact
        ErasureRequest
        DpdpGrievance
    end
    subgraph OPS["System & Ops"]
        OpsActionLog
        OpsActionProposal
        NotificationOutbox
        SystemJobExecution
    end

    ID --> PROF
    PROF --> PLAN
    PROF --> TAX
    PLAN --> AVAIL
    PLAN --> BOOK
    AVAIL --> BOOK
    BOOK --> CORE
    CORE --> SESS
    BOOK --> PAY
    PAY --> LED
    PAY --> EARN
    ENT --> PAY
    ENT --> LED
    ENT --> EINVO
    PAY --> SUP
    CORE --> SUP
    ID --> MOD
    ID --> CMP
    ID --> OPS
    LED --> OPS`;
}

function enforcerRows(): Array<{ kind: string; name: string; table: string }> {
  const objects = parseSidecarDirectory(SQL_DIR);
  const rows = objects.map((o) => ({
    kind: o.kind,
    name: o.name,
    table: o.table ?? "—",
  }));
  rows.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
  return rows;
}

function ENFORCERS_SECTION(
  rows: Array<{ kind: string; name: string; table: string }>,
  n: number,
): string {
  const table = rows
    .map(
      (r) =>
        `| \`${r.name}\` | ${r.kind} | ${r.table === "—" ? "—" : `\`${r.table}\``} |`,
    )
    .join("\n");

  return `## ${n}. Enforcers — the \`prisma/sql\` sidecars

The schema is managed with \`prisma db push\`, which cannot express a CHECK
that spans columns, a partial unique index, a GiST exclusion constraint or a
constraint trigger. Those live in three sidecar files and are applied and
asserted separately:

| File | What it holds |
| --- | --- |
| \`prisma/sql/check-constraints.sql\` | CHECK constraints, partial unique indexes, GiST exclusion constraints, and the immutability triggers. |
| \`prisma/sql/ledger-triggers.sql\` | The double-entry ledger's immutability and balance triggers. |
| \`prisma/sql/payment-legs-triggers.sql\` | The payment-leg sum identity, the header-versus-legs identity, and the refund ceiling. |

\`scripts/db/sidecar-objects.ts\` is the one parser that derives the expected
object list from those files, and \`scripts/ci/check-db-sidecars.ts\` asserts
that the live database actually has every one of them. The inventory below is
generated from that same parser, so it is exactly the list CI asserts.

| Object | Kind | Table |
| --- | --- | --- |
${table}

### The ones worth knowing by heart

| Object | What it refuses |
| --- | --- |
| \`occurrence_no_confirmed_overlap\` | Two confirmed sessions for one consultant at the same time. A GiST exclusion constraint, so it is race-proof at commit. It deliberately ignores tentative holds and cancelled rows. |
| \`payment_legs_sum_to_amount\` | A payment whose funding legs do not add up to its amount. |
| \`payment_amount_vs_legs\` | A payment whose header amount disagrees with its legs. |
| \`payment_refunds_within_amount\` | Refunds totalling more than the captured amount. |
| \`ledger_txn_balanced\` | A ledger transaction whose debits do not equal its credits. |
| \`ledger_entry_immutable\` | An update or delete of a ledger posting. |
| \`ledger_transaction_immutable\` | An update or delete of a ledger transaction. |
| \`usage_ledger_entry_immutable\` | An update or delete of a usage counter. |
| \`booking_status_history_immutable\` | An update or delete of a booking status transition. |
| \`review_revision_immutable\` | An update or delete of a review revision. |
| \`support_case_open_scope_key\` | Two open support cases in the same ownership scope. |
| \`support_case_scope_and_shape_chk\` | A case whose scope and its columns disagree. |
| \`support_case_event_target_xor\` | A case event that points at two targets or none. |
| \`consultant_earnings_occurrence_key\` | The same occurrence being paid out twice. |
| \`organization_earnings_split_key\` | The same organisation split being recorded twice. |
| \`appointment_feedback_level_key\` | Two ratings by the same person for the same call, with nulls treated as distinct. |
| \`program_assignment_no_active_overlap\` | Two active program assignments for one member. |
| \`org_earnings_split_within_gross\` | An organisation split whose parts exceed the gross. |
| \`overage_marginal_is_base_plus_surcharge\` | An overage charge whose marginal amount is not base plus surcharge. |
| \`rate_card_bps_sum_is_whole\` | A three-way fee split that is not exactly 10,000 basis points. |
| \`onboarding_draft_payload_size\` | An onboarding draft blob above the byte cap. |
| \`webhook_event_processed_error_exclusive\` | A gateway webhook claiming both processed and failed.`;
}

function ENUM_SECTION(enums: Enum[], n: number): string {
  const table = enums
    .map(
      (e) =>
        `| \`${e.name}\` | ${e.values.map((v) => `\`${v}\``).join(", ")} |`,
    )
    .join("\n");
  return `## ${n}. Enum reference

Every enum in the schema, with its full value list. Enums are declared below the
model that uses them, and a new value is normally a schema change rather than a
free-text string.

| Enum | Values |
| --- | --- |
${table}`;
}

function DEPRECATED_SECTION(n: number): string {
  return `## ${n}. Deprecated & superseded approaches

Kept so that an engineer or agent reading the current schema recognises these
names and deletes the leftovers rather than re-introducing them.

| Superseded name | What replaced it | Why |
| --- | --- | --- |
| \`Feedback\` | \`PlatformFeedback\` (platform-level) and \`AppointmentFeedback\` (per-call rating) | One table was doing two unrelated jobs. Feedback about the platform is not a rating of a call. |
| \`Invoice\` | \`ConsumerInvoice\` (B2C), \`OrganizationInvoice\` (B2B) and \`PlatformInvoiceCounter\` | The three audiences have different numbering rules and different tax heads. |
| \`Payout\` | \`ConsultantPayout\` and \`OrganizationPayout\` | A consultant payout and a host-organisation payout have different approval rails and different TDS treatment. |
| \`WalletEntry\`, \`FundingLedgerEntry\`, \`SettlementLedgerEntry\` | \`LedgerTransaction\` + \`LedgerEntry\` | Three single-entry logs could not be reconciled against a gateway. They collapsed into one balanced double-entry journal. |
| \`LedgerAccountBalance\` | *(removed)* — the balance is derived from the journal | A stored balance is a cache that can disagree with the postings. The reconcile job computes it. |
| \`WebinarCollaborator\`, \`ClassCollaborator\` | \`Collaborator\` | One polymorphic table with database-enforced plan XOR, role and tier matching. |
| \`HrisConfig\`, \`ScoringSnapshot\` | *(removed)* | Neither survived the design that replaced them. |
| \`SupportTicket\` as the case of record | \`SupportCase\` | The ticket queue could not hold evidence, decisions, appeals or a statutory deadline. The legacy rows stay readable through \`SupportCaseLegacyAlias\`. |

**The one rule that outranks all of these.** \`AGENTS.md\` §1.3 — do not write
an application-level reconciler for an invariant the database already enforces
at \`COMMIT\`. Only reconcile across external vendor boundaries (Razorpay,
Stream, Supabase Storage, email). \`GatewaySettlementLine\` and the two
vendor-retry tables in the compliance section exist precisely because those
boundaries cannot be transactional.`;
}

// ------------------------------------------------------------------- main

export { build as buildSchemaMap, DOMAINS_DIR, OUT_DIR };

/** Run as a script rather than imported as a module. */
if (require.main === module) {
  void (async () => {
    const check = process.argv.includes("--check");
    let files: BuiltFile[];
    try {
      files = await build();
    } catch (error) {
      console.error(
        `ERROR: could not build the schema map: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }

    if (check) {
      const stale: string[] = [];
      for (const f of files) {
        const abs = path.join(ROOT, f.path);
        const committed = fs.existsSync(abs)
          ? fs.readFileSync(abs, "utf8")
          : "";
        if (committed !== f.content) stale.push(f.path);
      }
      // A part file left behind by an earlier split would be a stale artefact.
      const expected = new Set(files.map((f) => path.join(ROOT, f.path)));
      const orphans: string[] = [];
      if (fs.existsSync(DOMAINS_DIR)) {
        for (const name of fs.readdirSync(DOMAINS_DIR)) {
          const abs = path.join(DOMAINS_DIR, name);
          if (!expected.has(abs)) orphans.push(path.relative(ROOT, abs));
        }
      }
      if (stale.length || orphans.length) {
        console.error(
          `ERROR: the schema map has drifted from prisma/schema.prisma.\n` +
            (stale.length ? `  stale: ${stale.join(", ")}\n` : "") +
            (orphans.length
              ? `  orphaned part files: ${orphans.join(", ")}\n`
              : "") +
            `  Run: npm run docs:schema-map`,
        );
        process.exit(1);
      }
      console.log(`schema map is up to date (${files.length} files)`);
      process.exit(0);
    }

    fs.mkdirSync(DOMAINS_DIR, { recursive: true });
    // Remove a part file the split no longer produces.
    const keep = new Set(files.map((f) => path.basename(f.path)));
    if (fs.existsSync(DOMAINS_DIR)) {
      for (const name of fs.readdirSync(DOMAINS_DIR)) {
        if (!keep.has(name)) fs.rmSync(path.join(DOMAINS_DIR, name));
      }
    }
    for (const f of files) {
      const abs = path.join(ROOT, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
    }
    console.log(
      `wrote ${files.length} files: ${path.relative(ROOT, OUT_PATH)} and ${path.relative(ROOT, DOMAINS_DIR)}/`,
    );
  })();
}
