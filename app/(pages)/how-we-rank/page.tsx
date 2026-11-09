import type { Metadata } from "next";
import Link from "next/link";
import { ListOrdered } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { COMPANY_INFO } from "@/lib/company";
import { MIN_RATED_CLIENTS_ONE_TO_ONE } from "@/lib/reviews";
import { POLICY_DATES } from "../constants";

export const metadata: Metadata = {
  title: `How We Rank Experts & Programs | ${COMPANY_INFO.name}`,
  description:
    "The plain-language parameters behind every sort and ranked row on Familiarise, in order of importance, and our commitment that placement is never paid for.",
};

export default function HowWeRankPage() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <ListOrdered className="h-16 w-16 text-foreground" />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            How We Rank Experts &amp; Programs
          </h1>
          <p className="text-muted-foreground max-w-3xl mx-auto">
            What decides the order you see when you sort or browse on{" "}
            {COMPANY_INFO.name}, listed from the most important parameter to the
            least.
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Our ranking parameters
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Last Updated: {POLICY_DATES.howWeRankLastUpdated}
              </p>
            </CardHeader>
            <CardContent className="prose prose-slate max-w-none">
              <h2 className="text-2xl font-semibold mt-6 mb-4">
                1. No paid placement
              </h2>
              <p>
                We do not accept payment for placement. No expert or program can
                buy a higher position, a badge or a place in a highlighted row.
                If we ever show a paid placement, it will be labelled{" "}
                <strong>Sponsored</strong>.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                2. Who is listed
              </h2>
              <ul>
                <li>
                  <strong>Experts:</strong> only experts whose identity and
                  credentials we have verified, and whose profile has not been
                  removed.
                </li>
                <li>
                  <strong>Programs:</strong> only classes and webinars that are
                  open to everyone on the marketplace and have not been
                  withdrawn from sale, hosted by an expert whose profile has not
                  been removed. Programs offered only inside one organisation
                  are never listed.
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">3. Experts</h2>
              <p>
                Each sort below orders experts by its first parameter. The
                second parameter only decides between experts who are level on
                the first.
              </p>
              <ul>
                <li>
                  <strong>Highest rated:</strong> (1) the expert&apos;s
                  published one-to-one rating, highest first, which is the same
                  score shown on their card. That score is the plain average of
                  their clients&apos; ratings, and it is published only once at
                  least {MIN_RATED_CLIENTS_ONE_TO_ONE} one-to-one clients have
                  rated them. Experts without a published rating yet come last.
                </li>
                <li>
                  <strong>Recently reviewed:</strong> (1) the time of the
                  expert&apos;s most recent review activity, newest first;
                  experts who have never been reviewed come last. (2) The number
                  of one-to-one clients who have rated them.
                </li>
                <li>
                  <strong>Most reviews:</strong> (1) the number of one-to-one
                  clients who have rated the expert, which is the count shown on
                  their card. (2) The number of group events they have been
                  rated for.
                </li>
                <li>
                  <strong>Newest:</strong> (1) the date the expert&apos;s
                  profile was created, newest first.
                </li>
                <li>
                  <strong>Name (A-Z or Z-A):</strong> (1) the expert&apos;s
                  name. This is the order you see when you have not chosen a
                  sort.
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">4. Programs</h2>
              <ul>
                <li>
                  <strong>Most booked:</strong> (1) how many sessions were
                  scheduled for the program in the last 30 days, highest first.
                  This counts sessions scheduled, not seats sold. (2) Programs
                  with the same count are placed in a fixed order so the list
                  does not shuffle between visits. Programs with no recent
                  sessions stay in the list, after the others.
                </li>
                <li>
                  <strong>Newest:</strong> (1) the date the program was created,
                  newest first.
                </li>
                <li>
                  <strong>Price or title:</strong> (1) the price, lowest or
                  highest first, or the title, A to Z or Z to A. These sorts use
                  nothing else.
                </li>
                <li>
                  <strong>No sort chosen:</strong> programs are not ranked.
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                5. Highlighted rows
              </h2>
              <p>
                The rows on the Explore pages, such as top-rated experts, newly
                joined experts or the most booked programs, use exactly the
                orders above. A row&apos;s name tells you which order it uses,
                and none of them is placed by payment.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                6. Questions and reviews
              </h2>
              <p>
                How ratings are collected and moderated is explained in{" "}
                <Link
                  href="/reviews-policy"
                  className="underline underline-offset-4"
                >
                  How Reviews &amp; Ratings Work
                </Link>
                . If you think a ranking is wrong, tell us through the{" "}
                <Link
                  href="/grievance"
                  className="underline underline-offset-4"
                >
                  grievance process
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
