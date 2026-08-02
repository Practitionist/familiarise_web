import { Skeleton } from "@/components/ui/skeleton";

/** Landing first-viewport: dark hero matching HeroSection. */
export function LandingHeroSkeleton() {
  return (
    <main className="flex-1 w-full min-h-screen overflow-hidden bg-black">
      <section className="relative flex min-h-[95vh] items-center overflow-hidden">
        <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(to_right,rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:48px_48px]" />
        <div className="container relative z-10 mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-4xl space-y-6 text-center">
            <Skeleton className="mx-auto h-7 w-36 rounded-full bg-zinc-800" />
            <Skeleton className="mx-auto h-14 w-full max-w-2xl bg-zinc-800 sm:h-16" />
            <Skeleton className="mx-auto h-5 w-full max-w-xl bg-zinc-800" />
            <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
              <Skeleton className="h-12 w-40 rounded-xl bg-zinc-800" />
              <Skeleton className="h-12 w-40 rounded-xl bg-zinc-800" />
            </div>
            <div className="mx-auto grid max-w-2xl grid-cols-2 gap-4 pt-8 md:grid-cols-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="mx-auto h-8 w-16 bg-zinc-800" />
                  <Skeleton className="mx-auto h-3 w-20 bg-zinc-800" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

/** Marketing / use-case pages: hero + section spine (not a card grid). */
export function MarketingPageSkeleton() {
  return (
    <main className="min-h-screen bg-background">
      <section className="relative overflow-hidden bg-zinc-950 px-4 pb-16 pt-28 md:px-6 md:pb-24 md:pt-32">
        <div className="mx-auto max-w-4xl space-y-5 text-center">
          <Skeleton className="mx-auto h-6 w-28 rounded-full bg-zinc-800" />
          <Skeleton className="mx-auto h-12 w-full max-w-2xl bg-zinc-800" />
          <Skeleton className="mx-auto h-5 w-full max-w-xl bg-zinc-800" />
          <div className="flex justify-center gap-3 pt-2">
            <Skeleton className="h-11 w-36 rounded-xl bg-zinc-800" />
            <Skeleton className="h-11 w-36 rounded-xl bg-zinc-800" />
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-5xl space-y-10 px-4 py-16 md:px-6">
        <div className="space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-full max-w-2xl" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-56 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      </section>
    </main>
  );
}

/** Explore programs list: dark hero + tabs/filters + carousel rows. */
export function ProgramsExploreSkeleton() {
  return (
    <main className="min-h-screen bg-background">
      <section className="relative bg-zinc-950 px-4 pb-20 pt-32 md:px-8 lg:px-12">
        <div className="mx-auto max-w-[1600px] space-y-6">
          <Skeleton className="h-6 w-28 rounded-full bg-zinc-800" />
          <Skeleton className="h-12 w-full max-w-xl bg-zinc-800" />
          <Skeleton className="h-5 w-full max-w-lg bg-zinc-800" />
          <div className="grid max-w-xl grid-cols-2 gap-4 pt-4 sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-8 w-14 bg-zinc-800" />
                <Skeleton className="h-3 w-20 bg-zinc-800" />
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1600px] space-y-8 px-4 py-10 md:px-8 md:py-16 lg:px-12">
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-28 rounded-full" />
          ))}
        </div>
        <div className="space-y-3">
          <Skeleton className="h-6 w-40" />
          <div className="flex gap-4 overflow-hidden">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton
                key={i}
                className="h-48 w-[280px] shrink-0 rounded-xl"
              />
            ))}
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-6 w-36" />
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-9 w-24 rounded-full" />
            ))}
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <Skeleton key={i} className="h-56 rounded-xl" />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

/** Explore plan detail: image hero + 2/1 content + sticky sidebar. */
export function PlanDetailSkeleton() {
  return (
    <main className="min-h-screen bg-muted">
      <div className="relative h-[350px] w-full overflow-hidden bg-zinc-900 md:h-[400px]">
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 space-y-3 p-6 md:p-10">
          <Skeleton className="h-6 w-24 rounded-full bg-zinc-700" />
          <Skeleton className="h-10 w-full max-w-xl bg-zinc-700" />
          <Skeleton className="h-4 w-64 bg-zinc-700" />
        </div>
      </div>
      <div className="mx-auto grid max-w-[92%] gap-8 py-8 lg:grid-cols-3 lg:py-12">
        <div className="space-y-6 lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-8 w-48" />
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
        <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    </main>
  );
}

/** Explore organisations directory: dark hero + filter/grid shell. */
export function OrganisationsExploreSkeleton() {
  return (
    <main className="min-h-screen bg-background">
      <section className="bg-zinc-950 px-4 pb-16 pt-32 md:px-6">
        <div className="mx-auto max-w-[1400px] space-y-5">
          <Skeleton className="h-6 w-28 rounded-full bg-zinc-800" />
          <Skeleton className="h-12 w-full max-w-lg bg-zinc-800" />
          <Skeleton className="h-5 w-full max-w-md bg-zinc-800" />
        </div>
      </section>
      <section className="mx-auto max-w-[1400px] px-4 py-10 md:px-6">
        <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
          <div className="hidden space-y-4 lg:block">
            <Skeleton className="h-10 w-full" />
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <Skeleton key={i} className="h-52 rounded-xl" />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

/** Checkout two-column plan layout (fills plans/layout grid). */
export function CheckoutPlanSkeleton() {
  return (
    <>
      <div className="flex flex-col gap-6 border-r border-border bg-gradient-to-br from-muted via-background to-muted p-6 sm:p-8">
        <div className="flex items-center gap-4">
          <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-8 bg-card p-6 sm:p-8">
        <Skeleton className="h-48 rounded-xl" />
        <div className="space-y-4">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      </div>
    </>
  );
}

/** Checkout success/failure centered card. */
export function CheckoutResultSkeleton() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-6">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-8">
        <Skeleton className="mx-auto h-16 w-16 rounded-full" />
        <Skeleton className="mx-auto h-7 w-48" />
        <Skeleton className="mx-auto h-4 w-64" />
        <Skeleton className="mt-4 h-11 w-full rounded-xl" />
      </div>
    </main>
  );
}

/** Onboarding multi-step wizard shell. */
export function OnboardingWizardSkeleton() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-muted to-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card/80 backdrop-blur">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </header>
      <main className="container mx-auto max-w-3xl space-y-8 px-4 py-10">
        <div className="flex items-center justify-center gap-2 sm:gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-2 sm:gap-3">
              <Skeleton className="h-9 w-9 rounded-full sm:h-10 sm:w-10" />
              {i < 5 && <Skeleton className="hidden h-0.5 w-8 sm:block" />}
            </div>
          ))}
        </div>
        <div className="space-y-6 rounded-xl border border-border bg-card p-6 shadow-lg sm:p-8">
          <div className="space-y-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-11 w-full rounded-lg" />
              </div>
            ))}
          </div>
          <div className="flex justify-between pt-2">
            <Skeleton className="h-11 w-28 rounded-lg" />
            <Skeleton className="h-11 w-28 rounded-lg" />
          </div>
        </div>
      </main>
    </div>
  );
}

/** Meeting lobby / room chrome (setup preview + sidebar). */
export function MeetingRoomSkeleton() {
  return (
    <main className="relative min-h-screen bg-gradient-to-br from-zinc-900 via-zinc-950 to-black">
      <div className="mx-auto grid h-screen max-w-7xl gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:p-8">
        <div className="flex min-h-0 flex-col gap-4">
          <Skeleton className="aspect-video w-full rounded-2xl bg-zinc-800" />
          <div className="flex items-center justify-center gap-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton
                key={i}
                className="h-12 w-12 rounded-full bg-zinc-800"
              />
            ))}
          </div>
        </div>
        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-card/95 p-6">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <div className="space-y-3 pt-4">
            <Skeleton className="h-11 w-full rounded-lg" />
            <Skeleton className="h-11 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Week heatmap / slot calendar grid.
 * Matches UnifiedCalendar week layout: time gutter + 7 day columns.
 */
export function CalendarGridSkeleton({
  className,
}: Readonly<{ className?: string }>) {
  return (
    <div
      className={
        className
          ? `flex min-h-0 flex-1 flex-col gap-3 ${className}`
          : "flex min-h-0 flex-1 flex-col gap-3"
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-2">
          <Skeleton className="h-9 w-9" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-9" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
      <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] gap-px overflow-hidden rounded-xl border border-border bg-border">
        <div className="bg-card p-2" />
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={`h-${i}`} className="bg-card p-2 text-center">
            <Skeleton className="mx-auto h-3 w-8" />
            <Skeleton className="mx-auto mt-1 h-5 w-6" />
          </div>
        ))}
        {Array.from({ length: 8 }).map((_, row) => (
          <div key={`row-${row}`} className="contents">
            <div className="bg-card p-1">
              <Skeleton className="mx-auto h-3 w-8" />
            </div>
            {Array.from({ length: 7 }).map((_, col) => (
              <div key={`c-${row}-${col}`} className="min-h-12 bg-card p-1">
                <Skeleton className="h-full min-h-10 w-full rounded-md" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Allocate / reschedule / timings page: header + calendar + footer. */
export function HeatmapSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
      <div className="flex shrink-0 items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-4 w-full max-w-xl" />
      <CalendarGridSkeleton />
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-4">
        <Skeleton className="h-10 w-28" />
        <Skeleton className="h-10 w-36" />
        <Skeleton className="h-10 w-28" />
      </div>
    </div>
  );
}

/** Appointment detail: banner + content columns. */
export function AppointmentDetailSkeleton() {
  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div className="space-y-3 rounded-xl border border-border bg-card p-6">
        <Skeleton className="h-6 w-32 rounded-full" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <div className="flex flex-wrap gap-2 pt-2">
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-28" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <div className="space-y-4">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/** Admin analytics: 4 stat cards + chart panels. */
export function AnalyticsSkeleton() {
  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="space-y-3 rounded-xl border border-border bg-card p-5"
          >
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
