import { Suspense } from "react";
import Link from "next/link";
import { PlayCircle, Clock } from "lucide-react";
import { listPublicRecordings } from "@/lib/data/recordings-explore";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import { formatCurrencyAmount } from "@/utils/formatting";

// ISR — same rationale as /explore/experts: anonymous, session-free listing;
// prerendered HTML off the CDN. Publish/unpublish purge on demand at the
// write sites (see publish route follow-up).
export const revalidate = 300;

export const metadata = {
  title: "Recordings Library | Familiarise",
  description:
    "Buy recorded webinars and classes from verified consultants — learn on your schedule.",
};

function formatPrice(paise: number): string {
  return formatCurrencyAmount(paise, "INR");
}

async function RecordingsGrid() {
  // Deliberately LOUD: __tests__/explore/isr-routes-never-fail-open.test.ts
  // enforces that ISR listings never mask data-layer failures.
  const { items } = await withBuildTimeRetry(() =>
    listPublicRecordings({ perPage: 48 }),
  );

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card py-24 text-center text-muted-foreground">
        <PlayCircle className="mx-auto mb-4 h-12 w-12 opacity-40" />
        <p className="text-lg font-medium text-foreground">
          No published recordings yet
        </p>
        <p className="mt-1 text-sm">
          Consultants can publish webinar and class replays from their dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((rec) => (
        <Link
          key={rec.id}
          href={
            rec.slug
              ? `/explore/recordings/${rec.slug}`
              : `/explore/recordings`
          }
          className="group rounded-2xl border border-border bg-card overflow-hidden hover:border-foreground/20 hover:shadow-md transition-all"
        >
          <div className="aspect-video relative bg-muted overflow-hidden">
            {rec.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={rec.thumbnailUrl}
                alt={rec.listingTitle}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <PlayCircle className="h-10 w-10 text-muted-foreground/50" />
              </div>
            )}
            <span className="absolute bottom-2.5 right-2.5 rounded-md bg-zinc-950/80 backdrop-blur-sm px-2 py-0.5 text-xs font-medium text-white flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {rec.durationInMinutes}m
            </span>
          </div>
          <div className="p-5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {rec.planType}
              </span>
              <span className="font-bold text-foreground">
                {formatPrice(rec.listPricePaise)}
              </span>
            </div>
            <h3 className="line-clamp-2 text-base font-semibold text-foreground group-hover:text-primary transition-colors">
              {rec.listingTitle}
            </h3>
            <p className="text-xs text-muted-foreground truncate">
              {rec.consultant.name}
              {rec.consultant.headline ? ` · ${rec.consultant.headline}` : ""}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}

export default function ExploreRecordingsPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Cohesive Dark Editorial Hero Header */}
      <header className="bg-zinc-950 text-white border-b border-zinc-800">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-8 lg:px-12 py-12 md:py-16">
          <div className="max-w-2xl space-y-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
              On-Demand Learning
            </p>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">
              Recordings Library
            </h1>
            <p className="text-sm md:text-base text-zinc-400 leading-relaxed">
              Replays of paid webinars and classes, published by verified
              consultants. Buy once, watch anytime on your schedule.
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 sm:px-8 lg:px-12 py-10">
        <Suspense
          fallback={
            <div className="py-24 text-center text-muted-foreground">
              Loading recordings…
            </div>
          }
        >
          <RecordingsGrid />
        </Suspense>
      </main>
    </div>
  );
}
