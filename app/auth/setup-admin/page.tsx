import Link from "next/link";
import prisma from "@/lib/prisma";

/**
 * #1927 — `/auth/setup-admin`: the one-time setup page.
 *
 * ## What it is
 *
 * A status page. It answers one question — "does this deployment have a
 * platform administrator?" — and, when the answer is no, prints the exact
 * command that makes one.
 *
 * ## What it deliberately does NOT do
 *
 * **It cannot mint an administrator.** Not a token, not a session, not a
 * pending row, not an emailed link. This page is unauthenticated (the whole
 * `/auth/` tree is in `PUBLIC_AUTH_PREFIXES`), so a page that could create an
 * admin would be an unauthenticated privilege-escalation endpoint: anyone who
 * could load a URL would be an administrator. The only actor with the
 * authority to create the first admin is someone with shell access to the
 * environment, which is what `scripts/bootstrap-admin.ts` requires and this
 * page does not.
 *
 * The page's whole job is to close the loop in the other direction: the
 * onboarding form tells a person "Staff and Admin accounts are invite-only.
 * Please contact an administrator"
 * (`utils/onboarding-server.ts:824`), and on a fresh deployment there is no
 * administrator to contact and no dashboard to invite from. Someone arrives
 * here, and the next step is written down.
 *
 * ## Disclosure
 *
 * The page reveals one boolean: whether an admin exists. That is not a secret
 * worth protecting — it is the state every operator can infer by trying to
 * sign in, and hiding it would only make the recovery harder to find. It
 * reveals no admin's address, id, or count, and on a healthy deployment it is
 * the same page for everyone.
 */
export const dynamic = "force-dynamic";

export default async function SetupAdminPage() {
  const adminExists = await prisma.user
    .findFirst({ where: { role: "ADMIN" }, select: { id: true } })
    .then((row) => row !== null)
    .catch(() => {
      // A database blip must not render "no admin exists" and send an
      // operator to mint a second one. Unknown is its own state, and it is
      // rendered as such below.
      return null;
    });

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-white">
      <div className="mx-auto flex w-full max-w-md flex-col">
        <div className="text-center">
          <h2 className="text-fluid-3xl font-semibold tracking-tight">
            Administrator setup
          </h2>
          <p className="mt-2 text-sm text-zinc-400 md:text-base">
            A platform administrator can issue refunds, process payouts and
            manage every account. Exactly one is created by hand, once.
          </p>
        </div>

        <div className="mt-8 rounded border border-zinc-700 bg-zinc-900 p-4 text-sm">
          {adminExists === null ? (
            <p className="text-amber-300">
              We could not reach the database, so we cannot tell you whether an
              administrator exists. Check with{" "}
              <code className="text-zinc-100">
                SELECT count(*) FROM &quot;User&quot; WHERE role =
                &apos;ADMIN&apos;
              </code>{" "}
              before doing anything.
            </p>
          ) : adminExists ? (
            <>
              <p className="text-green-400">
                An administrator already exists on this deployment.
              </p>
              <p className="mt-3 text-zinc-300">
                You do not need this page. If you have lost access, use the
                password-reset link on the sign-in page, or have another
                administrator suspend and re-invite the account from the Team
                page.
              </p>
            </>
          ) : (
            <>
              <p className="text-amber-300">
                <strong>No administrator exists on this deployment.</strong>
              </p>
              <p className="mt-3 text-zinc-300">
                This is expected on a fresh environment and is not something
                this page can fix on its own — creating the first administrator
                needs shell access to the environment, by design. From a machine
                that can reach the database, run:
              </p>
              <pre className="mt-3 overflow-x-auto rounded bg-black p-3 text-xs text-zinc-100">
                {"npx tsx -r dotenv/config scripts/bootstrap-admin.ts\n"}
                {"  --email you@your-company.com --print"}
              </pre>
              <p className="mt-3 text-zinc-400">
                It writes an invitation, never a password, and prints a setup
                link you open once. Drop{" "}
                <code className="text-zinc-100">--print</code> to have it
                emailed instead. If your address is a personal one, that is fine
                — the platform does not require a company domain.
              </p>
            </>
          )}
        </div>

        <div className="mt-6 text-center text-sm">
          <Link
            href="/auth/signin"
            className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
