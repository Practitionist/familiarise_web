/**
 * GET    /api/organizations/[orgId]
 * PATCH  /api/organizations/[orgId]
 * DELETE /api/organizations/[orgId]
 *
 * Core org-record CRUD. GET returns the full merged shape the dashboard
 * Home uses (capabilities, billing account summary, hosting-side summary,
 * counts). PATCH accepts a narrow set of owner-editable fields and guards
 * capability flips so we never end up with canSponsor=false && canHost=false.
 * DELETE is owner-only AND only for orgs with no active contracts/invoices
 * — otherwise admins must DEACTIVATE via the admin-verify endpoint.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import {
  orgDetailsInclude,
  redactOrgDetailsForRole,
  suspendedOrgDetails,
} from "@/lib/data/org-details-include";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { transitionOrganization } from "@/lib/enterprise/transitions";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { purgeOrgSurfaces } from "@/lib/data/public-cache";
import { encryptPAN } from "@/lib/payments/tax/pan-crypto";
import { isValidGstin } from "@/lib/compliance/gst";
import { isValidPan } from "@/lib/compliance/tds";
import { numericStateCode } from "@/lib/compliance/state-codes";
import { isHostOrgsEnabled } from "@/lib/enterprise/feature-flag";
import { isStreamConfigured } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { endActiveStreamVideoCalls } from "@/lib/stream/event-channel-service";
import { MIN_ORG_RETENTION_DAYS } from "@/lib/stream/recording-retention";

const ORG_DELETED_CALL_REASON = "org_deleted";

const SizeBucketSchema = z.enum([
  "SMALL_1_50",
  "MEDIUM_51_200",
  "LARGE_201_1000",
  "ENTERPRISE_1000_PLUS",
]);
const GstRegStatusSchema = z.enum(["REGULAR", "COMPOSITION", "UNREGISTERED"]);

const PatchBodySchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(80)
      .regex(
        /^[a-z0-9-]+$/,
        "Slug may only contain lowercase letters, digits, and hyphens",
      )
      .optional(),
    description: z.string().max(5000).nullable().optional(),
    industry: z.string().max(120).nullable().optional(),
    website: z.string().url().nullable().optional(),
    sizeBucket: SizeBucketSchema.nullable().optional(),
    logo: z.string().url().nullable().optional(),
    bannerImage: z.string().url().nullable().optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Hex colour required")
      .nullable()
      .optional(),
    secondaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Hex colour required")
      .nullable()
      .optional(),
    billingEmail: z.string().email().optional(),
    supportContactEmail: z.string().email().nullable().optional(),
    escalationContactEmail: z.string().email().nullable().optional(),
    canSponsor: z.boolean().optional(),
    canHost: z.boolean().optional(),
    requiresPO: z.boolean().optional(),
    paymentTermsDays: z.coerce.number().int().min(0).max(180).optional(),
    gstin: z
      .string()
      .length(15)
      .nullable()
      .optional()
      .refine((v) => v === null || v === undefined || isValidGstin(v), {
        message: "INVALID_GSTIN_FORMAT",
      }),
    pan: z
      .string()
      .length(10)
      .nullable()
      .optional()
      .refine((v) => v === null || v === undefined || isValidPan(v), {
        message: "INVALID_PAN_FORMAT",
      }),
    gstRegStatus: GstRegStatusSchema.optional(),
    gstStateCode: z.string().length(2).nullable().optional(),
    // MSME (MSMED Act) declaration — #1230. The payout deadline engine reads
    // this satellite to compute the 15/45-day mustPayByDate on host-org
    // payouts; until now nothing wrote it, so every org defaulted to NONE and
    // got 60-day terms where the statute mandates 15/45.
    msmeStatus: z.enum(["NONE", "MICRO", "SMALL", "MEDIUM"]).optional(),
    msmeWrittenAgreementOnFile: z.boolean().optional(),
    defaultCancellationPolicy: z.string().max(5000).nullable().optional(),
    defaultRefundPolicy: z.string().max(5000).nullable().optional(),
    isPublic: z.boolean().optional(),
    // Owner-only via settings.ownerFields; null follows the platform schedule.
    streamRecordingRetentionDays: z
      .number()
      .int()
      .min(MIN_ORG_RETENTION_DAYS)
      .max(3650)
      .nullable()
      .optional(),
    expectedVersion: z.coerce.number().int().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  })
  // Capability flips gate the whole billing/payout subsystem — a stale tab must
  // get a 409, never last-write-wins. Other fields stay back-compatible.
  .refine(
    (v) =>
      (v.canSponsor === undefined && v.canHost === undefined) ||
      v.expectedVersion !== undefined,
    {
      message: "expectedVersion is required when changing capabilities",
      path: ["expectedVersion"],
    },
  );

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Any member, incl. SUSPENDED (#1527 decision 6): the shell must render so
  // a suspended member reaches their booked sessions; they get the minimal
  // shape below.
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    allowSuspended: true,
  });
  if (access.error) return access.error;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    // Shared with the server-side seed in lib/data/org-details-server.ts so
    // the route and the prefetch cannot drift apart.
    include: orgDetailsInclude,
  });
  if (!org) {
    return NextResponse.json(
      { error: "Organization not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    organization:
      access.member.status === "ACTIVE"
        ? redactOrgDetailsForRole(org, access.member.role)
        : suspendedOrgDetails(org),
    membership: {
      role: access.member.role,
      status: access.member.status,
      // Drives the Requests nav gate: delivery surfaces belong to whoever
      // holds a consultant profile, which is not the same set as MemberRole
      // EXPERT (an OWNER can also deliver).
      consultantProfileId: access.member.consultantProfileId,
    },
  });
}

// #779 §A — field-level RBAC instead of a blanket OWNER gate. Descriptive /
// branding fields are settings.manage (OWNER, MAINTAINER); billing contact +
// NET-X terms are billing.manage (OWNER, BILLING_ADMIN); everything else —
// slug, capabilities, tax identity, policies, isPublic — is
// settings.ownerFields (#1851: the matrix, not the rank ladder).
const MAINTAINER_FIELDS = new Set([
  "name",
  "description",
  "industry",
  "website",
  "sizeBucket",
  "logo",
  "bannerImage",
  "primaryColor",
  "secondaryColor",
  "supportContactEmail",
  "escalationContactEmail",
]);
const BILLING_ADMIN_FIELDS = new Set(["billingEmail", "paymentTermsDays"]);
// Concurrency control, not a writable column: the optimistic-lock CAS below is
// what enforces it, and every dashboard save echoes it back. Counting it as a
// touched field 403'd every non-OWNER save regardless of what was edited.
const CONTROL_FIELDS = new Set(["expectedVersion"]);

type PatchBody = z.infer<typeof PatchBodySchema>;
type TxClient = Tx;

function checkFieldRbac(
  role: Parameters<typeof hasOrgPermission>[0],
  body: PatchBody,
): NextResponse | null {
  if (hasOrgPermission(role, "settings.ownerFields")) return null;
  const allowed = new Set<string>();
  if (hasOrgPermission(role, "settings.manage")) {
    MAINTAINER_FIELDS.forEach((f) => allowed.add(f));
  }
  if (hasOrgPermission(role, "billing.manage")) {
    BILLING_ADMIN_FIELDS.forEach((f) => allowed.add(f));
  }
  const touched = Object.keys(body).filter((k) => !CONTROL_FIELDS.has(k));
  const forbidden = touched.filter((k) => !allowed.has(k));
  if (allowed.size === 0 || forbidden.length > 0) {
    return NextResponse.json(
      {
        error: "Insufficient role for these fields",
        code: "FIELD_RBAC_FORBIDDEN",
        fields: forbidden.length > 0 ? forbidden : touched,
      },
      { status: 403 },
    );
  }
  return null;
}

async function verifyOrgOptimisticVersion(
  tx: TxClient,
  orgId: string,
  expectedVersion: number | undefined,
  currentVersion: number,
): Promise<void> {
  if (expectedVersion === undefined) return;
  const cas = await tx.organization.updateMany({
    where: { id: orgId, version: expectedVersion },
    data: { version: { increment: 1 } },
  });
  if (cas.count === 0) {
    throw Object.assign(
      new Error("Settings were changed in another session — reload and retry"),
      {
        httpStatus: 409,
        code: "VERSION_CONFLICT",
        currentVersion,
      },
    );
  }
}

async function verifyCanDisableSponsor(
  tx: TxClient,
  orgId: string,
  bodyCanSponsor: boolean | undefined,
  walletBalance: number,
): Promise<void> {
  if (bodyCanSponsor !== false) return;
  if (walletBalance > 0) {
    throw Object.assign(
      new Error(
        "Cannot disable canSponsor while wallet has a non-zero balance",
      ),
      { httpStatus: 409 },
    );
  }
  const now = new Date();
  const [outstandingInvoices, liveAssignments] = await Promise.all([
    tx.organizationInvoice.count({
      where: {
        organizationId: orgId,
        status: { in: ["ISSUED", "OVERDUE"] },
      },
    }),
    tx.programAssignment.count({
      where: {
        status: "ACTIVE",
        periodEnd: { gte: now },
        program: { contract: { organizationId: orgId } },
      },
    }),
  ]);
  if (outstandingInvoices > 0 || liveAssignments > 0) {
    throw Object.assign(new Error("CANSPONSOR_WINDDOWN_REQUIRED"), {
      httpStatus: 409,
      code: "CANSPONSOR_WINDDOWN_REQUIRED",
      counts: { outstandingInvoices, liveAssignments },
    });
  }
}

async function verifyCanDisableHost(
  tx: TxClient,
  orgId: string,
  bodyCanHost: boolean | undefined,
): Promise<void> {
  if (bodyCanHost !== false) return;
  const [experts, pendingPayouts, unsettledEarnings] = await Promise.all([
    tx.membership.count({
      where: {
        organizationId: orgId,
        role: "EXPERT",
        status: { in: ["ACTIVE", "PENDING"] },
      },
    }),
    tx.organizationPayout.count({
      where: {
        organizationId: orgId,
        status: { in: ["PENDING", "APPROVED", "PROCESSING"] },
      },
    }),
    tx.organizationEarnings.count({
      where: {
        organizationId: orgId,
        OR: [{ orgPayoutId: null }, { status: { not: "PAID" } }],
      },
    }),
  ]);
  if (experts > 0 || pendingPayouts > 0 || unsettledEarnings > 0) {
    throw Object.assign(new Error("CANHOST_WINDDOWN_REQUIRED"), {
      httpStatus: 409,
      code: "CANHOST_WINDDOWN_REQUIRED",
      counts: { experts, pendingPayouts, unsettledEarnings },
    });
  }
}

async function verifySlugAvailable(
  tx: TxClient,
  orgId: string,
  nextSlug: string | undefined,
  currentSlug: string,
): Promise<void> {
  if (!nextSlug || nextSlug === currentSlug) return;
  const slugTaken = await tx.organization.findUnique({
    where: { slug: nextSlug },
    select: { id: true },
  });
  if (slugTaken && slugTaken.id !== orgId) {
    throw Object.assign(new Error(`Slug "${nextSlug}" is already taken`), {
      httpStatus: 409,
    });
  }
}

function buildBrandingProfileUpsert(
  body: PatchBody,
): Prisma.OrganizationUpdateInput["brandingProfile"] | undefined {
  const hasBrandingField =
    body.logo !== undefined ||
    body.bannerImage !== undefined ||
    body.primaryColor !== undefined ||
    body.secondaryColor !== undefined ||
    body.description !== undefined ||
    body.industry !== undefined ||
    body.website !== undefined ||
    body.sizeBucket !== undefined;
  if (!hasBrandingField) return undefined;

  const fields = {
    ...(body.logo !== undefined && { logo: body.logo }),
    ...(body.bannerImage !== undefined && { bannerImage: body.bannerImage }),
    ...(body.primaryColor !== undefined && { primaryColor: body.primaryColor }),
    ...(body.secondaryColor !== undefined && {
      secondaryColor: body.secondaryColor,
    }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.industry !== undefined && { industry: body.industry }),
    ...(body.website !== undefined && { website: body.website }),
    ...(body.sizeBucket !== undefined && { sizeBucket: body.sizeBucket }),
  };
  return { upsert: { create: fields, update: fields } };
}

function buildTaxInfoUpsert(
  body: PatchBody,
  gstStateCode: string | null | undefined,
): Prisma.OrganizationUpdateInput["taxInfo"] | undefined {
  const hasTaxField =
    body.gstin !== undefined ||
    body.pan !== undefined ||
    body.gstRegStatus !== undefined ||
    gstStateCode !== undefined;
  if (!hasTaxField) return undefined;

  const baseFields = {
    ...(body.gstin !== undefined && { gstin: body.gstin }),
    ...(body.gstRegStatus !== undefined && { gstRegStatus: body.gstRegStatus }),
    ...(gstStateCode !== undefined && { gstStateCode }),
  };
  const encryptedPan = body.pan
    ? (() => {
        const { encrypted, last4 } = encryptPAN(body.pan);
        return { panEncrypted: encrypted, panLast4: last4 };
      })()
    : null;
  const updatePanFields =
    body.pan !== undefined
      ? (encryptedPan ?? { panEncrypted: null, panLast4: null })
      : {};

  return {
    upsert: {
      create: { ...baseFields, ...encryptedPan },
      update: { ...baseFields, ...updatePanFields },
    },
  };
}

function buildMsmeInfoUpsert(
  body: PatchBody,
): Prisma.OrganizationUpdateInput["msmeInfo"] | undefined {
  if (
    body.msmeStatus === undefined &&
    body.msmeWrittenAgreementOnFile === undefined
  ) {
    return undefined;
  }
  const fields = {
    ...(body.msmeStatus !== undefined && { msmeStatus: body.msmeStatus }),
    ...(body.msmeWrittenAgreementOnFile !== undefined && {
      msmeWrittenAgreementOnFile: body.msmeWrittenAgreementOnFile,
    }),
  };
  return { upsert: { create: fields, update: fields } };
}

function buildScalarOrganizationFields(
  d: PatchBody,
): Prisma.OrganizationUpdateInput {
  const data: Prisma.OrganizationUpdateInput = {};
  if (d.name !== undefined) data.name = d.name;
  if (d.slug !== undefined) data.slug = d.slug;
  if (d.billingEmail !== undefined) data.billingEmail = d.billingEmail;
  if (d.supportContactEmail !== undefined) {
    data.supportContactEmail = d.supportContactEmail;
  }
  if (d.escalationContactEmail !== undefined) {
    data.escalationContactEmail = d.escalationContactEmail;
  }
  if (d.canSponsor !== undefined) data.canSponsor = d.canSponsor;
  if (d.canHost !== undefined) data.canHost = d.canHost;
  if (d.requiresPO !== undefined) data.requiresPO = d.requiresPO;
  if (d.paymentTermsDays !== undefined) {
    data.paymentTermsDays = d.paymentTermsDays;
  }
  if (d.defaultCancellationPolicy !== undefined) {
    data.defaultCancellationPolicy = d.defaultCancellationPolicy;
  }
  if (d.defaultRefundPolicy !== undefined) {
    data.defaultRefundPolicy = d.defaultRefundPolicy;
  }
  if (d.isPublic !== undefined) data.isPublic = d.isPublic;
  if (d.streamRecordingRetentionDays !== undefined) {
    data.streamRecordingRetentionDays = d.streamRecordingRetentionDays;
  }
  return data;
}

function buildOrganizationUpdateData(
  body: PatchBody,
  gstStateCode: string | null | undefined,
): Prisma.OrganizationUpdateInput {
  const brandingProfile = buildBrandingProfileUpsert(body);
  const taxInfo = buildTaxInfoUpsert(body, gstStateCode);
  const msmeInfo = buildMsmeInfoUpsert(body);
  return {
    ...buildScalarOrganizationFields(body),
    ...(brandingProfile && { brandingProfile }),
    ...(taxInfo && { taxInfo }),
    ...(msmeInfo && { msmeInfo }),
  };
}

function buildTaggedErrorPayload(
  err: Error & Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { error: err.message };
  if (typeof err.code === "string") payload.code = err.code;
  if (err.counts && typeof err.counts === "object") payload.counts = err.counts;
  if (typeof err.currentVersion === "number") {
    payload.currentVersion = err.currentVersion;
  }
  return payload;
}

function formatPatchErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof Error && "httpStatus" in err) {
    const tagged = err as Error & Record<string, unknown>;
    const status =
      typeof tagged.httpStatus === "number" ? tagged.httpStatus : 500;
    return NextResponse.json(buildTaggedErrorPayload(tagged), { status });
  }
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2034"
  ) {
    return NextResponse.json(
      { error: "Transaction conflict — please retry", code: "P2034" },
      { status: 503 },
    );
  }
  return null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    // Pre-verification orgs update branding/tax details here before resubmitting (requireActive: true omitted; SUSPENDED rejected below).
  });
  if (access.error) return access.error;
  if (access.org?.status === "SUSPENDED") {
    return NextResponse.json(
      {
        error: "ORG_NOT_ACTIVE",
        message: "Organization settings cannot be modified while suspended.",
        status: access.org.status,
      },
      { status: 409 },
    );
  }

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;
  if (
    access.org?.status &&
    access.org.status !== "ACTIVE" &&
    (body.canSponsor !== undefined ||
      body.canHost !== undefined ||
      body.slug !== undefined ||
      body.billingEmail !== undefined ||
      body.requiresPO !== undefined ||
      body.paymentTermsDays !== undefined ||
      body.defaultCancellationPolicy !== undefined ||
      body.defaultRefundPolicy !== undefined ||
      body.isPublic !== undefined ||
      body.msmeStatus !== undefined ||
      body.msmeWrittenAgreementOnFile !== undefined ||
      body.streamRecordingRetentionDays !== undefined)
  ) {
    return NextResponse.json(
      {
        error: "ORG_NOT_ACTIVE",
        code: "ORG_NOT_ACTIVE",
        message:
          "Only branding and tax verification fields can be updated before the organization is verified.",
        status: access.org.status,
      },
      { status: 409 },
    );
  }
  if (body.canHost && !isHostOrgsEnabled()) {
    return NextResponse.json(
      {
        error:
          "Host-capable orgs are gated by ENABLE_HOST_ORGS. Contact ops to flip the flag for your tenant.",
        code: "HOST_ORGS_GATED",
      },
      { status: 400 },
    );
  }
  // #1744 row 3 — a supplied GSTIN's prefix is the buyer's GST state and wins
  // over a hand-typed code; without a GSTIN the typed code (or null) stands.
  const gstStateCode: string | null | undefined = body.gstin
    ? (numericStateCode(body.gstin, null) ?? body.gstStateCode)
    : body.gstStateCode;
  // A sponsoring domestic org is invoiced B2B, so its GST state is mandatory.
  const invoicedB2b =
    (body.canSponsor ?? access.org.canSponsor) &&
    access.org.dataResidencyRegion === "IN";
  const startsSponsoring = body.canSponsor === true && !access.org.canSponsor;
  const leavesNoGstState =
    gstStateCode === null ||
    (gstStateCode === undefined &&
      startsSponsoring &&
      !(
        await prisma.organizationTaxInfo.findUnique({
          where: { organizationId: orgId },
          select: { gstStateCode: true },
        })
      )?.gstStateCode);
  if (invoicedB2b && leavesNoGstState) {
    return NextResponse.json(
      {
        error:
          "A GST state is required for an organisation that is invoiced. Choose your state, or add your GSTIN.",
        code: "GST_STATE_REQUIRED",
      },
      { status: 400 },
    );
  }

  // Field-level gate: settings.ownerFields passes everything; otherwise every
  // touched field must be inside the caller's remit. 403 names the offending
  // fields so the dashboard can explain instead of a silent failure.
  const rbacError = hasOrgPermission(access.member.role, "settings.ownerFields")
    ? null
    : checkFieldRbac(access.member.role, body);
  if (rbacError) return rbacError;

  // Captured inside the transaction so a slug rename can purge the OLD public
  // path too — otherwise its cached document keeps being served under a URL the
  // org no longer answers to.
  let previousSlug: string | undefined;

  try {
    // Serializable closes the TOCTOU between the wind-down COUNT checks below
    // and the UPDATE (S2 in the state audit): a concurrent invoice/assignment
    // insert aborts one side with P2034 (retried, then 503) instead of
    // slipping into the window and stranding obligations behind a flipped flag.
    const updated = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const current = await tx.organization.findUnique({
            where: { id: orgId },
            include: {
              billingAccount: { select: { id: true, walletBalance: true } },
            },
          });
          previousSlug = current?.slug;
          if (!current) {
            throw Object.assign(new Error("Organization not found"), {
              httpStatus: 404,
            });
          }

          await verifyOrgOptimisticVersion(
            tx,
            orgId,
            body.expectedVersion,
            current.version,
          );

          const nextCanSponsor = body.canSponsor ?? current.canSponsor;
          const nextCanHost = body.canHost ?? current.canHost;
          if (!nextCanSponsor && !nextCanHost) {
            throw Object.assign(
              new Error(
                "Cannot disable both capabilities — at least one of canSponsor/canHost must remain true.",
              ),
              { httpStatus: 409 },
            );
          }

          await verifyCanDisableSponsor(
            tx,
            orgId,
            body.canSponsor,
            current.billingAccount?.walletBalance ?? 0,
          );
          await verifyCanDisableHost(tx, orgId, body.canHost);
          await verifySlugAvailable(tx, orgId, body.slug, current.slug);

          const next = await tx.organization.update({
            where: { id: orgId },
            data: buildOrganizationUpdateData(body, gstStateCode),
          });

          await tx.orgAuditLog.create({
            data: {
              organizationId: orgId,
              actorMembershipId: access.member.id,
              category: "SETTINGS",
              action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
              description: "Organization record updated",
              details: { patch: body },
            },
          });

          // Retention drives automatic deletion, so it gets its own filterable row.
          if (
            body.streamRecordingRetentionDays !== undefined &&
            body.streamRecordingRetentionDays !==
              current.streamRecordingRetentionDays
          ) {
            await tx.orgAuditLog.create({
              data: {
                organizationId: orgId,
                actorMembershipId: access.member.id,
                category: "SYSTEM",
                action: AUDIT_ACTIONS.SYSTEM.STREAM_RETENTION_CHANGED,
                description: "Recording retention window changed",
                details: {
                  previous: current.streamRecordingRetentionDays,
                  next: body.streamRecordingRetentionDays,
                },
              },
            });
          }

          return next;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    // isPublic, slug, name and the whole brandingProfile upsert are all rendered
    // on the public directory and org profile, so publish the change now instead
    // of leaving it behind the ISR window.
    purgeOrgSurfaces(updated.slug, previousSlug);

    return NextResponse.json({ organization: updated });
  } catch (err) {
    const formatted = formatPatchErrorResponse(err);
    if (formatted) return formatted;
    throw err;
  }
}

async function assertNoLiveOrgObligations(
  tx: TxClient,
  orgId: string,
): Promise<void> {
  const current = await tx.organization.findUnique({
    where: { id: orgId },
    select: {
      deletedAt: true,
      billingAccount: { select: { walletBalance: true } },
      _count: {
        select: {
          contracts: { where: { status: { in: ["DRAFT", "ACTIVE"] } } },
          invoices: {
            where: { status: { in: ["ISSUED", "OVERDUE"] } },
          },
          purchaseOrders: {
            where: { remainingAmountPaise: { gt: 0 } },
          },
          earnings: {
            where: {
              // #837 — BATCHED is unsettled (payout in flight, cash not moved yet).
              status: {
                in: ["PENDING_TRUST", "PENDING", "HELD", "READY", "BATCHED"],
              },
            },
          },
          payouts: {
            where: {
              status: { in: ["PENDING", "APPROVED", "PROCESSING"] },
            },
          },
        },
      },
    },
  });
  if (!current || current.deletedAt) {
    throw Object.assign(new Error("Organization not found"), {
      httpStatus: 404,
    });
  }
  // #1744 row 6 — money not yet on any invoice blocks too: an unbilled
  // INVOICE accrual and a PENDING/ACCRUED overage would vanish with the org.
  const [unbilledAccruals, openOverages] = await Promise.all([
    tx.payment.count({
      where: {
        organizationId: orgId,
        paymentStatus: "SUCCEEDED",
        billableToOrgInvoiceId: null,
        legs: {
          some: {
            source: {
              in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"],
            },
          },
        },
      },
    }),
    tx.overageEvent.count({
      where: {
        programAssignment: {
          program: { contract: { organizationId: orgId } },
        },
        chargeStatus: { in: ["PENDING", "ACCRUED"] },
      },
    }),
  ]);

  const live = [
    current._count.contracts > 0 &&
      `${current._count.contracts} draft/active contract(s)`,
    current._count.invoices > 0 &&
      `${current._count.invoices} unpaid invoice(s)`,
    current._count.purchaseOrders > 0 &&
      `${current._count.purchaseOrders} open purchase order(s)`,
    current._count.earnings > 0 &&
      `${current._count.earnings} unsettled earning(s)`,
    current._count.payouts > 0 &&
      `${current._count.payouts} in-flight payout(s)`,
    (current.billingAccount?.walletBalance ?? 0) !== 0 &&
      "a non-zero wallet balance",
    unbilledAccruals > 0 && `${unbilledAccruals} unbilled invoice accrual(s)`,
    openOverages > 0 && `${openOverages} unsettled overage charge(s)`,
  ].filter((item): item is string => Boolean(item));

  if (live.length > 0) {
    throw Object.assign(
      new Error(
        `Wind-down required before deletion: this organization still has ${live.join(", ")}.`,
      ),
      { httpStatus: 409 },
    );
  }
}

async function hasSettledFinancialHistory(
  tx: TxClient,
  orgId: string,
): Promise<boolean> {
  const history = await tx.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: {
      _count: {
        select: {
          contracts: true,
          invoices: true,
          purchaseOrders: true,
          earnings: true,
          payouts: true,
        },
      },
      billingAccountId: true,
    },
  });
  return (
    history._count.contracts +
      history._count.invoices +
      history._count.purchaseOrders +
      history._count.earnings +
      history._count.payouts >
      0 || history.billingAccountId !== null
  );
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "org.delete" });
  if (access.error) return access.error;

  try {
    // Serializable + retry closes the same TOCTOU the PATCH handler cites
    // (state-audit S2): an invoice/assignment/PO landing between the
    // wind-down COUNT checks and the delete would be stranded behind a
    // DEACTIVATED org. A concurrent insert now aborts one side with P2034
    // (retried, then 503) instead of slipping through the window
    // (#1132 follow-up — the PATCH handler already did this; DELETE didn't).
    const outcome = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // #781 §B — three-way delete. LIVE obligations block (wind-down
          // first, per the #779 guard doctrine). Settled financial HISTORY
          // makes the org soft-delete (DEACTIVATED + deletedAt + contact-PII
          // scrub) — the Restrict FKs on earnings/payouts make a hard delete
          // impossible at the DB level anyway. Only a money-untouched shell
          // may hard-delete.
          await assertNoLiveOrgObligations(tx, orgId);

          if (!(await hasSettledFinancialHistory(tx, orgId))) {
            const strandedCalls = tx.meeting?.findMany
              ? await tx.meeting.findMany({
                  where: { organizationId: orgId, endedAt: null },
                  select: {
                    id: true,
                    streamCallId: true,
                  },
                })
              : [];

            // #2006 — Restrict FKs on OrgAuditLog, OrganizationPayoutAccount,
            // and RateCard protect settled history; on a money-untouched shell
            // org, clear any onboarding/setup rows before the hard delete.
            if (typeof tx.orgAuditLog?.deleteMany === "function") {
              await tx.orgAuditLog.deleteMany({
                where: { organizationId: orgId },
              });
            }
            if (
              typeof tx.organizationPayoutAccount?.deleteMany === "function"
            ) {
              await tx.organizationPayoutAccount.deleteMany({
                where: { organizationId: orgId },
              });
            }
            if (typeof tx.rateCard?.deleteMany === "function") {
              await tx.rateCard.deleteMany({
                where: { ownerOrgId: orgId },
              });
            }

            await tx.organization.delete({ where: { id: orgId } });
            return {
              kind: "hard" as const,
              strandedCalls,
            };
          }

          // Soft delete: name/slug/GSTIN/PAN stay (issued invoices reference
          // them — statutory retention); personal contact details are scrubbed
          // per DPDP. The CAS in transitionOrganization makes DEACTIVATED
          // unreachable from itself — a concurrent second DELETE 409s instead of
          // re-stamping deletedAt.
          await transitionOrganization(tx, {
            where: { id: orgId },
            to: "DEACTIVATED",
            data: {
              deletedAt: new Date(),
              billingEmail: null,
              billingContactName: null,
              billingContactEmail: null,
              billingContactPhone: null,
              supportContactName: null,
              supportContactEmail: null,
              escalationContactEmail: null,
            },
            audit: {
              organizationId: orgId,
              actorMembershipId: access.member.id,
              category: "SETTINGS",
              action: AUDIT_ACTIONS.SETTINGS.ORG_SOFT_DELETED,
              description:
                "Organization soft-deleted (financial history retained)",
            },
          });
          return { kind: "soft" as const };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    if (outcome.kind === "hard") {
      await settleHardDeleteStreamTeardown(outcome);
      return new NextResponse(null, { status: 204 });
    }
    return NextResponse.json({ softDeleted: true }, { status: 200 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    // CR #1234 — exhausted Serializable retries surface as a raw P2034
    // throw; the PATCH handler maps the same case to a retryable 503.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2034"
    ) {
      return NextResponse.json(
        { error: "Transaction conflict — please retry", code: "P2034" },
        { status: 503 },
      );
    }
    throw err;
  }
}

async function settleHardDeleteStreamTeardown(outcome: {
  strandedCalls: { id: string; streamCallId: string }[];
}): Promise<void> {
  if (outcome.strandedCalls.length === 0 || !isStreamConfigured()) return;

  const { errors } = await endActiveStreamVideoCalls(outcome.strandedCalls, {
    now: new Date(),
    endedReason: ORG_DELETED_CALL_REASON,
    errorPrefix: "org hard-delete",
  });
  for (const error of errors) {
    streamLogger.warn(
      "Failed to settle Stream call teardown on org hard-delete",
      { error },
    );
  }
}
