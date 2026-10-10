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

import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { sendContactInquiryEmail } from "@/lib/email";
import { applyRateLimit, getClientIp, spamLimiter } from "@/lib/rate-limit";
import { allocateTicketReference } from "@/lib/support/reference";
import { slaDeadlinesFor } from "@/lib/support/sla";
import { INQUIRY_CATEGORIES } from "@/app/(pages)/constants";

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
  // Honeypot: a real person never fills a hidden field. Bots fill everything.
  // Present in the payload but never rendered visibly.
  website: z.string().max(200).optional(),
});

const LEAD_CATEGORIES = new Set(["enterprise", "team-training"]);

async function recordContactLeadIfApplicable(
  data: z.infer<typeof ContactBodySchema>,
): Promise<void> {
  if (!LEAD_CATEGORIES.has(data.category ?? "")) return;
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
        data.message,
        data.category ?? "",
      ]),
    )
    .digest("hex");
  try {
    await prisma.lead.create({
      data: {
        submissionKey,
        sourceCategory: data.category ?? "",
        companyName: null,
        contactName: `${data.firstName} ${data.lastName}`.trim(),
        contactEmail: data.email,
        phone: data.phone || null,
        subject: data.subject,
        message: data.message,
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

async function recordPublicGrievanceTicket(
  data: z.infer<typeof ContactBodySchema>,
): Promise<string | null> {
  if (data.category !== "grievance") return null;
  const session = await getSession().catch(() => null);
  const sessionUserId = session?.user?.id ?? null;

  return prisma.$transaction(async (tx) => {
    const fallbackOwner = sessionUserId
      ? null
      : await tx.user.findFirst({
          where: { role: { in: ["ADMIN", "STAFF"] } },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });
    const userId = sessionUserId ?? fallbackOwner?.id ?? null;
    if (!userId) return null;

    const now = new Date();
    const ref = await allocateTicketReference(tx, now);
    const name = `${data.firstName} ${data.lastName}`.trim();
    await tx.supportTicket.create({
      data: {
        referenceNumber: ref,
        title: `[Grievance] ${data.subject || "Public Grievance"}`,
        description: `Submitted via public form by ${name} <${data.email}>\n\n${data.message}`,
        category: "GRIEVANCE",
        status: "OPEN",
        priority: "HIGH",
        userId,
        lastMessageAt: now,
        ...slaDeadlinesFor("HIGH", now),
      },
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
    message: parsed.data.message,
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

  if (parsed.data.category === "grievance" && !referenceNumber) {
    return NextResponse.json(
      {
        ok: true,
        referenceNumber: null,
        message:
          "Grievance received — our Grievance Officer will open a case and email your tracking reference within 24 hours.",
      },
      { status: 202 },
    );
  }

  return NextResponse.json(
    { ok: true, ...(referenceNumber ? { referenceNumber } : {}) },
    { status: 202 },
  );
}
