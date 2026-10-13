import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ShieldAlert } from "lucide-react";
import {
  ANTI_SCAM_NOTICE,
  COMPANY_INFO,
  GRIEVANCE_OFFICER,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";

export const metadata = {
  title: `Grievance Redressal | ${COMPANY_INFO.name}`,
  description:
    "Designated Grievance Officer details, Indian statutory acknowledgement and resolution timelines, and external appellate routes.",
};

export default function GrievanceRedressalPage() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <ShieldAlert className="h-16 w-16 text-foreground" />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            Grievance Redressal
          </h1>
          <p className="text-muted-foreground max-w-3xl mx-auto">
            Published in accordance with the Information Technology
            (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021,
            the Consumer Protection (E-Commerce) Rules, 2020, and the Digital
            Personal Data Protection Act, 2023.
          </p>
        </div>

        <div className="max-w-3xl mx-auto space-y-6">
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Designated Grievance Redressal Officer
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Last Updated: {POLICY_DATES.grievanceLastUpdated}
              </p>
            </CardHeader>
            <CardContent className="prose prose-slate max-w-none">
              <div className="bg-muted p-4 rounded-lg not-prose space-y-1.5 text-sm">
                <p>
                  <strong>Officer:</strong> {GRIEVANCE_OFFICER.name}
                </p>
                <p>
                  <strong>Designation:</strong> {GRIEVANCE_OFFICER.designation}
                </p>
                <p>
                  <strong>Email:</strong>{" "}
                  <a
                    href={getMailtoLink(GRIEVANCE_OFFICER.email)}
                    className="font-medium underline underline-offset-4"
                  >
                    {GRIEVANCE_OFFICER.email}
                  </a>
                </p>
                {GRIEVANCE_OFFICER.phone ? (
                  <p>
                    <strong>Phone:</strong> {GRIEVANCE_OFFICER.phone}
                  </p>
                ) : null}
                <p>
                  <strong>Jurisdiction:</strong> {COMPANY_INFO.jurisdiction}
                </p>
                <p>
                  <strong>Acknowledgement SLA:</strong>{" "}
                  {GRIEVANCE_OFFICER.ackPromise}
                </p>
                <p>
                  <strong>Resolution SLA:</strong>{" "}
                  {GRIEVANCE_OFFICER.resolutionPromise}
                </p>
              </div>

              <div className="not-prose mt-6 flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="/dashboard/go?to=support">
                    File Grievance in Dashboard
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/contactus?category=grievance">
                    File via Public Grievance Form
                  </Link>
                </Button>
              </div>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                1. Statutory Timelines &amp; Ticket Tracking
              </h2>
              <p>
                Every support request and formal complaint opened on{" "}
                {COMPANY_INFO.name} receives a unique tracking reference {"("}
                <code>FAM-YYYY-NNNNNN</code> for support tickets and{" "}
                <code>RPT-XXXXXXXX</code> for content/review moderation
                {" reports)"} so you can monitor progress end to end.
              </p>
              <ul>
                <li>
                  <strong>
                    Information Technology (Intermediary Guidelines) Rules, 2021
                    — Rule 3(2):
                  </strong>{" "}
                  Complaints are acknowledged{" "}
                  <strong>{GRIEVANCE_OFFICER.ackPromise}</strong> and resolved{" "}
                  <strong>{GRIEVANCE_OFFICER.resolutionPromise}</strong> from
                  receipt.
                </li>
                <li>
                  <strong>
                    Consumer Protection (E-Commerce) Rules, 2020 — Rule
                    4(4)–4(5):
                  </strong>{" "}
                  Statutory ceiling is acknowledgement within 48 hours and
                  redressal within 1 month with a trackable ticket handle;{" "}
                  {COMPANY_INFO.name} applies our stricter acknowledgement{" "}
                  <strong>({GRIEVANCE_OFFICER.ackPromise})</strong> and
                  resolution{" "}
                  <strong>({GRIEVANCE_OFFICER.resolutionPromise})</strong>{" "}
                  standard across all consumer grievances.
                </li>
                <li>
                  <strong>
                    Digital Personal Data Protection Act, 2023 — Section 13:
                  </strong>{" "}
                  Personal data access, correction, consent withdrawal, and
                  erasure requests are handled through the Grievance Officer
                  under the same tracking framework.
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                2. External Appellate &amp; Statutory Forums
              </h2>
              <ul>
                <li>
                  <strong>
                    Grievance Appellate Committee (IT Rules Rule 3A):
                  </strong>{" "}
                  If you are aggrieved by a decision of the Grievance Officer or
                  do not receive a timely resolution, you may prefer an appeal
                  within <strong>30 days</strong> on the official portal:{" "}
                  <a
                    href="https://gac.gov.in"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    https://gac.gov.in
                  </a>
                  {"."}
                </li>
                <li>
                  <strong>National Consumer Helpline (CCPA):</strong> Consumer
                  protection complaints may also be registered at{" "}
                  <a
                    href="https://consumerhelpline.gov.in"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    https://consumerhelpline.gov.in
                  </a>
                  {"."}
                </li>
                <li>
                  <strong>Data Protection Board of India:</strong> Unresolved
                  data protection complaints may be referred to the Data
                  Protection Board of India under Section 13(3) of the DPDP Act,
                  2023.
                </li>
              </ul>

              <Separator className="my-6" />

              <p className="text-sm text-muted-foreground">
                {ANTI_SCAM_NOTICE}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
