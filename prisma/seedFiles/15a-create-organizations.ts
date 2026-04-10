/**
 * Phase 15: Enterprise Organizations
 *
 * Creates organizations with all three billing modes, org members drawn from
 * existing consultee/consultant users, org plans, credit pools, SSO settings,
 * and sample invoices. Runs after all other phases so it can reference
 * existing users, payments, and profiles.
 */

import { faker } from "@faker-js/faker";
import {
  OrganizationBillingMode,
  OrganizationKind,
  OrgMemberRole,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import { sanitizeString } from "./utils";
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
  const totalOrgs = counts.buyer + counts.seatPack + counts.invoiced;

  console.log(
    `  Creating ${totalOrgs} organizations (${counts.buyer} TAG_ONLY, ${counts.seatPack} SEAT_PACK, ${counts.invoiced} INVOICED_MONTHLY)...`,
  );

  const consultees = users.filter(
    (u) => u.role === "CONSULTEE" && u.consulteeProfile?.id,
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

      await prisma.organizationMemberProfile.create({
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

        const member = await prisma.member.create({
          data: {
            organizationId: organization.id,
            userId: memberUser.id,
            role,
          },
        });

        await prisma.organizationMemberProfile.create({
          data: {
            memberId: member.id,
            organizationProfileId: profile.id,
            role,
            status: "ACTIVE",
            consulteeProfileId:
              role === "ORG_LEARNER"
                ? memberUser.consulteeProfile?.id ?? null
                : null,
            seatAssignedAt:
              role === "ORG_LEARNER" ? faker.date.recent({ days: 30 }) : null,
          },
        });

        if (role === "ORG_LEARNER") seatsUsed++;
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

      console.log(
        `    ✓ ${name} (${spec.billingMode}, ${memberCount + 1} members)`,
      );
    } catch (error) {
      console.error(`    ✗ Failed to create org "${name}":`, error);
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
