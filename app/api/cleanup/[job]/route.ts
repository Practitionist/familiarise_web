import { NextResponse, type NextRequest } from "next/server";
import { getCleanupJobHandlers } from "@/lib/cron/cleanup-registry";

type RouteContext = {
  params: Promise<{ job: string }>;
};

async function resolveJobSlug(
  req: NextRequest,
  context?: RouteContext,
): Promise<string | null> {
  if (context?.params) {
    const resolved = await context.params;
    if (resolved?.job) return resolved.job;
  }
  const pathname =
    req.nextUrl?.pathname ??
    (typeof req.url === "string"
      ? new URL(req.url, "http://localhost").pathname
      : "");
  const match = pathname.match(/\/api\/cleanup\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export async function GET(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const slug = await resolveJobSlug(req, context);
  const handlers = slug ? getCleanupJobHandlers(slug) : null;
  if (!handlers) {
    return NextResponse.json(
      { error: "Unknown cleanup job", job: slug },
      { status: 404 },
    );
  }
  return handlers.GET(req);
}

export async function POST(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const slug = await resolveJobSlug(req, context);
  const handlers = slug ? getCleanupJobHandlers(slug) : null;
  if (!handlers) {
    return NextResponse.json(
      { error: "Unknown cleanup job", job: slug },
      { status: 404 },
    );
  }
  return handlers.POST(req);
}
