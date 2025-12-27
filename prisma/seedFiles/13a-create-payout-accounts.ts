import { faker } from "@faker-js/faker";
import { PaymentGateway, PayoutAccountType } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  INDIAN_BANKS,
  IndianBank,
  generateIfscCode,
  generateUpiId,
  generateStripeAccountId,
  generateRazorpayContactId,
  generateRazorpayFundAccountId,
  generateAccountNumberLast4,
  weightedRandom,
  PAYOUT_ACCOUNT_TYPE_WEIGHTS,
} from "./utils";

// Configuration
const MIN_ACCOUNTS_PER_CONSULTANT = 1;
const MAX_ACCOUNTS_PER_CONSULTANT = 3;
const VERIFICATION_RATE = 0.8; // 80% verified

interface PayoutAccountData {
  consultantProfileId: string;
  provider: PaymentGateway;
  accountType: PayoutAccountType;
  accountHolderName?: string;
  bankName?: string;
  accountNumberLast4?: string;
  ifscCode?: string;
  upiId?: string;
  stripeAccountId?: string;
  stripeAccountStatus?: string;
  razorpayContactId?: string;
  razorpayFundAccId?: string;
  isVerified: boolean;
  isDefault: boolean;
}

/**
 * Generate bank account details
 */
function generateBankAccountDetails(
  consultantName: string,
): Partial<PayoutAccountData> {
  const bank = faker.helpers.arrayElement(INDIAN_BANKS) as IndianBank;
  return {
    provider: PaymentGateway.RAZORPAY,
    accountType: PayoutAccountType.BANK_ACCOUNT,
    accountHolderName: consultantName,
    bankName: bank.name,
    accountNumberLast4: generateAccountNumberLast4(),
    ifscCode: generateIfscCode(bank),
    razorpayContactId: generateRazorpayContactId(),
    razorpayFundAccId: generateRazorpayFundAccountId(),
  };
}

/**
 * Generate UPI account details
 */
function generateUpiAccountDetails(
  consultantName: string,
): Partial<PayoutAccountData> {
  return {
    provider: PaymentGateway.RAZORPAY,
    accountType: PayoutAccountType.UPI,
    accountHolderName: consultantName,
    upiId: generateUpiId(consultantName),
    razorpayContactId: generateRazorpayContactId(),
    razorpayFundAccId: generateRazorpayFundAccountId(),
  };
}

/**
 * Generate Stripe Connect account details
 */
function generateStripeConnectDetails(
  consultantName: string,
): Partial<PayoutAccountData> {
  const statuses = ["active", "pending", "restricted"];
  return {
    provider: PaymentGateway.STRIPE,
    accountType: PayoutAccountType.STRIPE_CONNECT,
    accountHolderName: consultantName,
    stripeAccountId: generateStripeAccountId(),
    stripeAccountStatus: faker.helpers.arrayElement(statuses),
  };
}

/**
 * Generate payout account data based on account type
 */
function generatePayoutAccountData(
  consultantProfileId: string,
  consultantName: string,
  accountType: PayoutAccountType,
  isDefault: boolean,
): PayoutAccountData {
  let accountDetails: Partial<PayoutAccountData>;

  switch (accountType) {
    case PayoutAccountType.BANK_ACCOUNT:
      accountDetails = generateBankAccountDetails(consultantName);
      break;
    case PayoutAccountType.UPI:
      accountDetails = generateUpiAccountDetails(consultantName);
      break;
    case PayoutAccountType.STRIPE_CONNECT:
      accountDetails = generateStripeConnectDetails(consultantName);
      break;
    default:
      accountDetails = generateBankAccountDetails(consultantName);
  }

  return {
    consultantProfileId,
    isVerified: faker.datatype.boolean({ probability: VERIFICATION_RATE }),
    isDefault,
    ...accountDetails,
  } as PayoutAccountData;
}

export async function createPayoutAccounts(): Promise<void> {
  console.log("Creating payout accounts...");

  // Get all consultants with their profiles
  const consultants = await prisma.user.findMany({
    where: {
      consultantProfile: {
        isNot: null,
      },
    },
    select: {
      id: true,
      name: true,
      consultantProfile: {
        select: {
          id: true,
        },
      },
    },
  });

  if (consultants.length === 0) {
    console.warn("No consultants found for payout account creation");
    return;
  }

  console.log(`Found ${consultants.length} consultants`);

  let totalCreated = 0;
  const payoutAccountsToCreate: PayoutAccountData[] = [];

  for (const consultant of consultants) {
    if (!consultant.consultantProfile) continue;

    const consultantProfileId = consultant.consultantProfile.id;
    const consultantName = consultant.name || "Account Holder";

    // Determine number of accounts for this consultant (1-3)
    const numAccounts = faker.number.int({
      min: MIN_ACCOUNTS_PER_CONSULTANT,
      max: MAX_ACCOUNTS_PER_CONSULTANT,
    });

    // Track used account types to avoid duplicates
    const usedTypes = new Set<PayoutAccountType>();

    for (let i = 0; i < numAccounts; i++) {
      const isDefault = i === 0; // First account is default

      // Get account type, ensuring no duplicates
      let accountType: PayoutAccountType;
      do {
        accountType = weightedRandom(PAYOUT_ACCOUNT_TYPE_WEIGHTS);
      } while (usedTypes.has(accountType) && usedTypes.size < 3);

      usedTypes.add(accountType);

      const accountData = generatePayoutAccountData(
        consultantProfileId,
        consultantName,
        accountType,
        isDefault,
      );

      payoutAccountsToCreate.push(accountData);
    }
  }

  // Create accounts in batches for better performance
  const BATCH_SIZE = 50;
  for (let i = 0; i < payoutAccountsToCreate.length; i += BATCH_SIZE) {
    const batch = payoutAccountsToCreate.slice(i, i + BATCH_SIZE);

    try {
      await prisma.payoutAccount.createMany({
        data: batch.map((account) => ({
          consultantProfileId: account.consultantProfileId,
          provider: account.provider,
          accountType: account.accountType,
          accountHolderName: account.accountHolderName,
          bankName: account.bankName,
          accountNumberLast4: account.accountNumberLast4,
          ifscCode: account.ifscCode,
          upiId: account.upiId,
          stripeAccountId: account.stripeAccountId,
          stripeAccountStatus: account.stripeAccountStatus,
          razorpayContactId: account.razorpayContactId,
          razorpayFundAccId: account.razorpayFundAccId,
          isVerified: account.isVerified,
          isDefault: account.isDefault,
        })),
        skipDuplicates: true,
      });

      totalCreated += batch.length;
      console.log(
        `Created ${totalCreated}/${payoutAccountsToCreate.length} payout accounts...`,
      );
    } catch (error) {
      console.error(`Failed to create batch starting at ${i}:`, error);
      // Continue with next batch
    }
  }

  // Log summary
  const summary = await prisma.payoutAccount.groupBy({
    by: ["accountType"],
    _count: true,
  });

  console.log("\nPayout Accounts Summary:");
  console.log(`Total created: ${totalCreated}`);
  for (const item of summary) {
    console.log(`  ${item.accountType}: ${item._count}`);
  }

  const defaultAccounts = await prisma.payoutAccount.count({
    where: { isDefault: true },
  });
  const verifiedAccounts = await prisma.payoutAccount.count({
    where: { isVerified: true },
  });

  console.log(`  Default accounts: ${defaultAccounts}`);
  console.log(`  Verified accounts: ${verifiedAccounts}`);
}
