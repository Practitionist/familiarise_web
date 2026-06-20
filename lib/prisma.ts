import * as Sentry from "@sentry/nextjs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// #780 — money is BigInt at the DB column (int4 ceiling ₹2.14cr was the v3
// audit's #1 finding), number at the JS boundary (MAX_SAFE_INTEGER ≈ ₹90 lakh
// crore). Every BigInt column is converted on read here so no bigint ever
// reaches JSON/Zod/Razorpay. Aggregations (_sum/groupBy) bypass result
// extensions — wrap those reads in sumPaise() from lib/payments/utils/money.
// A drift test asserts this map covers every BigInt column in the schema.
function f<K extends string>(field: K) {
  return {
    needs: { [field]: true } as { [P in K]: true },
    compute: (row: { [P in K]: bigint }) => Number(row[field]),
  };
}

function fn<K extends string>(field: K) {
  return {
    needs: { [field]: true } as { [P in K]: true },
    compute: (row: { [P in K]: bigint | null }) => {
      const v = row[field];
      return v === null ? null : Number(v);
    },
  };
}

// #781 §C — nullable Decimal → number. Prisma.Decimal instances can't cross
// the RSC boundary; FX snapshots are 6-dp, well within double precision.
function dn<K extends string>(field: K) {
  return {
    needs: { [field]: true } as { [P in K]: true },
    compute: (row: { [P in K]: { toNumber(): number } | null }) => {
      const v = row[field];
      return v === null ? null : v.toNumber();
    },
  };
}

const adapter = new PrismaPg({
  // Use pooled connection (DATABASE_URL) for runtime queries to avoid connection exhaustion
  // DIRECT_URL is only for migrations (handled by prisma.config.ts)
  connectionString: process.env.DATABASE_URL || process.env.DIRECT_URL,
  // pg.Pool defaults to 10 clients PER function instance; at Netlify's 125
  // concurrent invocations that can dwarf Supavisor's client cap. Set
  // PG_POOL_MAX=1 (or 2) in serverless deploy env; unset = pg default for
  // long-lived local dev/jobs.
  ...(Number(process.env.PG_POOL_MAX) > 0
    ? { max: Number(process.env.PG_POOL_MAX) }
    : {}),
});

// Slow-query threshold (ms). A query exceeding this is logged via the
// query-event hook below so hot-path regressions surface in any environment.
const PARSED_SLOW_QUERY_MS = Number(process.env.PRISMA_SLOW_QUERY_MS);
const SLOW_QUERY_MS =
  Number.isFinite(PARSED_SLOW_QUERY_MS) && PARSED_SLOW_QUERY_MS > 0
    ? PARSED_SLOW_QUERY_MS
    : 500;

function makeClient() {
  // Emit the `query` event everywhere so the slow-query hook fires in prod too;
  // keep the verbose error/warn → stdout fan-out gated to development.
  const base = new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? [
            { level: "query", emit: "event" },
            { level: "error", emit: "stdout" },
            { level: "warn", emit: "stdout" },
          ]
        : [{ level: "query", emit: "event" }, "error"],
  });

  // #696 / nav-perf Phase 3 — warn on queries over the threshold so missing
  // indexes and N+1s are visible without full query logging. console.warn
  // matches the lib/ convention (lib/redis.ts, lib/maintenance-cron.ts).
  base.$on("query", (e) => {
    if (e.duration > SLOW_QUERY_MS) {
      console.warn(
        `[Prisma:SLOW_QUERY] ${e.duration}ms (threshold ${SLOW_QUERY_MS}ms): ${e.query}`,
        process.env.NODE_ENV === "development" ? { params: e.params } : "",
      );
    }
  });

  return base.$extends({
    result: {
      billingAccount: {
        walletBalance: fn("walletBalance"),
        creditLimit: fn("creditLimit"),
        minBalancePaise: fn("minBalancePaise"),
        autoTopUpAmountPaise: fn("autoTopUpAmountPaise"),
      },
      billingSubscription: {
        ratePerSeatPaise: fn("ratePerSeatPaise"),
        flatFeePaise: fn("flatFeePaise"),
      },
      walletTopUp: { amountPaise: f("amountPaise") },
      licensedSeatConfig: {
        ratePerSeatPaise: f("ratePerSeatPaise"),
        priceCapPerEngagementPaise: fn("priceCapPerEngagementPaise"),
        maxOveragePerCyclePaise: fn("maxOveragePerCyclePaise"),
      },
      creditPoolConfig: {
        maxOveragePerCyclePaise: fn("maxOveragePerCyclePaise"),
      },
      programAssignment: { consumedPaise: f("consumedPaise") },
      bookingUtilization: { priceAtBookingPaise: f("priceAtBookingPaise") },
      rateCard: {
        minGrossPaise: fn("minGrossPaise"),
        maxGrossPaise: fn("maxGrossPaise"),
      },
      organizationEarnings: {
        grossAmountPaise: f("grossAmountPaise"),
        platformFeePaise: f("platformFeePaise"),
        orgSharePaise: f("orgSharePaise"),
        consultantSharePaise: f("consultantSharePaise"),
        refundedAmountPaise: f("refundedAmountPaise"),
      },
      organizationPayout: {
        amountPaise: f("amountPaise"),
        grossRevenuePaise: f("grossRevenuePaise"),
        platformFeePaise: f("platformFeePaise"),
        refundsPaise: f("refundsPaise"),
        netPayoutPaise: f("netPayoutPaise"),
        tdsAmountPaise: fn("tdsAmountPaise"),
        clawbackAmountPaise: f("clawbackAmountPaise"),
      },
      organizationInvoice: {
        inrEquivalentPaise: f("inrEquivalentPaise"),
        subtotalPaise: f("subtotalPaise"),
        igstPaise: f("igstPaise"),
        cgstPaise: f("cgstPaise"),
        sgstPaise: f("sgstPaise"),
        totalPaise: f("totalPaise"),
      },
      invoiceLineItem: {
        unitPricePaise: f("unitPricePaise"),
        taxPaise: fn("taxPaise"),
      },
      purchaseOrder: {
        totalAmountPaise: f("totalAmountPaise"),
        remainingAmountPaise: f("remainingAmountPaise"),
      },
      usageLedgerEntry: { priceAtBookingPaise: f("priceAtBookingPaise") },
      ledgerAccountBalance: {
        balancePaise: f("balancePaise"),
        entrySeq: f("entrySeq"),
      },
      ledgerEntry: { amountPaise: f("amountPaise") },
      consultationPlan: { price: f("price") },
      subscriptionPlan: { price: f("price") },
      webinarPlan: { price: f("price") },
      classPlan: { price: f("price") },
      recording: { fileSize: fn("fileSize") },
      payment: {
        amount: f("amount"),
        originalAmount: f("originalAmount"),
        taxAmount: f("taxAmount"),
        gstTcsCollectedPaise: fn("gstTcsCollectedPaise"),
        exchangeRateAtCheckout: dn("exchangeRateAtCheckout"),
      },
      paymentLeg: { amountPaise: f("amountPaise") },
      refund: {
        amountPaise: f("amountPaise"),
        exchangeRateAtRefund: dn("exchangeRateAtRefund"),
      },
      dispute: { amountPaise: f("amountPaise") },
      consultantEarnings: {
        grossAmount: f("grossAmount"),
        platformFeePaise: f("platformFeePaise"),
        consultantSharePaise: f("consultantSharePaise"),
        refundedShareAmount: f("refundedShareAmount"),
        gstTcsAccruedPaise: fn("gstTcsAccruedPaise"),
      },
      consultantPayout: {
        amount: f("amount"),
        tdsDeducted: f("tdsDeducted"),
        netAmount: fn("netAmount"),
      },
      tDSRecord: {
        cumulativeAmountCredited: f("cumulativeAmountCredited"),
        tdsDeducted: f("tdsDeducted"),
      },
      tdsRate: { thresholdPaise: fn("thresholdPaise") },
      creditNote: {
        subtotalPaise: f("subtotalPaise"),
        igstPaise: f("igstPaise"),
        cgstPaise: f("cgstPaise"),
        sgstPaise: f("sgstPaise"),
        totalPaise: f("totalPaise"),
      },
      tdsAdjustment: { amountPaise: f("amountPaise") },
      gstTcsBatch: {
        netSupplyPaise: f("netSupplyPaise"),
        tcsCollectedPaise: f("tcsCollectedPaise"),
      },
      gstTcsAdjustment: { amountPaise: f("amountPaise") },
      discountCode: { maxDiscount: fn("maxDiscount") },
      referralCode: {
        referrerReward: fn("referrerReward"),
        refereeReward: fn("refereeReward"),
        totalEarned: f("totalEarned"),
      },
      referral: {
        referrerRewardAmount: fn("referrerRewardAmount"),
        refereeRewardAmount: fn("refereeRewardAmount"),
      },
      referralCredit: {
        amount: f("amount"),
        usedAmount: f("usedAmount"),
        remainingAmount: f("remainingAmount"),
      },
      referralCreditUsage: {
        amount: f("amount"),
        originalAmount: f("originalAmount"),
        restoredAmount: f("restoredAmount"),
      },
      orgDataExportJob: { fileSizeBytes: fn("fileSizeBytes") },
      overageEvent: {
        marginalPaise: f("marginalPaise"),
        basePaise: f("basePaise"),
        surchargePaise: f("surchargePaise"),
      },
    },
  });
}

// Helper signatures must accept the extended client — a bare PrismaClient
// re-introduces bigint money types (#780). Tx is derived from $transaction's
// callback param (not a hand-rolled Omit) so the itx client matches by type
// identity — a structural re-compare of two extended-client types blows
// TypeScript's "excessive stack depth" limit.
export type Db = ReturnType<typeof makeClient>;
export type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
export type PrismaLike = Db | Tx;

const globalForPrisma = globalThis as unknown as {
  prisma: Db | undefined;
};

const prisma = globalForPrisma.prisma ?? makeClient();

export default prisma;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
