/**
 * GET /api/admin/newsletter — newsletter subscriber list for the backoffice.
 *
 * `?format=csv` returns the same filtered set as a download.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { NewsletterSource, NewsletterStatus } from "@prisma/client";
import { z } from "zod";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  exportSubscribersCsv,
  listSubscribers,
} from "@/lib/newsletter/service";

const querySchema = z.object({
  status: z.nativeEnum(NewsletterStatus).optional(),
  source: z.nativeEnum(NewsletterSource).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
  format: z.enum(["json", "csv"]).optional(),
});

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(request.url);
    const parsed = querySchema.safeParse(
      Object.fromEntries(searchParams.entries()),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { format, ...filters } = parsed.data;

    if (format === "csv") {
      const csv = await exportSubscribersCsv(filters);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="newsletter.csv"',
        },
      });
    }

    return NextResponse.json(await listSubscribers(filters));
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "newsletter" } },
    );
    console.error("[admin/newsletter]", error);
    return NextResponse.json(
      { error: "Failed to load subscribers" },
      { status: 500 },
    );
  }
}
