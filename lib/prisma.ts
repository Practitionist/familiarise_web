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

// A saturated Supavisor (txn pooler :6543) made pg hang 5–9.6s on connect
// (EAUTHTIMEOUT), surfacing to users as "the edge function timed out". The two
// budgets below fail fast instead, so a stuck pooler can't pin a Netlify
// function up to its ~10s ceiling. Both env-gated (positive ms wins, else default).
const pgTimeoutMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
// `next build` statically prerenders DB-backed pages (e.g. /explore/programs),
// which connect through this same saturated pooler — but at build there is no
// user and no function ceiling, so the 3s runtime fail-fast wrongly aborts the
// prerender ("timeout exceeded when trying to connect" → build exit 2). The
// build phase gets a generous connect budget; runtime keeps the fast fail-fast.
// Env override (PG_CONNECT_TIMEOUT_MS) still wins in either phase.
const IS_NEXT_BUILD = process.env.NEXT_PHASE === "phase-production-build";
// ~3s at runtime (well under the function ceiling, above a normal cold connect);
// ~30s at build (room for a cold/saturated pooler — pre-#912 had no timeout).
const PG_CONNECT_TIMEOUT_MS = pgTimeoutMs(
  "PG_CONNECT_TIMEOUT_MS",
  IS_NEXT_BUILD ? 30000 : 3000,
);
// ~6s query budget — keeps the worst case (3s connect + 6s query = 9s) under
// Netlify's ~10s function ceiling. query_timeout is CLIENT-SIDE and is the only
// one that bounds a query *through* the txn pooler — Supavisor silently ignores
// the statement_timeout startup param (verified: SHOW statement_timeout stays at
// the 2min server default). statement_timeout is set ~1s BELOW query_timeout
// below as defense-in-depth for direct session-mode connects (DIRECT_URL :5432):
// the server then aborts first with a clean error that keeps the pooled
// connection synchronized/reusable, instead of node-postgres tearing it down on
// a client-side query_timeout.
const PG_QUERY_TIMEOUT_MS = pgTimeoutMs("PG_QUERY_TIMEOUT_MS", 6000);

const adapter = new PrismaPg({
  // Use pooled connection (DATABASE_URL) for runtime queries to avoid connection exhaustion
  // DIRECT_URL is only for migrations (handled by prisma.config.ts)
  connectionString: process.env.DATABASE_URL || process.env.DIRECT_URL,
  connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
  query_timeout: PG_QUERY_TIMEOUT_MS,
  // ~1s below query_timeout so the server cancels first on the direct session-mode
  // path (clean error, connection stays poolable); ignored on the txn pooler. Scales
  // down for sub-2s budgets so statement_timeout stays strictly below it (#917 review).
  statement_timeout:
    PG_QUERY_TIMEOUT_MS > 1000
      ? PG_QUERY_TIMEOUT_MS - 1000
      : Math.max(1, Math.floor(PG_QUERY_TIMEOUT_MS * 0.8)),
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
      Sentry.logger.warn(
        Sentry.logger.fmt`[Prisma:SLOW_QUERY] ${e.duration}ms (threshold ${SLOW_QUERY_MS}ms)`,
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
