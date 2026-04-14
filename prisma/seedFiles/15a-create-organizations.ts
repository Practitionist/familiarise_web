/**
 * Phase 15: Enterprise Organizations
 *
 * Creates organizations with all three billing modes, org members drawn from
 * existing consultee/consultant users, org plans, credit pools, SSO settings,
 * and sample invoices. Runs after all other phases so it can reference
 * existing users, payments, and profiles.
 *
 * Also creates PROVIDER orgs (consultant agencies) and HYBRID orgs
 * (dual buyer+provider, e.g. universities) with payout accounts,
 * ORG_CONSULTANT members, and sample earnings.
 */

import { faker } from "@faker-js/faker";
import {
  EarningStatus,
  EarningsRecipient,
  OrgAuditAction,
  OrganizationBillingMode,
  OrganizationKind,
  OrgMemberRole,
  PayoutFrequency,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  sanitizeString,
  INDIAN_BANKS,
  generateIfscCode,
  generateRazorpayContactId,
  generateRazorpayFundAccountId,
  generateHoldUntilDate,
} from "./utils";
import { config, getRandomInRange } from "./config";
import type { UserWithProfiles } from "./1a-create-users";

// ---------------------------------------------------------------------------
// Volume scaling
// ---------------------------------------------------------------------------

// Volume config is read from the central config system.
// Fallback constants here only guard against an incomplete config merge.
const CREDIT_BALANCE_RANGE = { min: 10000, max: 500000 }; // in paise

// ---------------------------------------------------------------------------
// Org name generation
// ---------------------------------------------------------------------------

const ORG_NAME_TEMPLATES = [
  () => `${faker.company.name()} Academy`,
  () => `${faker.company.name()} School`,
  () => `${faker.company.name()} Institute`,
  () => `${faker.company.name()} Training Center`,
  () => `${faker.company.name()} University`,
  () => `${faker.company.name()} Learning Hub`,
  () => `${faker.company.name()} Corp Training`,
];

function generateOrgName(): string {
  return sanitizeString(
    faker.helpers.arrayElement(ORG_NAME_TEMPLATES)(),
  ).slice(0, 100);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function createOrganizations(
  users: UserWithProfiles[],
): Promise<void> {
  const counts = config.volumes.organizations;
  const totalBuyerOrgs = counts.buyer + counts.seatPack + counts.invoiced;
  const totalOrgs = totalBuyerOrgs + counts.provider + counts.hybrid;

  console.log(
    `  Creating ${totalOrgs} organizations (${counts.buyer} TAG_ONLY, ${counts.seatPack} SEAT_PACK, ${counts.invoiced} INVOICED_MONTHLY, ${counts.provider} PROVIDER, ${counts.hybrid} HYBRID)...`,
  );

  const consultees = users.filter(
    (u) => u.role === "CONSULTEE" && u.consulteeProfile?.id,
  );
  const consultants = users.filter(
    (u) => u.role === "CONSULTANT" && u.consultantProfile?.id,
  );
  const admins = users.filter((u) => u.role === "ADMIN");

  if (consultees.length < 3) {
    console.log("  ⚠️  Not enough consultees for org seeding. Skipping.");
    return;
  }

  // Build the list of orgs to create (mode × billing)
  const orgSpecs: { billingMode: OrganizationBillingMode }[] = [
    ...Array(counts.buyer).fill({ billingMode: "TAG_ONLY" as const }),
    ...Array(counts.seatPack).fill({ billingMode: "SEAT_PACK" as const }),
    ...Array(counts.invoiced).fill({ billingMode: "INVOICED_MONTHLY" as const }),
  ];

  // Shuffle consultees so each org gets different members
  const shuffledConsultees = faker.helpers.shuffle([...consultees]);
  let consulteeIdx = 0;

  const industries = [
    "Education",
    "Software",
    "Healthcare",
    "Finance",
    "Manufacturing",
    "Consulting",
    "Government",
    "Non-profit",
  ];

  const sizeBuckets = [
    "SMALL_1_50",
    "MEDIUM_51_200",
    "LARGE_201_1000",
    "ENTERPRISE_1000_PLUS",
  ] as const;

  for (let i = 0; i < orgSpecs.length; i++) {
    const spec = orgSpecs[i];
    const name = generateOrgName();
    const baseSlug = slugify(name);
    const slug = `${baseSlug}-${faker.string.alphanumeric(4)}`;

    // Pick an owner — use a consultee (they can also be an org owner)
    const ownerUser =
      shuffledConsultees[consulteeIdx % shuffledConsultees.length];
    consulteeIdx++;

    try {
      // 1. Create Organization (BetterAuth table)
      const organization = await prisma.organization.create({
        data: {
          name,
          slug,
          logo: faker.image.urlPicsumPhotos({ width: 200, height: 200 }),
        },
      });

      // 2. Create OrganizationProfile
      const profile = await prisma.organizationProfile.create({
        data: {
          organizationId: organization.id,
          kind: "BUYER" as OrganizationKind,
          status: "ACTIVE",
          billingMode: spec.billingMode,
          billingEmail: faker.internet.email({
            firstName: "billing",
            lastName: slug,
          }),
          description: sanitizeString(
            faker.company.catchPhrase() + ". " + faker.lorem.sentence(),
          ),
          industry: faker.helpers.arrayElement(industries),
          sizeBucket: faker.helpers.arrayElement(sizeBuckets),
          website: faker.internet.url(),
          logo: faker.image.urlPicsumPhotos({ width: 200, height: 200 }),
          primaryColor: faker.color.rgb(),
          seatsTotal: faker.helpers.maybe(() =>
            faker.number.int({ min: 10, max: 200 }),
          ),
          paymentTermsDays: faker.helpers.arrayElement([7, 15, 30]),
        },
      });

      // 3. Create owner Member + OrganizationMemberProfile
      const ownerMember = await prisma.member.create({
        data: {
          organizationId: organization.id,
          userId: ownerUser.id,
          role: "ORG_OWNER",
        },
      });

      const ownerMemberProfile = await prisma.organizationMemberProfile.create({
        data: {
          memberId: ownerMember.id,
          organizationProfileId: profile.id,
          role: "ORG_OWNER",
          status: "ACTIVE",
        },
      });

      // 4. Add additional members (mix of ORG_ADMIN, ORG_MANAGER, ORG_LEARNER)
      const memberCount = getRandomInRange(config.volumes.membersPerOrg);
      const memberRoles: OrgMemberRole[] = [
        "ORG_ADMIN",
        "ORG_MANAGER",
        ...Array(Math.max(0, memberCount - 2)).fill("ORG_LEARNER"),
      ];

      let seatsUsed = 0;

      for (let m = 0; m < memberCount && consulteeIdx < shuffledConsultees.length; m++) {
        const memberUser = shuffledConsultees[consulteeIdx];
        consulteeIdx++;
        const role = memberRoles[m] ?? "ORG_LEARNER";

        // Skip if this user is already the owner
        if (memberUser.id === ownerUser.id) continue;

        // Check if already a member of this org
        const existing = await prisma.member.findUnique({
          where: {
            organizationId_userId: {
              organizationId: organization.id,
              userId: memberUser.id,
            },
          },
        });
        if (existing) continue;

        // Respect seatsTotal: if this slot would be ORG_LEARNER and the org is
        // already at capacity, downgrade to ORG_MANAGER so the DB CHECK
        // constraint (seatsUsed <= seatsTotal) is never violated by seed data.
        let effectiveRole = role;
        if (
          effectiveRole === "ORG_LEARNER" &&
          profile.seatsTotal !== null &&
          seatsUsed >= profile.seatsTotal
        ) {
          effectiveRole = "ORG_MANAGER";
        }

        const member = await prisma.member.create({
          data: {
            organizationId: organization.id,
            userId: memberUser.id,
            role: effectiveRole,
          },
        });

        await prisma.organizationMemberProfile.create({
          data: {
            memberId: member.id,
            organizationProfileId: profile.id,
            role: effectiveRole,
            status: "ACTIVE",
            consulteeProfileId:
              effectiveRole === "ORG_LEARNER"
                ? memberUser.consulteeProfile?.id ?? null
                : null,
            seatAssignedAt:
              effectiveRole === "ORG_LEARNER"
                ? faker.date.recent({ days: 30 })
                : null,
          },
        });

        if (effectiveRole === "ORG_LEARNER") seatsUsed++;
      }

      // Update seatsUsed
      if (seatsUsed > 0) {
        await prisma.organizationProfile.update({
          where: { id: profile.id },
          data: { seatsUsed },
        });
      }

      // 5. Create org plans
      const planCount = getRandomInRange(config.volumes.plansPerOrg);
      const planTypes = ["CONSULTATION", "WEBINAR", "CLASS"] as const;

      for (let p = 0; p < planCount; p++) {
        const planType = faker.helpers.arrayElement(planTypes);
        await prisma.organizationPlan.create({
          data: {
            organizationProfileId: profile.id,
            planType,
            title: sanitizeString(
              `${faker.commerce.productName()} — ${planType.toLowerCase()}`,
            ),
            description: sanitizeString(faker.commerce.productDescription()),
            price: faker.number.int({ min: 5000, max: 200000 }),
            priceCurrency: "INR",
            isActive: true,
            config: {},
          },
        });
      }

      // 6. SEAT_PACK: create credit pool with seeded balance
      if (spec.billingMode === "SEAT_PACK") {
        const balance = faker.number.int(CREDIT_BALANCE_RANGE);
        await prisma.orgCreditPool.create({
          data: {
            organizationProfileId: profile.id,
            balance,
            totalPurchased: balance + faker.number.int({ min: 0, max: 100000 }),
          },
        });

        // Seed a few ledger entries
        let runningBalance = 0;
        const totalPurchased = balance + faker.number.int({ min: 5000, max: 50000 });
        runningBalance = totalPurchased;

        await prisma.orgCreditLedger.create({
          data: {
            organizationProfileId: profile.id,
            delta: totalPurchased,
            reason: "purchase",
            balanceAfter: runningBalance,
          },
        });

        // A few deductions
        const deductionCount = faker.number.int({ min: 1, max: 4 });
        for (let d = 0; d < deductionCount; d++) {
          const deduct = faker.number.int({ min: 2000, max: 20000 });
          if (runningBalance - deduct < 0) break;
          runningBalance -= deduct;
          await prisma.orgCreditLedger.create({
            data: {
              organizationProfileId: profile.id,
              delta: -deduct,
              reason: "booking",
              balanceAfter: runningBalance,
            },
          });
        }

        // Reconcile pool balance to match ledger
        await prisma.orgCreditPool.update({
          where: { organizationProfileId: profile.id },
          data: { balance: runningBalance, totalPurchased },
        });

        // 6b. OrgCreditPurchase history — 1-3 confirmed purchases matching the pool total
        let remaining = totalPurchased;
        const purchaseCount = faker.number.int({ min: 1, max: 3 });
        for (let p = 0; p < purchaseCount; p++) {
          const isLast = p === purchaseCount - 1;
          const amount = isLast
            ? remaining
            : faker.number.int({ min: Math.floor(remaining * 0.2), max: Math.floor(remaining * 0.6) });
          remaining -= amount;
          // Simulate a completed Razorpay payment ID
          const fakePaymentId = `pay_seed_${faker.string.alphanumeric(14)}`;
          await prisma.orgCreditPurchase.create({
            data: {
              organizationProfileId: profile.id,
              creditsPurchased: amount,
              amountPaid: amount,
              currency: "INR",
              paymentId: fakePaymentId,
              purchasedAt: faker.date.recent({ days: 90 }),
            },
          });
          if (remaining <= 0) break;
        }
      }

      // 7. INVOICED_MONTHLY: create a sample invoice
      if (spec.billingMode === "INVOICED_MONTHLY") {
        const invoiceAmount = faker.number.int({ min: 50000, max: 500000 });
        const yyyymm = new Date().toISOString().slice(0, 7).replace("-", "");
        const rand = faker.string.alphanumeric(4).toUpperCase();

        await prisma.organizationInvoice.create({
          data: {
            organizationProfileId: profile.id,
            invoiceNumber: `INV-${slug.slice(0, 8).toUpperCase()}-${yyyymm}-${rand}`,
            amount: invoiceAmount,
            currency: "INR",
            status: faker.helpers.arrayElement(["DRAFT", "SENT", "PAID"]),
            items: [
              {
                description: "Monthly consultation bookings",
                quantity: faker.number.int({ min: 3, max: 15 }),
                unitPrice: faker.number.int({ min: 5000, max: 50000 }),
              },
            ],
            billingCycleStart: new Date(
              new Date().getFullYear(),
              new Date().getMonth() - 1,
              1,
            ),
            billingCycleEnd: new Date(
              new Date().getFullYear(),
              new Date().getMonth(),
              0,
            ),
            autoGenerated: true,
            dueDate: faker.date.soon({ days: 30 }),
            paidAt: faker.helpers.maybe(() => faker.date.recent({ days: 15 })),
            hsnCode: "999293",
          },
        });
      }

      // 8. Create SSO settings for ~30% of orgs
      if (faker.datatype.boolean(0.3)) {
        const domain = `${slug}.test`;
        await prisma.organizationSSOSettings.create({
          data: {
            organizationProfileId: profile.id,
            allowedEmailDomains: [domain],
            enforceSSO: faker.datatype.boolean(0.5),
            defaultRoleForAutoJoin: "ORG_LEARNER",
          },
        });
      }

      // 9. Create invitations (1-2 pending per org)
      const invitationCount = faker.number.int({ min: 0, max: 2 });
      for (let inv = 0; inv < invitationCount; inv++) {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 14);

        await prisma.invitation.create({
          data: {
            organizationId: organization.id,
            email: faker.internet.email(),
            role: "ORG_LEARNER",
            status: "pending",
            expiresAt,
            inviterId: ownerUser.id,
          },
        });
      }

      // 10. OrgAuditLog — seed initial MEMBER_ADDED entries for the owner
      // (member additions for other members bypass the API in seeding, so we
      //  only log the org creation / owner addition here for realism)
      await prisma.orgAuditLog.create({
        data: {
          organizationProfileId: profile.id,
          actorMemberId: ownerMemberProfile.id,
          targetMemberId: ownerMemberProfile.id,
          action: OrgAuditAction.MEMBER_ADDED,
          description: `${ownerUser.email ?? "owner"} added as ORG_OWNER (org creation)`,
          details: { role: "ORG_OWNER", email: ownerUser.email ?? null, viaOrgCreation: true },
        },
      });

      console.log(
        `    ✓ ${name} (${spec.billingMode}, ${memberCount + 1} members)`,
      );
    } catch (error) {
      console.error(`    ✗ Failed to create org "${name}":`, error);
    }
  }

  // ---------------------------------------------------------------------------
  // PROVIDER orgs — consultant agencies
  // ---------------------------------------------------------------------------

  const providerSpecs: {
    name: string;
    payoutFrequency: PayoutFrequency;
    platformCommissionRate: number;
    orgRetainRate: number;
    consultantPayoutRate: number;
  }[] = [
    {
      name: "TechConsult Partners",
      payoutFrequency: "MONTHLY",
      platformCommissionRate: 0.10,
      orgRetainRate: 0.05,
      consultantPayoutRate: 0.85,
    },
    {
      name: "Design Agency Co",
      payoutFrequency: "WEEKLY",
      platformCommissionRate: 0.15,
      orgRetainRate: 0.10,
      consultantPayoutRate: 0.75,
    },
  ];

  // Use only as many provider orgs as configured
  const providerCount = Math.min(counts.provider, providerSpecs.length);
  const shuffledConsultants = faker.helpers.shuffle([...consultants]);
  let consultantIdx = 0;

  for (let pi = 0; pi < providerCount; pi++) {
    const spec = providerSpecs[pi];
    const baseSlug = slugify(spec.name);
    const slug = `${baseSlug}-${faker.string.alphanumeric(4)}`;

    // Owner is a consultee user (org owners don't have to be consultants)
    const ownerUser =
      shuffledConsultees[consulteeIdx % shuffledConsultees.length];
    consulteeIdx++;

    try {
      // 1. BetterAuth Organization
      const organization = await prisma.organization.create({
        data: {
          name: spec.name,
          slug,
          logo: faker.image.urlPicsumPhotos({ width: 200, height: 200 }),
        },
      });

      // 2. OrganizationProfile — PROVIDER kind
      const profile = await prisma.organizationProfile.create({
        data: {
          organizationId: organization.id,
          kind: "PROVIDER" as OrganizationKind,
          status: "ACTIVE",
          billingMode: null, // PROVIDER orgs earn, they don't pay — no billing mode
          billingEmail: faker.internet.email({
            firstName: "finance",
            lastName: baseSlug,
          }),
          description: sanitizeString(
            `${spec.name} — ${faker.company.catchPhrase()}. Leading consulting agency.`,
          ),
          industry: "Consulting",
          sizeBucket: "MEDIUM_51_200",
          website: faker.internet.url(),
          logo: faker.image.urlPicsumPhotos({ width: 200, height: 200 }),
          primaryColor: faker.color.rgb(),
          platformCommissionRate: spec.platformCommissionRate,
          orgRetainRate: spec.orgRetainRate,
          consultantPayoutRate: spec.consultantPayoutRate,
          payoutFrequency: spec.payoutFrequency,
          enforceOrganizationPlans: pi === 0, // first provider enforces org plans
          autoApproveConsultants: pi === 1, // second provider auto-approves
          paymentTermsDays: 30,
        },
      });

      // 3. Owner member
      const ownerMember = await prisma.member.create({
        data: {
          organizationId: organization.id,
          userId: ownerUser.id,
          role: "ORG_OWNER",
        },
      });

      const ownerMemberProfile = await prisma.organizationMemberProfile.create({
        data: {
          memberId: ownerMember.id,
          organizationProfileId: profile.id,
          role: "ORG_OWNER",
          status: "ACTIVE",
        },
      });

      // Audit: org created
      await prisma.orgAuditLog.create({
        data: {
          organizationProfileId: profile.id,
          actorMemberId: ownerMemberProfile.id,
          targetMemberId: ownerMemberProfile.id,
          action: OrgAuditAction.MEMBER_ADDED,
          description: `${ownerUser.email ?? "owner"} added as ORG_OWNER (PROVIDER org creation)`,
          details: { role: "ORG_OWNER", kind: "PROVIDER" },
        },
      });

      // 4. Add ORG_CONSULTANT members (2-3 per provider org)
      const consultantCount = faker.number.int({ min: 2, max: 3 });
      const addedConsultantMemberProfiles: {
        memberProfileId: string;
        consultantProfileId: string;
      }[] = [];

      for (
        let ci = 0;
        ci < consultantCount && consultantIdx < shuffledConsultants.length;
        ci++
      ) {
        const cUser = shuffledConsultants[consultantIdx];
        consultantIdx++;

        if (cUser.id === ownerUser.id) continue;

        // Ensure not already a member
        const existing = await prisma.member.findUnique({
          where: {
            organizationId_userId: {
              organizationId: organization.id,
              userId: cUser.id,
            },
          },
        });
        if (existing) continue;

        const member = await prisma.member.create({
          data: {
            organizationId: organization.id,
            userId: cUser.id,
            role: "ORG_CONSULTANT",
          },
        });

        // First consultant: earningsRecipient = ORGANIZATION (internal/salaried)
        // Second consultant: custom payout rate override
        const isFirstConsultant = ci === 0;
        const isSecondConsultant = ci === 1;

        const memberProfile = await prisma.organizationMemberProfile.create({
          data: {
            memberId: member.id,
            organizationProfileId: profile.id,
            role: "ORG_CONSULTANT",
            status: "ACTIVE",
            consultantProfileId: cUser.consultantProfile?.id ?? null,
            earningsRecipient: isFirstConsultant
              ? ("ORGANIZATION" as EarningsRecipient)
              : ("CONSULTANT" as EarningsRecipient),
            customConsultantPayoutRate: isSecondConsultant ? 0.90 : null,
            applicationNote: faker.helpers.maybe(
              () => sanitizeString(faker.lorem.sentence()),
              { probability: 0.6 },
            ),
            appliedAt: faker.date.recent({ days: 60 }),
            approvedAt: faker.date.recent({ days: 30 }),
            approvedBy: ownerMemberProfile.id,
          },
        });

        addedConsultantMemberProfiles.push({
          memberProfileId: memberProfile.id,
          consultantProfileId: cUser.consultantProfile?.id ?? "",
        });

        // Audit: consultant approved
        await prisma.orgAuditLog.create({
          data: {
            organizationProfileId: profile.id,
            actorMemberId: ownerMemberProfile.id,
            targetMemberId: memberProfile.id,
            action: OrgAuditAction.CONSULTANT_APPROVED,
            description: `${cUser.email ?? "consultant"} approved as ORG_CONSULTANT`,
            details: {
              consultantProfileId: cUser.consultantProfile?.id ?? null,
              earningsRecipient: isFirstConsultant ? "ORGANIZATION" : "CONSULTANT",
            },
          },
        });
      }

      // 5. Payout account (VERIFIED, dummy bank details)
      const bank = faker.helpers.arrayElement([...INDIAN_BANKS]);
      await prisma.organizationPayoutAccount.create({
        data: {
          organizationProfileId: profile.id,
          accountHolderName: spec.name,
          accountNumberEncrypted: Buffer.from(
            faker.finance.accountNumber(12),
          ).toString("base64"),
          accountNumberLast4: faker.string.numeric(4),
          bankName: bank.name,
          ifscCode: generateIfscCode(bank),
          razorpayContactId: generateRazorpayContactId(),
          razorpayFundAccountId: generateRazorpayFundAccountId(),
          status: "VERIFIED",
          verifiedAt: faker.date.recent({ days: 60 }),
        },
      });

      // 6. Create a few OrganizationEarnings rows.
      //    We create stub Payment rows to satisfy the FK — using the org owner
      //    as the paying user (realistic enough for seed data).
      const earningsCount = faker.number.int({ min: 2, max: 4 });
      for (let ei = 0; ei < earningsCount; ei++) {
        const grossAmount = faker.number.int({ min: 10000, max: 200000 });
        const platformFee = Math.round(
          grossAmount * spec.platformCommissionRate,
        );
        const orgShare = Math.round(grossAmount * spec.orgRetainRate);

        // Create a stub Payment to satisfy the FK
        const stubPayment = await prisma.payment.create({
          data: {
            amount: grossAmount,
            originalAmount: grossAmount,
            currency: "INR",
            paymentMethod: "card",
            paymentIntent: `pi_seed_provider_${faker.string.alphanumeric(20)}`,
            paymentGateway: "RAZORPAY",
            paymentStatus: "SUCCEEDED",
            userId: ownerUser.id,
            organizationProfileId: profile.id,
            isMockPayment: true,
          },
        });

        await prisma.organizationEarnings.create({
          data: {
            organizationProfileId: profile.id,
            paymentId: stubPayment.id,
            grossAmount,
            platformFee,
            orgShare,
            status: faker.helpers.arrayElement([
              "PENDING",
              "READY",
              "PAID",
            ]) as EarningStatus,
            holdUntil: generateHoldUntilDate(new Date()),
            currency: "INR",
          },
        });
      }

      // 7. Audit: settings changed (payout frequency)
      await prisma.orgAuditLog.create({
        data: {
          organizationProfileId: profile.id,
          actorMemberId: ownerMemberProfile.id,
          action: OrgAuditAction.SETTINGS_CHANGED,
          description: `Payout frequency set to ${spec.payoutFrequency}`,
          details: {
            field: "payoutFrequency",
            newValue: spec.payoutFrequency,
          },
        },
      });

      console.log(
        `    ✓ ${spec.name} (PROVIDER, ${spec.payoutFrequency} payouts, ${addedConsultantMemberProfiles.length} consultants)`,
      );
    } catch (error) {
      console.error(
        `    ✗ Failed to create PROVIDER org "${spec.name}":`,
        error,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // HYBRID org — dual buyer+provider (e.g. university)
  // ---------------------------------------------------------------------------

  const hybridSpecs: {
    name: string;
    payoutFrequency: PayoutFrequency;
    billingMode: OrganizationBillingMode;
  }[] = [
    {
      name: "EduTech University",
      payoutFrequency: "MONTHLY",
      billingMode: "SEAT_PACK",
    },
  ];

  const hybridCount = Math.min(counts.hybrid, hybridSpecs.length);

  for (let hi = 0; hi < hybridCount; hi++) {
    const spec = hybridSpecs[hi];
    const baseSlug = slugify(spec.name);
    const slug = `${baseSlug}-${faker.string.alphanumeric(4)}`;

    const ownerUser =
      shuffledConsultees[consulteeIdx % shuffledConsultees.length];
    consulteeIdx++;

    try {
      // 1. BetterAuth Organization
      const organization = await prisma.organization.create({
        data: {
          name: spec.name,
          slug,
          logo: faker.image.urlPicsumPhotos({ width: 200, height: 200 }),
        },
      });

      // 2. OrganizationProfile — HYBRID kind with SEAT_PACK billing
      const profile = await prisma.organizationProfile.create({
        data: {
          organizationId: organization.id,
          kind: "HYBRID" as OrganizationKind,
          status: "ACTIVE",
          billingMode: spec.billingMode,
          billingEmail: faker.internet.email({
            firstName: "admin",
            lastName: baseSlug,
          }),
          description: sanitizeString(
            `${spec.name} — A leading educational institution offering both courses and consulting services.`,
          ),
          industry: "Education",
          sizeBucket: "LARGE_201_1000",
          website: faker.internet.url(),
          logo: faker.image.urlPicsumPhotos({ width: 200, height: 200 }),
          primaryColor: faker.color.rgb(),
          platformCommissionRate: 0.10,
          orgRetainRate: 0.08,
          consultantPayoutRate: 0.82,
          payoutFrequency: spec.payoutFrequency,
          enforceOrganizationPlans: false,
          seatsTotal: faker.number.int({ min: 50, max: 200 }),
          paymentTermsDays: 30,
        },
      });

      // 3. Owner member
      const ownerMember = await prisma.member.create({
        data: {
          organizationId: organization.id,
          userId: ownerUser.id,
          role: "ORG_OWNER",
        },
      });

      const ownerMemberProfile = await prisma.organizationMemberProfile.create({
        data: {
          memberId: ownerMember.id,
          organizationProfileId: profile.id,
          role: "ORG_OWNER",
          status: "ACTIVE",
        },
      });

      // Audit: org created
      await prisma.orgAuditLog.create({
        data: {
          organizationProfileId: profile.id,
          actorMemberId: ownerMemberProfile.id,
          targetMemberId: ownerMemberProfile.id,
          action: OrgAuditAction.MEMBER_ADDED,
          description: `${ownerUser.email ?? "owner"} added as ORG_OWNER (HYBRID org creation)`,
          details: { role: "ORG_OWNER", kind: "HYBRID" },
        },
      });

      // 4a. Add ORG_LEARNER members (BUYER side) — 2-3 learners
      const learnerCount = faker.number.int({ min: 2, max: 3 });
      let seatsUsed = 0;

      for (
        let li = 0;
        li < learnerCount && consulteeIdx < shuffledConsultees.length;
        li++
      ) {
        const lUser = shuffledConsultees[consulteeIdx];
        consulteeIdx++;

        if (lUser.id === ownerUser.id) continue;

        const existing = await prisma.member.findUnique({
          where: {
            organizationId_userId: {
              organizationId: organization.id,
              userId: lUser.id,
            },
          },
        });
        if (existing) continue;

        // Respect seatsTotal
        if (profile.seatsTotal !== null && seatsUsed >= profile.seatsTotal)
          break;

        const member = await prisma.member.create({
          data: {
            organizationId: organization.id,
            userId: lUser.id,
            role: "ORG_LEARNER",
          },
        });

        await prisma.organizationMemberProfile.create({
          data: {
            memberId: member.id,
            organizationProfileId: profile.id,
            role: "ORG_LEARNER",
            status: "ACTIVE",
            consulteeProfileId: lUser.consulteeProfile?.id ?? null,
            seatAssignedAt: faker.date.recent({ days: 30 }),
          },
        });

        seatsUsed++;
      }

      // 4b. Add ORG_CONSULTANT members (PROVIDER side) — 1-2 consultants
      const hybridConsultantCount = faker.number.int({ min: 1, max: 2 });

      for (
        let ci = 0;
        ci < hybridConsultantCount &&
        consultantIdx < shuffledConsultants.length;
        ci++
      ) {
        const cUser = shuffledConsultants[consultantIdx];
        consultantIdx++;

        if (cUser.id === ownerUser.id) continue;

        const existing = await prisma.member.findUnique({
          where: {
            organizationId_userId: {
              organizationId: organization.id,
              userId: cUser.id,
            },
          },
        });
        if (existing) continue;

        const member = await prisma.member.create({
          data: {
            organizationId: organization.id,
            userId: cUser.id,
            role: "ORG_CONSULTANT",
          },
        });

        const memberProfile = await prisma.organizationMemberProfile.create({
          data: {
            memberId: member.id,
            organizationProfileId: profile.id,
            role: "ORG_CONSULTANT",
            status: "ACTIVE",
            consultantProfileId: cUser.consultantProfile?.id ?? null,
            earningsRecipient: "CONSULTANT" as EarningsRecipient,
            appliedAt: faker.date.recent({ days: 45 }),
            approvedAt: faker.date.recent({ days: 20 }),
            approvedBy: ownerMemberProfile.id,
          },
        });

        await prisma.orgAuditLog.create({
          data: {
            organizationProfileId: profile.id,
            actorMemberId: ownerMemberProfile.id,
            targetMemberId: memberProfile.id,
            action: OrgAuditAction.CONSULTANT_APPROVED,
            description: `${cUser.email ?? "consultant"} approved as ORG_CONSULTANT (HYBRID)`,
            details: {
              consultantProfileId: cUser.consultantProfile?.id ?? null,
            },
          },
        });
      }

      // 5. Update seatsUsed
      if (seatsUsed > 0) {
        await prisma.organizationProfile.update({
          where: { id: profile.id },
          data: { seatsUsed },
        });
      }

      // 6. SEAT_PACK credit pool (HYBRID uses SEAT_PACK billing)
      if (spec.billingMode === "SEAT_PACK") {
        const balance = faker.number.int(CREDIT_BALANCE_RANGE);
        const totalPurchased =
          balance + faker.number.int({ min: 5000, max: 50000 });

        await prisma.orgCreditPool.create({
          data: {
            organizationProfileId: profile.id,
            balance,
            totalPurchased,
          },
        });

        await prisma.orgCreditLedger.create({
          data: {
            organizationProfileId: profile.id,
            delta: totalPurchased,
            reason: "purchase",
            balanceAfter: totalPurchased,
          },
        });

        // Purchase history
        const fakePaymentId = `pay_seed_${faker.string.alphanumeric(14)}`;
        await prisma.orgCreditPurchase.create({
          data: {
            organizationProfileId: profile.id,
            creditsPurchased: totalPurchased,
            amountPaid: totalPurchased,
            currency: "INR",
            paymentId: fakePaymentId,
            purchasedAt: faker.date.recent({ days: 60 }),
          },
        });
      }

      // 7. Payout account for the PROVIDER side
      const bank = faker.helpers.arrayElement([...INDIAN_BANKS]);
      await prisma.organizationPayoutAccount.create({
        data: {
          organizationProfileId: profile.id,
          accountHolderName: spec.name,
          accountNumberEncrypted: Buffer.from(
            faker.finance.accountNumber(12),
          ).toString("base64"),
          accountNumberLast4: faker.string.numeric(4),
          bankName: bank.name,
          ifscCode: generateIfscCode(bank),
          razorpayContactId: generateRazorpayContactId(),
          razorpayFundAccountId: generateRazorpayFundAccountId(),
          status: "VERIFIED",
          verifiedAt: faker.date.recent({ days: 45 }),
        },
      });

      console.log(
        `    ✓ ${spec.name} (HYBRID, ${spec.billingMode}, ${seatsUsed} learners, ${hybridConsultantCount} consultants)`,
      );
    } catch (error) {
      console.error(
        `    ✗ Failed to create HYBRID org "${spec.name}":`,
        error,
      );
    }
  }

  // Create one admin-accessible org for testing the platform admin bypass
  if (admins.length > 0) {
    try {
      const adminOrg = await prisma.organization.create({
        data: {
          name: "Platform Admin Test Org",
          slug: `admin-test-org-${faker.string.alphanumeric(4)}`,
        },
      });

      await prisma.organizationProfile.create({
        data: {
          organizationId: adminOrg.id,
          kind: "BUYER",
          status: "ACTIVE",
          billingMode: "TAG_ONLY",
          billingEmail: "admin-test@familiarise.com",
          description: "Test org for verifying admin bypass in requireOrgAccess",
        },
      });

      console.log(`    ✓ Platform Admin Test Org (no members — admin bypass testing)`);
    } catch (error) {
      console.error("    ✗ Failed to create admin test org:", error);
    }
  }

  console.log(`  ✓ Enterprise organizations seeded`);
}
