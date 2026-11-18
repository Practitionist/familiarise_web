/**
 * Audit rows as an organisation reads them: names, money, dates and states in
 * words, built from `action` + `details` and the entities they name. Rows
 * written before the writers used prose read the same way, with no backfill;
 * an action this file does not know keeps its stored text, scrubbed.
 */

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { sanitizeAuditDescription } from "@/lib/enterprise/audit-sanitize";
import {
  CONTRACT_STATUS_LABEL,
  CONTRACT_SUPERSESSION_REASON_LABEL,
  FUNDING_SOURCE_LABEL,
  INVOICE_VOID_MODE_LABEL,
  MEMBER_ROLE_LABEL,
  ORG_STATUS_LABEL,
  PROGRAM_STATUS_LABEL,
  PROGRAM_TYPE_LABEL,
} from "@/lib/labels/org-labels";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatInViewerZone } from "@/lib/time/viewer-zone";
import { formatCurrencyAmount } from "@/utils/formatting";

/** The columns of an `OrgAuditLog` row a description is built from. */
export interface AuditDescribable {
  organizationId: string;
  action: string;
  description: string;
  details: Prisma.JsonValue | null;
  targetMembershipId: string | null;
}

/** The entities a page of rows names, resolved in one batch per kind. */
export interface AuditNameBook {
  members: ReadonlyMap<string, string>;
  users: ReadonlyMap<string, string>;
  contracts: ReadonlyMap<string, { effectiveFrom: Date }>;
  programs: ReadonlyMap<string, { name: string; type: string }>;
  invoices: ReadonlyMap<string, { number: string; totalPaise: number }>;
}

const str = z.string().optional().catch(undefined);
const num = z.number().optional().catch(undefined);

const DetailsSchema = z
  .object({
    membershipId: str,
    contractId: str,
    successorContractId: str,
    programId: str,
    invoiceId: str,
    effectiveTo: z.string().nullable().optional().catch(undefined),
    from: z.unknown(),
    to: z.unknown(),
    mode: str,
    reason: z.string().nullable().optional().catch(undefined),
    role: str,
    type: str,
    contractStatus: str,
    utr: str,
    amountPaise: num,
    clawbackAmountPaise: num,
    archived: z.boolean().optional().catch(undefined),
    selfLeave: z.boolean().optional().catch(undefined),
    fileName: str,
    planType: str,
    patch: z.record(z.unknown()).optional().catch(undefined),
  })
  .catch({ from: undefined, to: undefined });

type Details = z.infer<typeof DetailsSchema>;

const RoleSnapshotSchema = z.object({
  role: z.string().optional().catch(undefined),
});

const BillingSnapshotSchema = z.object({
  fundingSource: z.string().optional().catch(undefined),
  currency: z.string().optional().catch(undefined),
  creditLimit: z.number().nullable().optional().catch(undefined),
  minBalancePaise: z.number().nullable().optional().catch(undefined),
});

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_PATTERN = new RegExp(String.raw`\b(?:${UUID}|c[a-z0-9]{24})\b`, "g");
const ISO_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const PAISE_PATTERN = /\b(\d+) paise\b/g;
const SNAKE_ENUM_PATTERN = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/g;
const ROLE_WORD_PATTERN = new RegExp(
  String.raw`\b(?:${Object.keys(MEMBER_ROLE_LABEL).join("|")})\b`,
  "g",
);

const SETTING_LABEL: Readonly<Record<string, string>> = {
  name: "name",
  slug: "web address",
  description: "description",
  industry: "industry",
  website: "website",
  sizeBucket: "size",
  logo: "logo",
  bannerImage: "banner",
  primaryColor: "primary colour",
  secondaryColor: "secondary colour",
  billingEmail: "billing email",
  supportContactEmail: "support contact",
  escalationContactEmail: "escalation contact",
  canSponsor: "sponsoring",
  canHost: "hosting",
  requiresPO: "purchase-order requirement",
  paymentTermsDays: "payment terms",
  gstin: "GSTIN",
  pan: "PAN",
  gstRegStatus: "GST registration",
  gstStateCode: "GST state",
  msmeStatus: "MSME status",
  msmeWrittenAgreementOnFile: "MSME agreement",
  defaultCancellationPolicy: "cancellation policy",
  defaultRefundPolicy: "refund policy",
  isPublic: "public listing",
  streamRecordingRetentionDays: "recording retention",
};

const ORG_LIFECYCLE_VERB: Readonly<Record<string, string>> = {
  VERIFIED: "verified",
  SUSPENDED: "suspended",
  REACTIVATED: "reactivated",
  DEACTIVATED: "deactivated",
};

const PROGRAM_STATUS_ACTIONS = new Set([
  "PROGRAM_PAUSED",
  "PROGRAM_RESUMED",
  "PROGRAM_CANCELLED",
  "PROGRAM_EXPIRED",
]);

const CONTRACT_STATUS_ACTIONS = new Set([
  "CONTRACT_SIGNED",
  "CONTRACT_TERMINATED",
]);

/** Actions whose stored text names a person by id; an unknown id there is a removed member. */
const PERSON_ACTIONS = new Set([
  "MEMBER_ADDED",
  "MEMBER_REMOVED",
  "ROLE_CHANGE",
  "STATUS_CHANGE",
  "INVITE_ACCEPTED",
]);

const MATERIAL_VERB: Readonly<Record<string, string>> = {
  PLAN_MATERIAL_ADDED: "added",
  PLAN_MATERIAL_UPDATED: "updated",
  PLAN_MATERIAL_REMOVED: "removed",
};

/** A label from a closed map, or null when the value is not one of its keys. */
function labelOf(
  map: Readonly<Record<string, string>>,
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  return new Map(Object.entries(map)).get(value) ?? null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function inr(paise: number): string {
  return formatCurrencyAmount(paise, "INR");
}

function dateIn(value: Date | string, zone: string): string | null {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return formatInViewerZone(at, zone, "d MMM yyyy");
}

/** Every id the rows point at, by the kind of entity it names. */
export function auditReferenceIds(rows: readonly AuditDescribable[]) {
  const members = new Set<string>();
  const contracts = new Set<string>();
  const programs = new Set<string>();
  const invoices = new Set<string>();
  const named = new Set<string>();
  for (const row of rows) {
    const d = DetailsSchema.parse(row.details);
    if (row.targetMembershipId) members.add(row.targetMembershipId);
    if (d.membershipId) members.add(d.membershipId);
    if (d.contractId) contracts.add(d.contractId);
    if (d.successorContractId) contracts.add(d.successorContractId);
    if (d.programId) programs.add(d.programId);
    if (d.invoiceId) invoices.add(d.invoiceId);
    if (PERSON_ACTIONS.has(row.action)) {
      for (const [id] of row.description.matchAll(ID_PATTERN)) named.add(id);
    }
  }
  // Older person rows name a user id in their text; membership ids resolve above.
  const users = [...named].filter((id) => !members.has(id));
  return {
    members: [...members],
    users,
    contracts: [...contracts],
    programs: [...programs],
    invoices: [...invoices],
  };
}

/** Resolve a page's ids within the rows' own organisations; at most one query per kind. */
export async function loadAuditNameBook(
  rows: readonly AuditDescribable[],
): Promise<AuditNameBook> {
  const ids = auditReferenceIds(rows);
  const orgIds = [...new Set(rows.map((r) => r.organizationId))];
  const inOrgs = { in: orgIds };
  const [members, users, contracts, programs, invoices] = await Promise.all([
    ids.members.length
      ? prisma.membership.findMany({
          where: { id: { in: ids.members }, organizationId: inOrgs },
          select: { id: true, user: { select: { name: true, email: true } } },
        })
      : [],
    ids.users.length
      ? prisma.user.findMany({
          where: {
            id: { in: ids.users },
            erasedAt: null,
            memberships: { some: { organizationId: inOrgs } },
          },
          select: { id: true, name: true, email: true },
        })
      : [],
    ids.contracts.length
      ? prisma.contract.findMany({
          where: { id: { in: ids.contracts }, organizationId: inOrgs },
          select: { id: true, effectiveFrom: true },
        })
      : [],
    ids.programs.length
      ? prisma.program.findMany({
          where: {
            id: { in: ids.programs },
            contract: { organizationId: inOrgs },
          },
          select: { id: true, name: true, type: true },
        })
      : [],
    ids.invoices.length
      ? prisma.organizationInvoice.findMany({
          where: { id: { in: ids.invoices }, organizationId: inOrgs },
          select: { id: true, invoiceNumber: true, totalPaise: true },
        })
      : [],
  ]);
  return {
    members: new Map(
      members.map((m) => [m.id, m.user.name || m.user.email || "A member"]),
    ),
    users: new Map(users.map((u) => [u.id, u.name || u.email || "A member"])),
    contracts: new Map(
      contracts.map((c) => [c.id, { effectiveFrom: c.effectiveFrom }]),
    ),
    programs: new Map(
      programs.map((p) => [p.id, { name: p.name, type: p.type }]),
    ),
    invoices: new Map(
      invoices.map((i) => [
        i.id,
        { number: i.invoiceNumber, totalPaise: Number(i.totalPaise) },
      ]),
    ),
  };
}

/** Describe a page of rows in the viewer's zone, in the rows' order. */
export async function describeAuditRows(
  rows: readonly AuditDescribable[],
  zone: string,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const book = await loadAuditNameBook(rows);
  return rows.map((row) => describeAuditEntry(row, book, zone));
}

/** One row in words; pure, so every reader prints the same sentence. */
export function describeAuditEntry(
  row: AuditDescribable,
  book: AuditNameBook,
  zone: string,
): string {
  const d = DetailsSchema.parse(row.details);
  const composed = composeFromDetails(row, d, book, zone);
  // Composed sentences carry typed names (file, programme, UTR), so both paths take the scrub.
  return composed === null
    ? scrubStoredDescription(
        row.description,
        book,
        zone,
        PERSON_ACTIONS.has(row.action),
      )
    : sanitizeAuditDescription(composed);
}

function composeFromDetails(
  row: AuditDescribable,
  d: Details,
  book: AuditNameBook,
  zone: string,
): string | null {
  const member = (id: string | null | undefined) =>
    (id && book.members.get(id)) || null;
  const contract = (id: string | undefined) => {
    const c = id ? book.contracts.get(id) : undefined;
    const from = c ? dateIn(c.effectiveFrom, zone) : null;
    return from ? `the contract starting ${from}` : null;
  };
  const program = (id: string | undefined) => {
    const p = id ? book.programs.get(id) : undefined;
    return p ? `program "${p.name}"` : null;
  };
  const invoice = (id: string | undefined) =>
    (id && book.invoices.get(id)) || null;
  const subject = member(d.membershipId ?? row.targetMembershipId);
  const role = labelOf(MEMBER_ROLE_LABEL, d.role);

  switch (row.action) {
    case "CONSENT_GRANTED":
      return subject ? `Consent granted for ${subject}` : "Consent granted";
    case "CONSENT_WITHDRAWN":
      return subject ? `Consent withdrawn for ${subject}` : "Consent withdrawn";
    case "INVITE_ACCEPTED":
      return role
        ? `${subject ?? "A member"} accepted the invitation to join as ${role}`
        : null;
    case "MEMBER_ADDED":
      return subject && role ? `${subject} added as ${role}` : null;
    case "MEMBER_REMOVED": {
      if (subject) {
        return d.selfLeave
          ? `${subject} left the organisation`
          : `${subject} removed from the organisation`;
      }
      const who = `A member${role ? ` (${role})` : ""}`;
      return d.selfLeave
        ? `${who} left the organisation`
        : `${who} was removed from the organisation`;
    }
    case "ROLE_CHANGE": {
      const from = labelOf(
        MEMBER_ROLE_LABEL,
        RoleSnapshotSchema.safeParse(d.from).data?.role,
      );
      const to = labelOf(
        MEMBER_ROLE_LABEL,
        RoleSnapshotSchema.safeParse(d.to).data?.role,
      );
      if (!from || !to) return null;
      return `${subject ?? "A member"}'s role changed: ${from} → ${to}`;
    }
    case "CONTRACT_CREATED": {
      const c = d.contractId ? book.contracts.get(d.contractId) : undefined;
      const from = c ? dateIn(c.effectiveFrom, zone) : null;
      return from ? `Contract created, effective from ${from}` : null;
    }
    case "CONTRACT_EXPIRED": {
      const ended = d.effectiveTo ? dateIn(d.effectiveTo, zone) : null;
      const which = capitalize(contract(d.contractId) ?? "a contract");
      return ended ? `${which} expired on ${ended}` : `${which} expired`;
    }
    case "CONTRACT_SUPERSEDED": {
      const reason = labelOf(CONTRACT_SUPERSESSION_REASON_LABEL, d.reason);
      const old = capitalize(contract(d.contractId) ?? "a contract");
      const next = contract(d.successorContractId) ?? "a new contract";
      return `${old} was replaced by ${next}${reason ? ` (${reason.toLowerCase()})` : ""}`;
    }
    case "PROGRAM_CREATED": {
      const p = d.programId ? book.programs.get(d.programId) : undefined;
      if (!p) return null;
      const type = labelOf(PROGRAM_TYPE_LABEL, p.type);
      const under = contract(d.contractId);
      return `Program "${p.name}"${type ? ` (${type.toLowerCase()})` : ""} created${under ? ` under ${under}` : ""}`;
    }
    case "PROGRAM_ARCHIVED": {
      const p = program(d.programId);
      if (!p) return null;
      return `${capitalize(p)} ${d.archived === false ? "unarchived" : "archived"}`;
    }
    case "PROGRAM_ASSIGNED": {
      const p = program(d.programId);
      if (!p || !d.membershipId) return null;
      return `${subject ?? "A member"} assigned to ${p}`;
    }
    case "ASSIGNMENT_CLOSED_BY_CONTRACT": {
      const p = program(d.programId);
      const status = labelOf(CONTRACT_STATUS_LABEL, d.contractStatus);
      if (!p || !status) return null;
      const whose = subject ? `${subject}'s seat` : "A seat";
      return `${whose} on ${p} closed: the contract ${status.toLowerCase()}`;
    }
    case "INVOICE_RECEIPT_RECORDED": {
      const inv = invoice(d.invoiceId);
      if (!inv || d.amountPaise === undefined) return null;
      return `Bank transfer${d.utr ? ` ${d.utr}` : ""} of ${inr(d.amountPaise)} recorded against invoice ${inv.number}`;
    }
    case "INVOICE_VOIDED": {
      const inv = invoice(d.invoiceId);
      if (!inv) return null;
      const mode = labelOf(INVOICE_VOID_MODE_LABEL, d.mode);
      return `Invoice ${inv.number} for ${inr(inv.totalPaise)} voided${mode ? ` ${mode}` : ""}`;
    }
    case "WALLET_REFUND":
      return d.amountPaise === undefined
        ? null
        : `Refund of ${inr(d.amountPaise)} credited back to the organisation wallet`;
    case "INVOICE_REFUNDED": {
      const inv = invoice(d.invoiceId);
      if (inv) {
        return d.amountPaise === undefined
          ? `Invoice ${inv.number} refunded`
          : `Invoice ${inv.number} refunded (${inr(d.amountPaise)})`;
      }
      return d.amountPaise === undefined || d.invoiceId
        ? null
        : `Refund of ${inr(d.amountPaise)} processed`;
    }
    case "PAYOUT_CLAWBACK": {
      const paise = d.clawbackAmountPaise ?? d.amountPaise;
      return paise === undefined
        ? null
        : `Payout clawback: ${inr(paise)} recovered from an organisation payout`;
    }
    case "BILLING_ACCOUNT_UPDATED":
      return describeBillingChange(d);
    case "SETTINGS_CHANGED":
      return d.patch ? describeSettingsPatch(d.patch) : null;
    default:
      break;
  }

  if (PROGRAM_STATUS_ACTIONS.has(row.action)) {
    const p = program(d.programId);
    const from = labelOf(PROGRAM_STATUS_LABEL, d.from);
    const to = labelOf(PROGRAM_STATUS_LABEL, d.to);
    return p && from && to ? `${capitalize(p)}: ${from} → ${to}` : null;
  }
  if (CONTRACT_STATUS_ACTIONS.has(row.action)) {
    const from = labelOf(CONTRACT_STATUS_LABEL, d.from);
    const to = labelOf(CONTRACT_STATUS_LABEL, d.to);
    if (!from || !to) return null;
    return `${capitalize(contract(d.contractId) ?? "a contract")}: ${from} → ${to}`;
  }
  const lifecycle = labelOf(ORG_LIFECYCLE_VERB, row.action);
  if (lifecycle) {
    const from = labelOf(ORG_STATUS_LABEL, d.from);
    const to = labelOf(ORG_STATUS_LABEL, d.to);
    return from && to
      ? `A platform admin ${lifecycle} the organisation: ${from} → ${to}`
      : null;
  }
  const material = labelOf(MATERIAL_VERB, row.action);
  if (material && d.fileName) {
    return `Plan material "${d.fileName}" ${material}`;
  }
  return null;
}

function describeBillingChange(d: Details): string | null {
  const before = BillingSnapshotSchema.safeParse(d.from);
  const after = BillingSnapshotSchema.safeParse(d.to);
  if (!before.success || !after.success) return null;
  const a = before.data;
  const b = after.data;
  const currency = b.currency ?? a.currency ?? "INR";
  const money = (paise: number | null | undefined, none: string) =>
    paise === null || paise === undefined
      ? none
      : formatCurrencyAmount(paise, currency);
  const changes: string[] = [];
  if (a.fundingSource !== b.fundingSource) {
    changes.push(
      `funding ${labelOf(FUNDING_SOURCE_LABEL, a.fundingSource) ?? "none"} → ${labelOf(FUNDING_SOURCE_LABEL, b.fundingSource) ?? "none"}`,
    );
  }
  if (a.creditLimit !== b.creditLimit) {
    changes.push(
      `credit limit ${money(a.creditLimit, "no limit")} → ${money(b.creditLimit, "no limit")}`,
    );
  }
  if (a.minBalancePaise !== b.minBalancePaise) {
    changes.push(
      `minimum balance ${money(a.minBalancePaise, "none")} → ${money(b.minBalancePaise, "none")}`,
    );
  }
  if (a.currency !== b.currency) {
    changes.push(`currency ${a.currency ?? "none"} → ${b.currency ?? "none"}`);
  }
  return changes.length === 0
    ? "Billing settings saved with no changes"
    : `Billing settings changed: ${changes.join("; ")}`;
}

function describeSettingsPatch(patch: Record<string, unknown>): string {
  const fields = Object.keys(patch)
    .filter((key) => key !== "expectedVersion")
    .map(
      (key) =>
        labelOf(SETTING_LABEL, key) ??
        humanizeEnum(key.replace(/([a-z])([A-Z])/g, "$1_$2")).toLowerCase(),
    );
  return fields.length === 0
    ? "Organisation settings saved with no changes"
    : `Organisation settings changed: ${fields.join(", ")}`;
}

/** Stored text with dates, paise, known ids and enum codes put into words. */
function scrubStoredDescription(
  description: string,
  book: AuditNameBook,
  zone: string,
  namesPerson: boolean,
): string {
  return sanitizeAuditDescription(description)
    .replace(ISO_PATTERN, (iso) => dateIn(iso, zone) ?? iso)
    .replace(PAISE_PATTERN, (_m, paise: string) => inr(Number(paise)))
    .replace(ID_PATTERN, (id) => {
      const name = book.members.get(id) ?? book.users.get(id);
      if (name) return name;
      const p = book.programs.get(id);
      if (p) return `"${p.name}"`;
      const inv = book.invoices.get(id);
      if (inv) return inv.number;
      return namesPerson ? "a removed member" : id;
    })
    .replace(SNAKE_ENUM_PATTERN, (code) => humanizeEnum(code).toLowerCase())
    .replace(
      ROLE_WORD_PATTERN,
      (code) => labelOf(MEMBER_ROLE_LABEL, code) ?? code,
    );
}
