import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Scale } from "lucide-react";
import { COMPANY_INFO, POLICY_DATES } from "../constants";

export const metadata = {
  title: `How Reviews & Ratings Work | ${COMPANY_INFO.name}`,
  description:
    "Transparency policy covering verified session reviews, BIS IS 19000:2022 standards, rating tracks, human moderation, and appeals.",
};

export default function ReviewsPolicyPage() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <Scale className="h-16 w-16 text-foreground" />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            How Reviews &amp; Ratings Work
          </h1>
          <p className="text-muted-foreground max-w-3xl mx-auto">
            Our commitments under BIS IS 19000:2022 (Online Consumer Reviews —
            Principles and Requirements for their Collection, Moderation and
            Publication).
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Review Collection, Rating &amp; Moderation Policy
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Last Updated: {POLICY_DATES.reviewsPolicyLastUpdated}
              </p>
            </CardHeader>
            <CardContent className="prose prose-slate max-w-none">
              <h2 className="text-2xl font-semibold mt-6 mb-4">
                1. Review Eligibility &amp; Authentic Experience
              </h2>
              <p>
                Only authenticated users who completed a paid booking on{" "}
                {COMPANY_INFO.name} may publish a public review or submit
                session quality feedback. Unbooked visitors, cancelled
                appointments, and unpaid sessions cannot post public reviews,
                and collaborators or host team members cannot review their own
                sessions.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                2. BIS IS 19000:2022 Principles
              </h2>
              <ul>
                <li>
                  <strong>Integrity &amp; Equal Treatment:</strong> Positive and
                  negative reviews undergo identical verification and
                  publication rules. A low star rating is never suppressed,
                  delayed, or treated differently from a high rating.
                </li>
                <li>
                  <strong>No Arbitrary Editing:</strong> {COMPANY_INFO.name}{" "}
                  never edits star scores or rewrites review prose submitted by
                  an attendee.
                </li>
                <li>
                  <strong>Author Withdrawal:</strong> Reviewers may edit or
                  withdraw their own published review from their dashboard.
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                3. Two-Track Rating Aggregation
              </h2>
              <p>
                Ratings are aggregated separately across two experience tracks
                so one format never distorts the other:
              </p>
              <ul>
                <li>
                  <strong>
                    1:1 Consultations &amp; Subscriptions (`ONE_TO_ONE`):
                  </strong>{" "}
                  Reflects individual advisory and mentoring bookings.
                </li>
                <li>
                  <strong>Group Programs (`GROUP`):</strong> Reflects
                  interactive cohorts and live webinars.
                </li>
              </ul>
              <p>
                Every displayed average score is always accompanied by the
                number of verified ratings included in that track.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                4. Moderation Grounds &amp; Human Review Only
              </h2>
              <p>
                Reviewed experts and active host-organization administrators may
                flag a review under one of five policy grounds:
              </p>
              <ul>
                <li>
                  <strong>Coercion, extortion, or retaliatory pressure:</strong>{" "}
                  Reviews tied to demands for outside-policy concessions, refund
                  threats, or harassment prioritized at the top of our queue.
                </li>
                <li>
                  <strong>Spam or unverified claim:</strong> Promotional links,
                  fabricated factual claims contradicted by platform session
                  records, or duplicate spam.
                </li>
                <li>
                  <strong>Harassment or abusive language:</strong> Hate speech,
                  threats, personal attacks, or disclosure of private personal
                  data.
                </li>
                <li>
                  <strong>Irrelevant or off-topic:</strong> Content unrelated to
                  the booked engagement or platform experience.
                </li>
                <li>
                  <strong>Other policy concern:</strong> Any other breach of
                  community safety guidelines.
                </li>
              </ul>
              <p>
                <strong>Human Review Guarantee:</strong> Every moderation report
                is evaluated by a trained human moderator. No automated
                algorithm or AI filter ever removes or suppresses a public
                review.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                5. &ldquo;Not Counted in Rating&rdquo; Exclusions &amp; Appeals
              </h2>
              <p>
                When session records show an anomaly (such as an unresolved
                platform outage or verified retaliatory timing) that warrants
                excluding a score from aggregate averages without erasing
                good-faith text, a human moderator may mark a review{" "}
                <strong>Not counted in rating</strong>. Both parties receive a
                written statement of reasons naming the policy ground,
                confirming human review, and providing a report reference code (
                <code>RPT-XXXXXXXX</code>).
              </p>
              <p>
                If you disagree with any moderation decision, open a request
                from <Link href="/support">Support</Link> or our{" "}
                <Link href="/grievance">Grievance Redressal</Link> page and
                quote your <code>RPT-XXXXXXXX</code> reference number for
                independent reconsideration.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
