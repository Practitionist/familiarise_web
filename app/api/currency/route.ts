import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getExchangeRates, CURRENCY_SYMBOLS } from "@/lib/currency";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const to = searchParams.get("to") || "INR";

    // If target is INR, no conversion needed
    if (to === "INR") {
      return NextResponse.json({
        rate: 1,
        currency: "INR",
        symbol: CURRENCY_SYMBOLS["INR"],
      });
    }

    const rates = await getExchangeRates();
    const rate = rates[to];

    if (rate === undefined) {
      return NextResponse.json(
        { error: `Unsupported currency: ${to}` },
        { status: 400 },
      );
    }

    return NextResponse.json({
      rate,
      currency: to,
      symbol: CURRENCY_SYMBOLS[to] || to,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "currency" } });
    console.error("Currency API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch exchange rates" },
      { status: 500 },
    );
  }
}
