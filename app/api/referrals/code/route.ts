import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";
import { getSession } from "@/lib/auth-server";
import { getReferralCode, createReferralCode } from "@/lib/referrals/service";

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }

    const code = await getReferralCode(session.user.id);
    return NextResponse.json({ data: code }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "referrals" } },
    );
    console.error("Error fetching referral code:", error);
    return NextResponse.json(
      { error: "Failed to fetch referral code" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const code = await createReferralCode(session.user.id);
    return NextResponse.json({ data: code });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "referrals" } },
    );
    console.error("Error creating referral code:", error);
    return NextResponse.json(
      { error: "Failed to create referral code" },
      { status: 500 },
    );
  }
}
