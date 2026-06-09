// #780 — one-pass Int→BigInt flip for money columns. Model-scoped so counts,
// basis-points, and credit-units are never touched. Run once, then
// `npx prisma format && npx prisma generate`. Pre-MVP: no DB backfill exists;
// this is a pure schema-type change (the DB is reset before launch).
const fs = require("fs");
const path = "prisma/schema.prisma";
let src = fs.readFileSync(path, "utf8");

// Excluded on purpose: *Bps* fields, engagementsUsed/overageCount/
// activeSeatCount/*Sessions/quantity (counts), creditsPerCycle (credit units),
// DiscountCode.discountValue (dual %/paise unit).
const MAP = {
  BillingAccount: ["walletBalance", "creditLimit", "minBalancePaise", "autoTopUpAmountPaise"],
  BillingSubscription: ["ratePerSeatPaise", "flatFeePaise"],
  WalletTopUp: ["amountPaise"],
  LicensedSeatConfig: ["ratePerSeatPaise", "priceCapPerEngagementPaise", "maxOveragePerCyclePaise"],
  CreditPoolConfig: ["maxOveragePerCyclePaise"],
  ProgramAssignment: ["consumedPaise"],
  BookingUtilization: ["priceAtBookingPaise"],
  RateCard: ["minGrossPaise", "maxGrossPaise"],
  OrganizationEarnings: ["grossAmountPaise", "platformFeePaise", "orgSharePaise", "consultantSharePaise", "refundedAmountPaise"],
  OrganizationPayout: ["amountPaise", "grossRevenuePaise", "platformFeePaise", "refundsPaise", "netPayoutPaise", "tdsAmountPaise", "clawbackAmountPaise"],
  OrganizationInvoice: ["inrEquivalentPaise", "subtotalPaise", "igstPaise", "cgstPaise", "sgstPaise", "totalPaise"],
  InvoiceLineItem: ["unitPricePaise", "taxPaise"],
  PurchaseOrder: ["totalAmountPaise", "remainingAmountPaise"],
  UsageLedgerEntry: ["priceAtBookingPaise"],
  ConsultationPlan: ["price"],
  SubscriptionPlan: ["price"],
  WebinarPlan: ["price"],
  ClassPlan: ["price"],
  Payment: ["amount", "originalAmount", "taxAmount", "gstTcsCollectedPaise"],
  PaymentLeg: ["amountPaise"],
  Refund: ["amountPaise"],
  Dispute: ["amountPaise"],
  ConsultantEarnings: ["grossAmount", "platformFeePaise", "consultantSharePaise", "refundedShareAmount", "gstTcsAccruedPaise"],
  ConsultantPayout: ["amount", "tdsDeducted", "netAmount"],
  TDSRecord: ["cumulativeAmountCredited", "tdsDeducted"],
  ReferralCode: ["referrerReward", "refereeReward", "totalEarned"],
  Referral: ["referrerRewardAmount", "refereeRewardAmount"],
  ReferralCredit: ["amount", "usedAmount", "remainingAmount"],
  ReferralCreditUsage: ["amount", "originalAmount", "restoredAmount"],
  DiscountCode: ["maxDiscount"],
  OverageEvent: ["marginalPaise", "basePaise", "surchargePaise"],
  CreditNote: ["subtotalPaise", "igstPaise", "cgstPaise", "sgstPaise", "totalPaise"],
  TdsAdjustment: ["amountPaise"],
  GstTcsBatch: ["netSupplyPaise", "tcsCollectedPaise"],
  GstTcsAdjustment: ["amountPaise"],
};

// vs the #780 spike map: OrganizationPlan + ConsultantProfile.totalRevenue/
// pendingRevenue were dropped from the schema since; the #778 §D addendum
// (issue comment) added the 11 GST/TDS/CreditNote columns; the CI guard
// (scripts/ci/check-money-columns.ts) caught 4 more added after the spike
// (BillingAccount auto-top-up pair, OverageEvent base/surcharge).
const EXPECTED = 83;

let changed = 0;
let failed = false;
for (const [model, fields] of Object.entries(MAP)) {
  const re = new RegExp(`(model\\s+${model}\\s*\\{)([\\s\\S]*?)(\\n\\})`);
  const m = src.match(re);
  if (!m) {
    console.error(`!! MODEL NOT FOUND: ${model}`);
    failed = true;
    continue;
  }
  let block = m[2];
  for (const fld of fields) {
    const fre = new RegExp(`(^\\s*${fld}\\s+)Int(\\??)`, "m");
    if (!fre.test(block)) {
      console.error(`!! NOT Int: ${model}.${fld}`);
      failed = true;
      continue;
    }
    block = block.replace(fre, (_x, p1, opt) => {
      changed++;
      return `${p1}BigInt${opt}`;
    });
  }
  src = src.slice(0, m.index) + m[1] + block + m[3] + src.slice(m.index + m[0].length);
}

if (changed !== EXPECTED || failed) {
  console.error(`ABORT: converted ${changed}, expected ${EXPECTED} — schema not written`);
  process.exit(1);
}
fs.writeFileSync(path, src);
console.log(`Converted ${changed} fields (expected ${EXPECTED})`);
