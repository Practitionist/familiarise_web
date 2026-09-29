/**
 * #1927 — `scripts/bootstrap-admin.ts`: create the FIRST platform admin.
 *
 * ## Why this exists at all
 *
 * There was no way to make an admin. `UserRole.ADMIN` and `UserRole.STAFF`
 * are hard-rejected from self-service onboarding
 * (`utils/onboarding-server.ts:824`), the only `role: STAFF` write site was
 * `app/api/user/staff/route.ts` — which itself required an existing ADMIN —
 * and production admins existed solely because `prisma/seed.ts` creates faker
 * users with a `SeedPass123!` default. So the "production" admin on a real
 * deployment was a faker row with a password printed in a README. This script
 * is the front door that is missing.
 *
 * ## What it NEVER does
 *
 * **It never writes a password.** Not a generated one, not a default one, not
 * a hashed one. It writes a `StaffInvitation` row and either mails the setup
 * link or prints it. The password is chosen by the person who opens the link,
 * which means it is never in a shell history, a CI log, a deploy transcript or
 * a password manager belonging to someone who is not the account holder. That
 * is the entire reason this is a script and not a `--password` flag.
 *
 * ## How a second admin is prevented
 *
 * The guard is not "did you pass --force" — it is a **transactional** check,
 * and that distinction is the whole design. See `assertNoAdminExists` below.
 *
 * ## Idempotency
 *
 * Re-running for an address that already has a PENDING invitation is a no-op
 * that reports the existing state (and, with `--print`, re-prints nothing —
 * the token is unrecoverable by design, so it says so and tells the operator to
 * revoke and re-invite, or use `--resend`). Re-running for an address that
 * already has an account is a refusal. Re-running when an admin exists at all
 * is a refusal unless `--force`.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import prisma from "../lib/prisma";
import {
  STAFF_INVITATION_TTL_MS,
  hashStaffInvitationToken,
  mintStaffInvitationToken,
  normalizeStaffEmail,
  stageStaffInvitationEmail,
  STAFF_INVITATION_EMAIL_BUDGET_MS,
} from "../lib/auth/staff-invitations";
import { attemptStagedEmail } from "../lib/email";
import { getAppUrl } from "../lib/url";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Args {
  email: string | null;
  role: "ADMIN" | "STAFF";
  force: boolean;
  print: boolean;
  resend: boolean;
  iKnowThis: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    email: null,
    role: "ADMIN",
    force: false,
    print: false,
    resend: false,
    iKnowThis: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--email":
        args.email = next();
        break;
      case "--role":
        args.role = next().toUpperCase() === "STAFF" ? "STAFF" : "ADMIN";
        break;
      case "--force":
        args.force = true;
        break;
      case "--print":
        args.print = true;
        break;
      case "--resend":
        args.resend = true;
        break;
      case "--i-know-this":
        args.iKnowThis = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
#1927 — bootstrap the first platform administrator.

  npx tsx -r dotenv/config scripts/bootstrap-admin.ts --email you@… [--print]

  --email <address>  who the invitation is addressed to. Required.
  --role  ADMIN|STAFF default ADMIN. Only ADMIN is useful before one exists;
                      STAFF exists so a fresh environment can seed a support
                      account without minting an admin.
  --print            print the setup link instead of emailing it. For an
                     operator with no mail access to the address (a CI box, a
                     laptop with no Resend key). The link is shown ONCE.
  --resend           rotate the token on an address that already has a PENDING
                     invitation. The old link stops working immediately.
  --force            create the invitation even though an admin already exists.
  --i-know-this      required with NODE_ENV=production.

The script never writes a password. It writes an invitation; the recipient
chooses their own password on the setup page.

Refuses to run in production without --i-know-this, because the one thing this
script can do on a production database is hand an unaccounted-for human
platform-wide authority, and "I typed the flag" should be a deliberate act
rather than a reflex.
`);
}

/* -------------------------------------------------------------------------- */
/* The second-admin guard                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown for every refusal, so main() has one exit path. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

/**
 * Refuse while any ADMIN exists, unless `--force`.
 *
 * ## Why the check has to be inside the transaction
 *
 * A `count()` before the `create` is a TOCTOU, and this is the one place in
 * the app where that race has a security consequence. Two operators booting a
 * fresh environment at the same moment — a very ordinary thing, because the
 * incident that prompts the bootstrap is usually "the site is down and we need
 * in there now" — both read `count() === 0`, both insert, and the deployment
 * ends up with two admins when the runbook says there is one. The person who
 * owns a customer account after an incident is frequently not the person who
 * ran the recovery, so the second admin is usually innocent and permanent.
 *
 * So the count is read on the SAME connection as the insert, inside the
 * transaction, immediately before it. That still does not make it a database
 * constraint — under READ COMMITTED two such transactions can each see zero —
 * so the transaction runs at `Serializable`, where PostgreSQL will abort one of
 * them with a serialization failure rather than letting both commit. The
 * caller retries; the retry sees the admin the winner created and refuses.
 *
 * This is the belt to the `users.moderate` braces: after the first admin
 * exists, every further grant is an audited, 2FA-gated, admin-initiated act
 * through `POST /api/admin/staff-invitations`, which is where it belongs.
 */
async function assertNoAdminExists(
  db: Pick<
    typeof prisma,
    "user" | "staffInvitation" | "failedEmail" | "emailSuppression"
  >,
  opts: { force: boolean },
): Promise<void> {
  const existing = await db.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true, email: true, createdAt: true },
  });
  if (existing && !opts.force) {
    throw new Refusal(
      `An admin already exists (${existing.email}). This script is for the FIRST one.`,
      "To give someone else access, use POST /api/admin/staff-invitations from the Team page — it is audited, rate-limited, and binds the recipient to their own address. Pass --force only if you are deliberately adding an administrator from the CLI.",
    );
  }
  if (existing) {
    console.warn(
      `⚠️  --force: an admin already exists (${existing.email}); adding another from the CLI.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.NODE_ENV === "production" && !args.iKnowThis) {
    throw new Refusal(
      "Refusing to run against production without --i-know-this.",
      "This script can hand platform-wide authority to an unaccounted-for human. If you are sure, re-run with --i-know-this and put the reason in the change log.",
    );
  }

  if (!args.email) {
    printUsage();
    throw new Refusal("--email is required.");
  }
  const email = normalizeStaffEmail(args.email);
  // Deliberately loose: this is an operator typing their own address into a
  // terminal, not a customer-facing form, and an over-strict regex here has
  // historically been the thing that stopped a recovery. A bad address fails
  // loudly at accept time (the User row is never created) rather than
  // silently.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    throw new Refusal(`"${args.email}" does not look like an email address.`);
  }

  const rawToken = mintStaffInvitationToken();
  const expiresAt = new Date(Date.now() + STAFF_INVITATION_TTL_MS);
  const tokenHash = hashStaffInvitationToken(rawToken);
  const inviteUrl = `${getAppUrl()}/auth/staff-invite?token=${encodeURIComponent(rawToken)}`;

  console.log("═".repeat(64));
  console.log("#1927 — bootstrap platform administrator");
  console.log("═".repeat(64));
  console.log(`  address : ${email}`);
  console.log(`  role    : ${args.role}`);
  console.log(`  expires : ${expiresAt.toISOString()} (72h)`);
  console.log("");

  // One transaction: the admin-existence guard, the account-collision check,
  // the invitation row, and the outbox row for its mail. A mail staged for an
  // invitation that then failed to commit is a live credential in an
  // unaccounted-for inbox, so the two must not be separable.
  const result = await prisma.$transaction(
    async (tx) => {
      await assertNoAdminExists(tx, { force: args.force });

      const existingUser = await tx.user.findUnique({
        where: { email },
        select: { id: true, role: true },
      });
      if (existingUser) {
        throw new Refusal(
          `${email} already has an account (role ${existingUser.role}).`,
          "Use the Team page to change their role or suspend them; do not bootstrap a second identity for one person.",
        );
      }

      const pending = await tx.staffInvitation.findFirst({
        where: { email, status: "PENDING" },
      });
      if (pending && !args.resend) {
        throw new Refusal(
          `${email} already has a PENDING invitation (id ${pending.id}, expires ${pending.expiresAt.toISOString()}).`,
          "The token is stored only as a hash, so it cannot be recovered or reprinted. Either wait for the existing link, or re-run with --resend to rotate it (the old link stops working immediately).",
        );
      }

      let invitationId: string;
      if (pending) {
        await tx.staffInvitation.update({
          where: { id: pending.id },
          data: {
            tokenHash,
            expiresAt,
            role: args.role,
            sentCount: { increment: 1 },
            lastSentAt: new Date(),
          },
        });
        invitationId = pending.id;
      } else {
        const created = await tx.staffInvitation.create({
          data: {
            email,
            role: args.role,
            tokenHash,
            expiresAt,
            sentCount: 1,
            lastSentAt: new Date(),
            // Null: this script has no signed-in admin behind it. The audit
            // record of WHO minted the first admin is the terminal, the change
            // log, and the OpsActionLog row the Team page will show once the
            // account exists — not a fabricated actor.
            invitedByUserId: null,
          },
          select: { id: true },
        });
        invitationId = created.id;
      }

      // `--print` still stages the mail unless it is suppressed, because an
      // operator who asked to print it may ALSO be reachable by mail and a
      // half-created channel is worse than a duplicate one. `--print` only
      // changes whether the link is shown on this terminal.
      const staged = await stageStaffInvitationEmail(
        {
          email,
          inviterName: "Familiarise bootstrap (CLI)",
          role: args.role,
          rawToken,
          expiresAt,
        },
        tx,
      );
      return { invitationId, staged, resent: Boolean(pending) };
    },
    // See assertNoAdminExists: this is the level that makes the
    // count-then-insert guard a real invariant rather than a race.
    { isolationLevel: "Serializable" },
  );

  // Vendor call after commit, like every route in this app — a Resend stall
  // must not hold the transaction open.
  await attemptStagedEmail(result.staged, STAFF_INVITATION_EMAIL_BUDGET_MS);

  console.log(
    `  invitation : ${result.invitationId}${result.resent ? " (token rotated)" : ""}`,
  );
  console.log("");

  if (args.print) {
    console.log("─".repeat(64));
    console.log("SETUP LINK — shown once, and not recoverable:");
    console.log("");
    console.log(`  ${inviteUrl}`);
    console.log("");
    console.log("─".repeat(64));
    console.log("");
    console.log("  A mail was also staged for this address. If that was not");
    console.log("  wanted, revoke the invitation from the Team page.");
    console.log("");
  } else {
    console.log(`  Setup link emailed to ${email}.`);
    console.log("  If it does not arrive, re-run with --print to see the link");
    console.log("  instead (or with --resend to rotate the token).");
    console.log("");
  }

  console.log(
    "  Next: the recipient opens the link, chooses a password, and is",
  );
  console.log("  sent to sign-in. They will be asked for two-factor");
  console.log("  authentication the first time they open the console.");
  console.log("");
  console.log(
    "  No password was written by this script, and none is recoverable.",
  );
  console.log("");

  // Correlation id so the row is findable in a log aggregator when the mail
  // path is the thing that failed.
  console.log(
    JSON.stringify({
      event: "bootstrap_admin_invitation",
      correlationId: randomUUID(),
      invitationId: result.invitationId,
      role: args.role,
      printed: args.print,
      resent: result.resent,
    }),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    if (error instanceof Refusal) {
      console.error("");
      console.error(`✗ ${error.message}`);
      if (error.hint) {
        console.error(`  ${error.hint}`);
      }
    } else {
      console.error("");
      console.error(
        "✗ bootstrap-admin failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    await prisma.$disconnect();
    process.exit(1);
  });
