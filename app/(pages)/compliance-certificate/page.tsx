import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BadgeCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  COMPANY_INFO,
  DARK_PATTERN_AUDIT,
  isDarkPatternAuditSigned,
} from "@/lib/company";

export function generateMetadata(): Metadata {
  if (!isDarkPatternAuditSigned(DARK_PATTERN_AUDIT)) {
    return { title: "Page not found", robots: { index: false, follow: false } };
  }
  return {
    title: `Dark-Pattern Compliance Certificate | ${COMPANY_INFO.name}`,
    description:
      "Our annual self-audit of every buyer flow against the 13 dark patterns in the CCPA Guidelines, 2023: scope, method, outcome, signatory and next due date.",
  };
}

const DEFAULT_OUTCOME =
  "Each finding was recorded, fixed where it could be, and tracked until closed. Anything still open at signing is kept in the audit record held by the company.";

function formatDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? isoDate
    : parsed.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
}

export default function ComplianceCertificatePage() {
  const audit = DARK_PATTERN_AUDIT;
  if (!isDarkPatternAuditSigned(audit)) notFound();

  const period =
    audit.periodFrom && audit.periodTo
      ? `${formatDate(audit.periodFrom)} to ${formatDate(audit.periodTo)}`
      : null;

  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <BadgeCheck className="h-16 w-16 text-foreground" />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            Dark-Pattern Compliance Certificate
          </h1>
          <p className="text-muted-foreground max-w-3xl mx-auto">
            Our yearly self-audit under the Consumer Protection (E-Commerce)
            (Amendment) Rules, 2026, against the Guidelines for Prevention and
            Regulation of Dark Patterns, 2023.
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Certificate of self-audit
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Signed on {formatDate(audit.signedOn)}
              </p>
            </CardHeader>
            <CardContent className="prose prose-slate max-w-none">
              <div className="bg-muted p-4 rounded-lg not-prose space-y-1.5 text-sm">
                <p>
                  <strong>Entity:</strong> {COMPANY_INFO.name} (CIN{" "}
                  {COMPANY_INFO.cin})
                </p>
                <p>
                  <strong>Registered Office:</strong>{" "}
                  {COMPANY_INFO.registeredAddress}
                </p>
                <p>
                  <strong>Audit date:</strong> {formatDate(audit.signedOn)}
                </p>
                {period ? (
                  <p>
                    <strong>Audit period:</strong> {period}
                  </p>
                ) : null}
                {audit.nextDueOn ? (
                  <p>
                    <strong>Next audit due:</strong>{" "}
                    {formatDate(audit.nextDueOn)}
                  </p>
                ) : null}
              </div>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                What was audited
              </h2>
              <p>
                Every flow where a buyer sees a price, chooses, pays, cancels or
                is contacted: browsing and search, program and expert pages,
                checkout and payment, invoices, cancellation and refunds,
                sign-up consent, emails and notifications, and file uploads.
                Each flow was checked against all 13 dark patterns named in the
                2023 Guidelines, and also for an all-in price from listing to
                invoice, ranking disclosure, the seller&apos;s name on the
                invoice and a copy of the complaint to the person who filed it.
              </p>

              <h2 className="text-2xl font-semibold mt-6 mb-4">How</h2>
              <p>
                An internal review of the code behind each flow and a walk
                through each flow in a browser. The Rules prescribe no method,
                so this is our own. The payment form itself is run by our
                payment provider and was reviewed only as a buyer sees it.
              </p>

              <h2 className="text-2xl font-semibold mt-6 mb-4">Outcome</h2>
              <p>{audit.outcomeSummary.trim() || DEFAULT_OUTCOME}</p>

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                What this does not cover
              </h2>
              <p>
                This certificate covers what is described above and nothing
                more. It is a self-audit, not an approval by any authority.
              </p>

              <Separator className="my-6" />

              <div className="bg-muted p-4 rounded-lg not-prose space-y-1.5 text-sm">
                <p>
                  <strong>Signed by:</strong> {audit.signatoryName}
                  {audit.signatoryDesignation
                    ? `, ${audit.signatoryDesignation}`
                    : ""}
                </p>
                <p>
                  <strong>For:</strong> {COMPANY_INFO.name}
                </p>
              </div>

              <p className="mt-6">
                See how we order experts and programs in{" "}
                <Link
                  href="/how-we-rank"
                  className="underline underline-offset-4"
                >
                  How We Rank Experts &amp; Programs
                </Link>
                . To raise a concern about anything on this site, use our{" "}
                <Link
                  href="/grievance"
                  className="underline underline-offset-4"
                >
                  grievance contact
                </Link>
                .
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
