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
import { sendContactInquiryEmail } from "@/lib/email";
import { applyRateLimit, getClientIp, spamLimiter } from "@/lib/rate-limit";
import { allocateTicketReference } from "@/lib/support/reference";
import { INQUIRY_CATEGORIES } from "@/app/(pages)/constants";

const CATEGORY_VALUES = INQUIRY_CATEGORIES.map((c) => c.value);

const ContactBodySchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().min(1, "Last name is required").max(100),
  email: z.string().trim().email("Enter a valid email address").max(320),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  subject: z.string().trim().min(1, "Subject is required").max(200),
  message: z.string().trim().min(1, "Message is required").max(5000),
  category: z
    .string()
    .refine(
      (v) =>
        v === "" ||
        CATEGORY_VALUES.some((knownCategory) => knownCategory === v),
      {
        message: "Unknown inquiry category",
      },
    )
    .optional()
    .or(z.literal("")),
  // Honeypot: a real person never fills a hidden field. Bots fill everything.
  // Present in the payload but never rendered visibly.
  website: z.string().max(200).optional(),
});

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

  const LEAD_CATEGORIES = new Set(["enterprise", "team-training"]);
  if (LEAD_CATEGORIES.has(parsed.data.category ?? "")) {
    const dayBucket = new Date().toISOString().slice(0, 10);
    const submissionKey = createHash("sha256")
      .update(
        JSON.stringify([
          dayBucket,
          parsed.data.email.toLowerCase(),
          parsed.data.firstName,
          parsed.data.lastName,
          parsed.data.phone ?? "",
          parsed.data.subject,
          parsed.data.message,
          parsed.data.category ?? "",
        ]),
      )
      .digest("hex");
    try {
      await prisma.lead.create({
        data: {
          submissionKey,
          sourceCategory: parsed.data.category ?? "",
          companyName: null,
          contactName:
            `${parsed.data.firstName} ${parsed.data.lastName}`.trim(),
          contactEmail: parsed.data.email,
          phone: parsed.data.phone || null,
          subject: parsed.data.subject,
          message: parsed.data.message,
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

  const referenceNumber =
    parsed.data.category === "grievance"
      ? await prisma.$transaction((tx) => allocateTicketReference(tx))
      : null;

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

  return NextResponse.json(
    { ok: true, ...(referenceNumber ? { referenceNumber } : {}) },
    { status: 202 },
  );
}
