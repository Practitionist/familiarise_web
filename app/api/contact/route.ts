/**
 * POST /api/contact
 *
 * #1132 — the lead-capture endpoint the /contactus form never had. Both
 * /enterprise CTAs point at that form, so until this existed every enterprise
 * lead was discarded by the browser's default form submit.
 *
 * Public and unauthenticated by necessity — a prospect has no account yet — so
 * it carries the same protections as the other public write endpoints: a
 * per-IP rate limit, a honeypot, and strict length caps. Delivery failures fall
 * through to the FailedEmail retry worker rather than being swallowed.
 */

import { createHash, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { sendContactInquiryEmail } from "@/lib/email";
import { applyRateLimit, getClientIp, spamLimiter } from "@/lib/rate-limit";
import { allocateTicketReference } from "@/lib/support/reference";
import { supportDeadline } from "@/lib/support/deadline-policy";
import { slaDeadlinesFor } from "@/lib/support/sla";
import { stageSupportCaseIntakeTx } from "@/lib/support/case-service";
import {
  resolvePublicIntakeUserId,
  stageExternalIntakeReceiptTx,
} from "@/lib/support/external-requester";
import { INQUIRY_CATEGORIES } from "@/app/(pages)/constants";
import {
  DEMO_BUDGET_BANDS,
  DEMO_BUDGET_BAND_VALUES,
  DEMO_TEAM_SIZES,
  DEMO_TEAM_SIZE_VALUES,
  DEMO_USE_CASES,
  DEMO_USE_CASE_VALUES,
} from "@/app/enterprise/demo/constants";

const CATEGORY_SET = new Set<string>(INQUIRY_CATEGORIES.map((c) => c.value));

const ContactBodySchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().min(1, "Last name is required").max(100),
  email: z.string().trim().email("Enter a valid email address").max(320),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  subject: z.string().trim().min(1, "Subject is required").max(200),
  message: z.string().trim().min(1, "Message is required").max(5000),
  category: z
    .string()
    .refine((v) => v === "" || CATEGORY_SET.has(v), {
      message: "Unknown inquiry category",
    })
    .optional()
    .or(z.literal("")),
  // Sent only by the /enterprise/demo form.
  // One line only: a newline here would let a submitter forge the labelled
  // lines appended to the lead message.
  companyName: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v.replace(/\s+/g, " "))
    .optional(),
  useCase: z.enum(DEMO_USE_CASE_VALUES).optional(),
  teamSize: z.enum(DEMO_TEAM_SIZE_VALUES).optional(),
  budgetBand: z.enum(DEMO_BUDGET_BAND_VALUES).optional(),
  // Honeypot: a real person never fills a hidden field. Bots fill everything.
  // Present in the payload but never rendered visibly.
  website: z.string().max(200).optional(),
});

type ContactBody = z.infer<typeof ContactBodySchema>;

const LEAD_CATEGORIES = new Set(["enterprise", "team-training"]);

/** The demo form's structured answers, appended so staff see them in the lead and the email. */
function messageWithDemoDetails(data: ContactBody): string {
  const label = (
    options: readonly { value: string; label: string }[],
    value: string | undefined,
  ) => options.find((o) => o.value === value)?.label;
  const lines: [string, string][] = [];
  const add = (key: string, value: string | undefined) => {
    if (value) lines.push([key, value]);
  };
  add("Company", data.companyName);
  add("Interested in", label(DEMO_USE_CASES, data.useCase));
  add("Team size", label(DEMO_TEAM_SIZES, data.teamSize));
  add("Budget", label(DEMO_BUDGET_BANDS, data.budgetBand));
  if (lines.length === 0) return data.message;
  return `${data.message}\n\n${lines.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
}

async function recordContactLeadIfApplicable(data: ContactBody): Promise<void> {
  if (!LEAD_CATEGORIES.has(data.category ?? "")) return;
  const message = messageWithDemoDetails(data);
  const dayBucket = new Date().toISOString().slice(0, 10);
  const submissionKey = createHash("sha256")
    .update(
      JSON.stringify([
        dayBucket,
        data.email.toLowerCase(),
        data.firstName,
        data.lastName,
        data.phone ?? "",
        data.subject,
        message,
        data.category ?? "",
        data.companyName ?? "",
      ]),
    )
    .digest("hex");
  try {
    await prisma.lead.create({
      data: {
        submissionKey,
        sourceCategory: data.category ?? "",
        companyName: data.companyName || null,
        contactName: `${data.firstName} ${data.lastName}`.trim(),
        contactEmail: data.email,
        phone: data.phone || null,
        subject: data.subject,
        message,
      },
    });
  } catch (err) {
    if (!(
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    )) {
      throw err;
    }
  }
}

/**
 * A signed-in filer's grievance belongs to their account and is answered in
 * the dashboard; an anonymous one is held by the public-intake system user and
 * receives staff content only once its email address is confirmed.
 */
async function recordPublicGrievanceTicket(
  data: ContactBody,
): Promise<string | null> {
  if (data.category !== "grievance") return null;
  const session = await getSession().catch(() => null);
  const sessionUser = session?.user?.id
    ? await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { id: true, email: true, name: true },
      })
    : null;
  const ownerId = sessionUser?.id ?? (await resolvePublicIntakeUserId());
  const name = sessionUser?.name ?? `${data.firstName} ${data.lastName}`.trim();
  const email = sessionUser?.email ?? data.email;

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const ref = await allocateTicketReference(tx, now);
    const caseId = randomUUID();
    const supportCase = await tx.supportCase.create({
      data: {
        id: caseId,
        // Each grievance is its own scope: one holder carries every anonymous
        // filing, so the open-case dedupe key must never merge them.
        scopeKey: `GRIEVANCE:${caseId}`,
        referenceNumber: ref,
        title: `[Grievance] ${data.subject || "Public Grievance"}`,
        description: sessionUser
          ? data.message
          : `Submitted via public form by ${name} <${email}>\n\n${data.message}`,
        category: "GRIEVANCE",
        status: "OPEN",
        priority: "HIGH",
        requesterUserId: ownerId,
        submitterUserId: ownerId,
        activeChannel: "HUMAN",
        externalRequesterEmail: sessionUser ? null : email,
        externalRequesterName: sessionUser ? null : name,
        messageSeq: 1,
        messages: {
          create: {
            seq: 1,
            sender: "USER",
            authorUserId: sessionUser?.id ?? null,
            body: data.message,
            metadata: sessionUser
              ? { origin: "public-grievance" }
              : { origin: "public-grievance", email, name },
          },
        },
        events: {
          create: {
            kind: "CREATED",
            toValue: "OPEN",
            actorId: sessionUser?.id ?? null,
          },
        },
        lastMessageAt: now,
        ...slaDeadlinesFor("HIGH", now),
        ...supportDeadline("GRIEVANCE", now),
        receivedAt: now,
      },
    });
    await stageSupportCaseIntakeTx(tx, supportCase, "USER");
    if (!sessionUser)
      await stageExternalIntakeReceiptTx(tx, {
        caseId: supportCase.id,
        reference: ref,
        to: email,
      });
    return ref;
  });
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  const rl = await applyRateLimit(spamLimiter, `contact:${ip}`);
  if (rl) return rl;

  const raw = await req.json().catch(() => null);
  const parsed = ContactBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Please correct the highlighted fields.",
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  // Honeypot tripped — respond exactly as we would on success so the bot gets
  // no signal, but do not send anything.
  if (parsed.data.website) {
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  await recordContactLeadIfApplicable(parsed.data);
  const referenceNumber = await recordPublicGrievanceTicket(parsed.data);

  const result = await sendContactInquiryEmail({
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    email: parsed.data.email,
    phone: parsed.data.phone || null,
    subject: parsed.data.subject,
    message: messageWithDemoDetails(parsed.data),
    category: parsed.data.category || null,
    referenceNumber,
  });

  if (!result.success && !result.staged) {
    return NextResponse.json(
      {
        error:
          "We could not send your message right now. Please email us directly and we will pick it up.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json(
    { ok: true, ...(referenceNumber ? { referenceNumber } : {}) },
    { status: 202 },
  );
}
