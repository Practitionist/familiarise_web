/**
 * Test: Organization Onboarding Double-Submit
 * Category: 07 - Real API booking races (#837 scenario 13)
 *
 * A stuttering click submits org creation twice concurrently with the same
 * name. The slug-unique guard inside the creation tx must admit exactly one;
 * exactly one Organization row may exist afterwards.
 */
import "dotenv/config";
import prisma from "../../../../../lib/prisma";
import {
  apiFetch,
  assertExactlyOneWinner,
  check,
  finish,
  fireConcurrent,
  loginAs,
} from "../../utilities/api-client";

async function run() {
  const admin = await loginAs(
    process.env.CHAOS_ADMIN_EMAIL ?? "olivia.brown@protonmail.com",
  );

  const name = `Chaos Double Submit ${process.pid}`;
  const slug = `chaos-double-submit-${process.pid}`;

  const results = await fireConcurrent(2, () =>
    apiFetch("/api/organizations", {
      method: "POST",
      session: admin,
      body: JSON.stringify({
        name,
        slug,
        billingEmail: `chaos-${process.pid}@example.com`,
      }),
    }),
  );

  assertExactlyOneWinner("org double-submit: exactly one winner", results);

  const rows = await prisma.organization.findMany({
    where: { slug },
    select: { id: true },
  });
  check("exactly one Organization row exists", rows.length === 1, rows);

  // Cleanup the chaos org (and its dependents) for repeat runs.
  for (const row of rows) {
    await prisma.organization
      .delete({ where: { id: row.id } })
      .catch(async () => {
        // FK-restricted children (audit rows etc.) — leave for manual sweep,
        // but flag it so the run output shows the residue.
        console.warn(`⚠️  could not delete chaos org ${row.id}; manual cleanup needed`);
      });
  }

  finish("onboarding-double-submit-org");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
