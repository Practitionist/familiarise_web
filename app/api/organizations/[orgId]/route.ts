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
import prisma from "@/lib/prisma";
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
import { numericStateCode } from "@/lib/compliance/state-codes";
import { reportSentryError } from "@/lib/observability/report";
import { deleteRecordingObject } from "@/lib/stream/recording-storage";
import { deleteRecordingPreviewAssets } from "@/lib/supabase";

/**
 * `Meeting.endedReason` marker meaning "the owning org is hard-deleted and this
 * call still needs tearing down".
 *
 * Declared here rather than imported from `jobs/stream/wind-down-deactivated-orgs`
 * so a DELETE request never pulls a cron module's graph (`dotenv/config`,
 * `runJob`, the Stream pacing constants) into a Lambda. It MUST stay identical to
 * that job's `ORG_DELETED_TEARDOWN_MARKER`, which is what drains the rows
 * written here — `__tests__/stream/org-wind-down.test.ts` pins the two against
 * each other so a rename on either side fails a test rather than silently
 * orphaning every call a deleted org left behind.
 */
const ORG_DELETED_TEARDOWN_MARKER = "org_deleted";

/** What the hard-delete branch captures before the `Organization` row goes. */
interface HardDeleteTeardown {
  strandedCalls: { id: string; streamCallId: string }[];
  strandedRecordings: {
    id: string;
    storagePath: string | null;
    listingStatus: string;
  }[];
}

/**
 * End the calls and purge the bytes a hard-deleted org left behind.
 *
 * Best-effort by construction: every step is individually caught and reported,
 * because the local facts (the org is gone; its replays are unpublished) have
 * already committed and must not be undone by a vendor or storage outage. The
 * `org_deleted` marker on each `Meeting` is what makes a call that Stream would
 * not end retryable — `jobs/stream/wind-down-deactivated-orgs` Stage 1 re-drives
 * it and clears the marker when Stream confirms.
 */
async function settleHardDeleteStreamTeardown(
  outcome: HardDeleteTeardown,
): Promise<void> {
  // Lazy: a static Stream import would put the client graph into every org CRUD
  // request, not just the delete path.
  const {
    getStreamVideoClient,
    isExpectedStreamError,
    withStreamCircuitBreaker,
  } = await import("@/lib/stream-client");
  const { STREAM_CALL_TYPE, toCallId } = await import("@/lib/stream/call-cid");

  const endedMeetingIds: string[] = [];
  for (const meeting of outcome.strandedCalls) {
    try {
      await withStreamCircuitBreaker(() =>
        getStreamVideoClient()
          .video.call(STREAM_CALL_TYPE, toCallId(meeting.streamCallId))
          .end(),
      );
      endedMeetingIds.push(meeting.id);
    } catch (err) {
      // "Stream is up and there is no such call" is the state this step exists
      // to reach — a room opened and closed before anyone joined. An outage
      // never looks like this.
      if (isExpectedStreamError(err)) {
        endedMeetingIds.push(meeting.id);
        continue;
      }
      reportSentryError(err, {
        subsystem: "stream",
        op: "org.hard-delete.end-call",
        extra: { meetingId: meeting.id, streamCallId: meeting.streamCallId },
      });
    }
  }

  // Clear the marker only for calls Stream confirmed, and only while it still
  // carries our value — the `call.ended` webhook overwrites `endedReason`, and
  // undoing that would lose the reason a session ended.
  if (endedMeetingIds.length > 0) {
    await prisma.meeting
      .updateMany({
        where: {
          id: { in: endedMeetingIds },
          endedReason: ORG_DELETED_TEARDOWN_MARKER,
        },
        data: { endedReason: null },
      })
      .catch((err) =>
        reportSentryError(err, {
          subsystem: "stream",
          op: "org.hard-delete.clear-marker",
          extra: { meetingIds: endedMeetingIds },
        }),
      );
  }

  // Bytes BEFORE the tombstone, as `cleanup-old-stream-recordings` does it: an
  // EXPIRED row whose object was never deleted is orphaned storage, and that
  // cron's `organizationId` filter can no longer reach it now the org is gone.
  const purgedIds: string[] = [];
  for (const recording of outcome.strandedRecordings) {
    await deleteRecordingPreviewAssets(recording.id);
    if (!recording.storagePath) {
      purgedIds.push(recording.id);
      continue;
    }
    try {
      const deleted = await deleteRecordingObject(recording.storagePath);
      if (deleted.success) purgedIds.push(recording.id);
      else {
        reportSentryError(new Error(deleted.error ?? "object delete failed"), {
          subsystem: "stream",
          op: "org.hard-delete.delete-recording",
          extra: { recordingId: recording.id },
        });
      }
    } catch (err) {
      reportSentryError(err, {
        subsystem: "stream",
        op: "org.hard-delete.delete-recording",
        extra: { recordingId: recording.id },
      });
    }
  }
  if (purgedIds.length > 0) {
    await prisma.recording
      .updateMany({
        where: { id: { in: purgedIds } },
        data: {
          status: "EXPIRED",
          storageUrl: null,
          storagePath: null,
          storageType: "STREAM_S3",
        },
      })
      .catch((err) =>
        reportSentryError(err, {
          subsystem: "stream",
          op: "org.hard-delete.tombstone-recording",
          extra: { recordingIds: purgedIds },
        }),
      );
  }
}

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
    canSponsor: z.boolean().optional(),
    canHost: z.boolean().optional(),
    requiresPO: z.boolean().optional(),
    paymentTermsDays: z.coerce.number().int().min(0).max(180).optional(),
    gstin: z.string().length(15).nullable().optional(),
    pan: z.string().length(10).nullable().optional(),
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
  const access = await requireOrgAccess(orgId, { allowSuspended: true });
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
]);
const BILLING_ADMIN_FIELDS = new Set(["billingEmail", "paymentTermsDays"]);
// Concurrency control, not a writable column: the optimistic-lock CAS below is
// what enforces it, and every dashboard save echoes it back. Counting it as a
// touched field 403'd every non-OWNER save regardless of what was edited.
const CONTROL_FIELDS = new Set(["expectedVersion"]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;
  // #1744 row 3 — a supplied GSTIN's prefix is the buyer's GST state and wins
  // over a hand-typed code; without a GSTIN the typed code (or null) stands.
  const gstStateCode: string | null | undefined = body.gstin
    ? (numericStateCode(body.gstin, null) ?? body.gstStateCode)
    : body.gstStateCode;

  // Field-level gate: settings.ownerFields passes everything; otherwise every
  // touched field must be inside the caller's remit. 403 names the offending
  // fields so the dashboard can explain instead of a silent failure.
  const role = access.member.role;
  if (!hasOrgPermission(role, "settings.ownerFields")) {
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
  }

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

          // Optimistic lock — a stale tab (multi-tab toggle race) 409s instead of
          // last-write-wins. The CAS also takes the row lock, serializing the rich
          // nested update below behind it.
          if (body.expectedVersion !== undefined) {
            const cas = await tx.organization.updateMany({
              where: { id: orgId, version: body.expectedVersion },
              data: { version: { increment: 1 } },
            });
            if (cas.count === 0) {
              throw Object.assign(
                new Error(
                  "Settings were changed in another session — reload and retry",
                ),
                {
                  httpStatus: 409,
                  code: "VERSION_CONFLICT",
                  currentVersion: current.version,
                },
              );
            }
          }

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

          // Turning canSponsor OFF with a non-zero wallet would orphan the
          // money. The owner must drain or refund the wallet first.
          if (
            body.canSponsor === false &&
            (current.billingAccount?.walletBalance ?? 0) > 0
          ) {
            throw Object.assign(
              new Error(
                "Cannot disable canSponsor while wallet has a non-zero balance",
              ),
              { httpStatus: 409 },
            );
          }

          // #779 §A — canSponsor wind-down: beyond the wallet, the org must
          // settle outstanding invoices and let live sponsorships lapse before
          // it can stop sponsoring. ISSUED/OVERDUE = billed-but-unpaid;
          // ACTIVE assignments still in-cycle (periodEnd>=now) draw real spend.
          if (body.canSponsor === false) {
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

          // #779 §A — canHost wind-down: the org can't stop hosting while it
          // still has experts on the roster or payout money in flight.
          // unsettledEarnings = org-share rows not yet attached to a payout
          // (orgPayoutId null) OR attached but not PAID — either way the money
          // hasn't reached the org's bank.
          if (body.canHost === false) {
            const [experts, pendingPayouts, unsettledEarnings] =
              await Promise.all([
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

          // Slug uniqueness — only check on actual change so a no-op PATCH
          // (e.g., wizard resubmit) doesn't 409 against the org's own row.
          if (body.slug && body.slug !== current.slug) {
            const slugTaken = await tx.organization.findUnique({
              where: { slug: body.slug },
              select: { id: true },
            });
            if (slugTaken && slugTaken.id !== orgId) {
              throw Object.assign(
                new Error(`Slug "${body.slug}" is already taken`),
                { httpStatus: 409 },
              );
            }
          }

          const next = await tx.organization.update({
            where: { id: orgId },
            data: {
              ...(body.name !== undefined && { name: body.name }),
              ...(body.slug !== undefined && { slug: body.slug }),
              ...(body.billingEmail !== undefined && {
                billingEmail: body.billingEmail,
              }),
              ...(body.canSponsor !== undefined && {
                canSponsor: body.canSponsor,
              }),
              ...(body.canHost !== undefined && { canHost: body.canHost }),
              ...(body.requiresPO !== undefined && {
                requiresPO: body.requiresPO,
              }),
              ...(body.paymentTermsDays !== undefined && {
                paymentTermsDays: body.paymentTermsDays,
              }),
              // logo / bannerImage / primaryColor / secondaryColor / description /
              // industry / website / sizeBucket live on the OrgBrandingProfile
              // satellite (#768 lockdown #6), not Organization — write them via
              // the brandingProfile relation. Same runtime/tsc dynamic as the
              // taxInfo block below: the conditional-spread pattern hides the
              // mistake from tsc until Prisma rejects it at runtime.
              ...(body.logo !== undefined ||
              body.bannerImage !== undefined ||
              body.primaryColor !== undefined ||
              body.secondaryColor !== undefined ||
              body.description !== undefined ||
              body.industry !== undefined ||
              body.website !== undefined ||
              body.sizeBucket !== undefined
                ? {
                    brandingProfile: {
                      upsert: {
                        create: {
                          ...(body.logo !== undefined && { logo: body.logo }),
                          ...(body.bannerImage !== undefined && {
                            bannerImage: body.bannerImage,
                          }),
                          ...(body.primaryColor !== undefined && {
                            primaryColor: body.primaryColor,
                          }),
                          ...(body.secondaryColor !== undefined && {
                            secondaryColor: body.secondaryColor,
                          }),
                          ...(body.description !== undefined && {
                            description: body.description,
                          }),
                          ...(body.industry !== undefined && {
                            industry: body.industry,
                          }),
                          ...(body.website !== undefined && {
                            website: body.website,
                          }),
                          ...(body.sizeBucket !== undefined && {
                            sizeBucket: body.sizeBucket,
                          }),
                        },
                        update: {
                          ...(body.logo !== undefined && { logo: body.logo }),
                          ...(body.bannerImage !== undefined && {
                            bannerImage: body.bannerImage,
                          }),
                          ...(body.primaryColor !== undefined && {
                            primaryColor: body.primaryColor,
                          }),
                          ...(body.secondaryColor !== undefined && {
                            secondaryColor: body.secondaryColor,
                          }),
                          ...(body.description !== undefined && {
                            description: body.description,
                          }),
                          ...(body.industry !== undefined && {
                            industry: body.industry,
                          }),
                          ...(body.website !== undefined && {
                            website: body.website,
                          }),
                          ...(body.sizeBucket !== undefined && {
                            sizeBucket: body.sizeBucket,
                          }),
                        },
                      },
                    },
                  }
                : {}),
              // gstin / pan / gstRegStatus / gstStateCode live on the
              // OrganizationTaxInfo satellite, not Organization — write them via the
              // taxInfo relation (a direct write here is a Prisma runtime error the
              // conditional-spread pattern hides from tsc).
              ...(body.gstin !== undefined ||
              body.pan !== undefined ||
              body.gstRegStatus !== undefined ||
              gstStateCode !== undefined
                ? {
                    taxInfo: {
                      upsert: {
                        create: {
                          ...(body.gstin !== undefined && {
                            gstin: body.gstin,
                          }),
                          ...(body.gstRegStatus !== undefined && {
                            gstRegStatus: body.gstRegStatus,
                          }),
                          ...(gstStateCode !== undefined && { gstStateCode }),
                          ...(body.pan
                            ? (() => {
                                const { encrypted, last4 } = encryptPAN(
                                  body.pan,
                                );
                                return {
                                  panEncrypted: encrypted,
                                  panLast4: last4,
                                };
                              })()
                            : {}),
                        },
                        update: {
                          ...(body.gstin !== undefined && {
                            gstin: body.gstin,
                          }),
                          ...(body.gstRegStatus !== undefined && {
                            gstRegStatus: body.gstRegStatus,
                          }),
                          ...(gstStateCode !== undefined && { gstStateCode }),
                          ...(body.pan !== undefined &&
                            (body.pan
                              ? (() => {
                                  const { encrypted, last4 } = encryptPAN(
                                    body.pan,
                                  );
                                  return {
                                    panEncrypted: encrypted,
                                    panLast4: last4,
                                  };
                                })()
                              : { panEncrypted: null, panLast4: null })),
                        },
                      },
                    },
                  }
                : {}),
              // MSME satellite — same conditional-relation pattern as taxInfo
              // above (#1230 intake writer for the payout-deadline engine).
              ...(body.msmeStatus !== undefined ||
              body.msmeWrittenAgreementOnFile !== undefined
                ? {
                    msmeInfo: {
                      upsert: {
                        create: {
                          ...(body.msmeStatus !== undefined && {
                            msmeStatus: body.msmeStatus,
                          }),
                          ...(body.msmeWrittenAgreementOnFile !== undefined && {
                            msmeWrittenAgreementOnFile:
                              body.msmeWrittenAgreementOnFile,
                          }),
                        },
                        update: {
                          ...(body.msmeStatus !== undefined && {
                            msmeStatus: body.msmeStatus,
                          }),
                          ...(body.msmeWrittenAgreementOnFile !== undefined && {
                            msmeWrittenAgreementOnFile:
                              body.msmeWrittenAgreementOnFile,
                          }),
                        },
                      },
                    },
                  }
                : {}),
              ...(body.defaultCancellationPolicy !== undefined && {
                defaultCancellationPolicy: body.defaultCancellationPolicy,
              }),
              ...(body.defaultRefundPolicy !== undefined && {
                defaultRefundPolicy: body.defaultRefundPolicy,
              }),
              ...(body.isPublic !== undefined && { isPublic: body.isPublic }),
            },
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
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      // #779 §A — forward the structured wind-down code + counts so the UI
      // can render the per-blocker message instead of a bare 409. The
      // VERSION_CONFLICT branch additionally carries currentVersion so the
      // client can refetch-and-retry without an extra GET.
      const code =
        "code" in err && typeof err.code === "string" ? err.code : undefined;
      const counts =
        "counts" in err && err.counts && typeof err.counts === "object"
          ? err.counts
          : undefined;
      const currentVersion =
        "currentVersion" in err && typeof err.currentVersion === "number"
          ? err.currentVersion
          : undefined;
      return NextResponse.json(
        {
          error: err.message,
          ...(code && { code }),
          ...(counts && { counts }),
          ...(currentVersion !== undefined && { currentVersion }),
        },
        { status },
      );
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
    throw err;
  }
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
                        in: [
                          "PENDING_TRUST",
                          "PENDING",
                          "HELD",
                          "READY",
                          "BATCHED",
                        ],
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

          const live: string[] = [];
          if (current._count.contracts > 0)
            live.push(`${current._count.contracts} draft/active contract(s)`);
          if (current._count.invoices > 0)
            live.push(`${current._count.invoices} unpaid invoice(s)`);
          if (current._count.purchaseOrders > 0)
            live.push(
              `${current._count.purchaseOrders} open purchase order(s)`,
            );
          if (current._count.earnings > 0)
            live.push(`${current._count.earnings} unsettled earning(s)`);
          if (current._count.payouts > 0)
            live.push(`${current._count.payouts} in-flight payout(s)`);
          if ((current.billingAccount?.walletBalance ?? 0) !== 0)
            live.push("a non-zero wallet balance");
          if (unbilledAccruals > 0)
            live.push(`${unbilledAccruals} unbilled invoice accrual(s)`);
          if (openOverages > 0)
            live.push(`${openOverages} unsettled overage charge(s)`);
          if (live.length > 0) {
            throw Object.assign(
              new Error(
                `Wind-down required before deletion: this organization still has ${live.join(", ")}.`,
              ),
              { httpStatus: 409 },
            );
          }

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
          const hasHistory =
            history._count.contracts +
              history._count.invoices +
              history._count.purchaseOrders +
              history._count.earnings +
              history._count.payouts >
              0 || history.billingAccountId !== null;

          if (!hasHistory) {
            // ── The Stream half of a HARD delete ───────────────────────────────
            //
            // `Meeting.organizationId` and `Recording.organizationId` are both
            // `onDelete: SetNull`, so deleting the `Organization` row used to leave
            // the `Meeting` rows pointing at LIVE Stream call ids with no tenant tag
            // at all — orphaned, unattributable calls that no org query could find
            // again, and recordings the retention cron (which keys on
            // organizationId) could never reach either.
            //
            // So the teardown targets are captured and MARKED inside this same
            // transaction. `endedReason: "org_deleted"` means "the owning org is
            // gone and this call still needs ending", which is true at the moment it
            // is written, and `jobs/stream/wind-down-deactivated-orgs` Stage 1
            // drains it. The marker is what turns an unfindable orphan back into a
            // findable queue: without it, a crash between commit and the Stream
            // calls would lose the obligation permanently.
            //
            // Unpublishing the recordings is also done here, because it is a pure
            // local write that must be atomic with the org row disappearing — a
            // deleted org's replay must never be sellable on Explore again. The
            // BYTES are deleted after commit: a storage call never runs inside this
            // transaction.
            const strandedCalls = await tx.meeting.findMany({
              where: { organizationId: orgId, endedAt: null },
              select: { id: true, streamCallId: true },
            });
            const strandedRecordings = await tx.recording.findMany({
              where: { organizationId: orgId },
              select: { id: true, storagePath: true, listingStatus: true },
            });
            if (strandedCalls.length > 0) {
              await tx.meeting.updateMany({
                where: { id: { in: strandedCalls.map((m) => m.id) } },
                data: { endedReason: ORG_DELETED_TEARDOWN_MARKER },
              });
            }
            if (strandedRecordings.length > 0) {
              await tx.recording.updateMany({
                where: {
                  id: { in: strandedRecordings.map((r) => r.id) },
                  listingStatus: { not: "UNPUBLISHED" },
                },
                data: { listingStatus: "UNPUBLISHED", publishedAt: null },
              });
            }

            await tx.organization.delete({ where: { id: orgId } });
            return { mode: "hard" as const, strandedCalls, strandedRecordings };
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
          return { mode: "soft" as const };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    // ── Stream settlement, after commit ────────────────────────────────────
    //
    // Only the HARD branch has work to do here. The soft branch writes
    // `DEACTIVATED`, and that IS the durable record of the work: the wind-down
    // job finds it within a day and ends the calls, freezes the channels and
    // revokes the members' tokens. Doing that inline would mean a request-time
    // vendor workload sized by the org's membership, inside a Lambda.
    //
    // Nothing below can fail the DELETE. The org row is already gone and the
    // local unpublishing has already committed, so a Stream failure is captured
    // and the `org_deleted` markers are left standing for the job to re-drive.
    if (outcome.mode === "hard") {
      await settleHardDeleteStreamTeardown(outcome);
    }

    return outcome.mode === "hard"
      ? new NextResponse(null, { status: 204 })
      : NextResponse.json({ softDeleted: true }, { status: 200 });
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
