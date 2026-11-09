import { MESSAGE_REVIEW_ARTICLE_HREF } from "@/lib/compliance/purpose-codes";
import { LegalLink } from "./LegalLink";

const DETAILS = {
  consultee: "your learning preferences",
  consultant: "your professional profile",
} as const;

const PURPOSES = {
  consultee: [
    "run your account and sign you in",
    "book and manage your sessions",
    "run video calls and chat (via GetStream)",
    "take payments (via Razorpay)",
    "keep the platform secure",
  ],
  consultant: [
    "run your account and sign you in",
    "book and manage your sessions",
    "run video calls and chat (via GetStream)",
    "take payments and pay you out (via Razorpay)",
    "keep the platform secure",
  ],
} as const;

/** The plain-language notice shown before the sign-up consent checkboxes, for both onboarding paths. */
export function DataProtectionNotice({
  audience,
}: Readonly<{ audience: keyof typeof DETAILS }>) {
  return (
    <section
      aria-labelledby="data-protection-notice-heading"
      className="space-y-3 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
    >
      <h3
        id="data-protection-notice-heading"
        className="font-semibold text-foreground"
      >
        How we use your information
      </h3>
      <p>
        We collect your name, email, phone number, date of birth (to confirm
        you&apos;re 18 or older) and {DETAILS[audience]}, so we can:
      </p>
      <ul className="list-disc space-y-1 pl-5">
        {PURPOSES[audience].map((purpose) => (
          <li key={purpose}>{purpose}</li>
        ))}
      </ul>
      <p>
        Our error reports don&apos;t include your name, email or phone number.
      </p>
      <p>
        We automatically check chats for fraud, requests to pay outside
        Familiarise, shared contact details and safety issues. If a booking is
        reported, our support team may read its chat, and may join it visibly as
        &ldquo;Familiarise Support&rdquo;.{" "}
        <LegalLink href={MESSAGE_REVIEW_ARTICLE_HREF}>
          How we review messages
        </LegalLink>
      </p>
      <p>
        In <strong className="text-foreground">Settings &rarr; Account</strong>{" "}
        you can download your data, turn marketing emails on or off, delete your
        account (by law we must keep invoices and tax records for up to 8
        years), or raise a privacy complaint. If we don&apos;t resolve it, you
        can complain to the Data Protection Board of India.
      </p>
    </section>
  );
}
