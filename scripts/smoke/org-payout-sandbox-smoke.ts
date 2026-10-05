/**
 * Org-payout go-live proof against the RazorpayX SANDBOX.
 *
 * Proves, without moving money:
 *   1. creating an org payout on any rail but RazorpayX is refused;
 *   2. with ENABLE_LIVE_PAYOUTS off, `processOrgPayout` makes no gateway
 *      submission and leaves the payout PENDING (unclaimed);
 *   3. the RazorpayX test credentials authenticate (a read-only balance call).
 *
 * Refuses to run unless the RazorpayX key is a test key (`rzp_test_`) and the
 * live-payout flag is off. It writes one throwaway organisation and payout row
 * and deletes them afterwards; the database is shared, so run it deliberately.
 *
 * Run: npx tsx scripts/smoke/org-payout-sandbox-smoke.ts
 */
import prisma from "../../lib/prisma";
import {
  createOrgPayoutBatch,
  PayoutValidationError,
  processOrgPayout,
} from "../../lib/payments/payouts/org-payout-service";
import {
  getRazorpayPayoutsService,
  resolveRazorpayXCredentials,
} from "../../lib/payments/payouts/razorpay-payouts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
}

function refuseUnlessSandbox(): void {
  const { keyId } = resolveRazorpayXCredentials();
  if (!/^rzp_test_/.test(keyId)) {
    throw new Error(
      "Refusing to run: the RazorpayX key is not a test key (rzp_test_…). This smoke only runs against the sandbox.",
    );
  }
  if (process.env.ENABLE_LIVE_PAYOUTS === "true") {
    throw new Error(
      "Refusing to run: ENABLE_LIVE_PAYOUTS=true. Unset it; this smoke proves the gated behaviour.",
    );
  }
}

async function main(): Promise<void> {
  refuseUnlessSandbox();
  const stamp = Date.now();
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 30 * 86_400_000);

  const org = await prisma.organization.create({
    data: {
      name: "Payout Sandbox Org",
      slug: `payout-smoke-${stamp}`,
      canSponsor: false,
      canHost: true,
    },
    select: { id: true },
  });

  try {
    const refused = await createOrgPayoutBatch(org.id, periodStart, periodEnd, {
      paymentGateway: "STRIPE",
    }).then(
      () => null,
      (err: unknown) => err,
    );
    check(
      "a non-RazorpayX org payout is refused at creation",
      refused instanceof PayoutValidationError,
      refused instanceof Error ? refused.message : "no error raised",
    );

    const payout = await prisma.organizationPayout.create({
      data: {
        organizationId: org.id,
        amountPaise: 50_000,
        currency: "INR",
        status: "PENDING",
        paymentGateway: "RAZORPAY",
        periodStart,
        periodEnd,
        grossRevenuePaise: 50_000,
        platformFeePaise: 0,
        refundsPaise: 0,
        netPayoutPaise: 50_000,
      },
      select: { id: true },
    });
    try {
      const result = await processOrgPayout(payout.id);
      check(
        "no gateway submission while live payouts are off",
        !result.submittedToGateway,
        `submittedToGateway=${result.submittedToGateway}`,
      );
      check(
        "the payout stays PENDING until go-live",
        result.status === "PENDING",
        `status=${result.status}`,
      );
      const after = await prisma.organizationPayout.findUnique({
        where: { id: payout.id },
        select: { gatewayPayoutId: true },
      });
      check(
        "no gateway payout id was stamped",
        !after?.gatewayPayoutId,
        `gatewayPayoutId=${after?.gatewayPayoutId ?? "null"}`,
      );
    } finally {
      await prisma.organizationPayout.delete({ where: { id: payout.id } });
    }

    if (process.env.RAZORPAYX_ACCOUNT_NUMBER) {
      const balance = await getRazorpayPayoutsService().getAccountBalance();
      check(
        "the sandbox credentials authenticate (balance read)",
        balance !== null,
        `balance=${balance ?? "unavailable"}`,
      );
    } else {
      console.log(
        "SKIP sandbox balance read — RAZORPAYX_ACCOUNT_NUMBER not set.",
      );
    }
  } finally {
    await prisma.organization.delete({ where: { id: org.id } });
  }

  console.log(
    failures === 0
      ? "\nSandbox smoke PASSED."
      : `\nSandbox smoke FAILED — ${failures} check(s) failed.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err: unknown) => {
    console.error("sandbox smoke crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
