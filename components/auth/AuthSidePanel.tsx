import Link from "next/link";
import { BadgeCheck, Lock, Star, Zap, type LucideIcon } from "lucide-react";

import { GlobeIcon } from "@/components/auth/auth-icons";
import { getFeaturedReviews } from "@/lib/data/home";

const FEATURES: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: Zap,
    title: "Learn live",
    description:
      "Classes, webinars and private sessions where you ask questions and get answers in real time.",
  },
  {
    icon: BadgeCheck,
    title: "Vetted experts",
    description:
      "Every expert is vetted before they can take bookings, and their employer is confirmed by work email or LinkedIn.",
  },
  {
    icon: Lock,
    title: "Secure payments and recordings",
    description:
      "Checkout through Razorpay with refunds built in, and replays of sessions that were recorded.",
  },
];

const HEADLINES = {
  signin: {
    title: "Welcome back.",
    subtitle: "Pick up where you left off with your experts and sessions.",
  },
  signup: {
    title: "Learn live from people who do the work.",
    subtitle: "Free to join. Pay only for the sessions you book.",
  },
} as const;

type PanelReview = {
  text: string;
  rating: number;
  author: string;
  expert: string | null;
  edited: boolean;
};

/** The top-rated public review with text, or null; never blocks the auth form. */
async function pickReview(): Promise<PanelReview | null> {
  let reviews: Awaited<ReturnType<typeof getFeaturedReviews>>;
  try {
    reviews = await getFeaturedReviews();
  } catch {
    return null;
  }
  const review = reviews.find((r) => r.reviewDescription?.trim());
  if (!review?.reviewDescription) return null;
  return {
    text: review.reviewDescription.trim(),
    rating: review.rating,
    author: review.consulteeProfile?.user?.name || "A Familiarise learner",
    expert: review.consultantProfile?.user?.name ?? null,
    edited: Boolean(review.editedAt),
  };
}

export async function AuthSidePanel({
  variant,
}: Readonly<{ variant: keyof typeof HEADLINES }>) {
  const headline = HEADLINES[variant];
  const review = await pickReview();

  return (
    <div className="hidden flex-col justify-between gap-10 bg-pearl p-6 text-black md:flex md:w-1/2 md:p-12">
      <Link href="/" className="flex items-center space-x-2">
        <GlobeIcon className="h-5 w-5 text-black md:h-6 md:w-6" />
        <span className="text-2xl font-semibold tracking-tight md:text-4xl">
          Familiarise
        </span>
      </Link>

      <div className="space-y-10">
        <div>
          <p className="text-fluid-3xl font-semibold tracking-tight">
            {headline.title}
          </p>
          <p className="mt-2 text-sm text-neutral-600 md:text-base">
            {headline.subtitle}
          </p>
        </div>
        <ul className="space-y-6">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <li key={title} className="flex gap-4">
              <Icon
                aria-hidden="true"
                className="mt-0.5 h-5 w-5 shrink-0 text-neutral-900"
              />
              <div>
                <p className="font-medium">{title}</p>
                <p className="mt-1 text-sm text-neutral-600">{description}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-black/10 pt-6">
        {review ? (
          <figure>
            <div
              className="flex gap-0.5"
              role="img"
              aria-label={`Rated ${review.rating} out of 5`}
            >
              {Array.from({ length: 5 }, (_, i) => (
                <Star
                  key={i}
                  aria-hidden="true"
                  className={
                    i < review.rating
                      ? "h-4 w-4 fill-amber-400 text-amber-400"
                      : "h-4 w-4 text-neutral-300"
                  }
                />
              ))}
            </div>
            <blockquote className="mt-3 line-clamp-4 text-sm leading-relaxed text-neutral-700">
              &ldquo;{review.text}&rdquo;
            </blockquote>
            <figcaption className="mt-3 text-xs text-neutral-600">
              <span className="font-medium text-neutral-900">
                {review.author}
              </span>
              {review.expert ? ` · Session with ${review.expert}` : null}
              {review.edited ? " · Edited" : null}
            </figcaption>
          </figure>
        ) : (
          <p className="text-xs text-neutral-600 md:text-sm">
            Only people who booked a session that took place can review it.
          </p>
        )}
      </div>
    </div>
  );
}
