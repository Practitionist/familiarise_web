import {
  ArrowUpRight,
  CalendarDays,
  ChevronRight,
  CircleCheck,
  MessageSquareText,
  Video,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { domainPath } from "@/lib/explore/domain-slug";
import { cn } from "@/utils/tailwind";
import {
  FIELD_GROUPS,
  GOAL_LINKS,
  type FieldGroup,
  type FieldMockup,
} from "./fields";

const SPAN_CLASSES: Record<number, string> = {
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  5: "lg:col-span-5",
};

/** Wide-narrow, then narrow-wide, on five columns; the last tile stretches to close an unfinished row. */
function tileSpans(count: number): number[] {
  const spans = Array.from({ length: count }, (_, i) =>
    i % 4 === 0 || i % 4 === 3 ? 3 : 2,
  );
  const remainder = spans.reduce((sum, span) => sum + span, 0) % 5;
  if (remainder > 0) spans[count - 1] += 5 - remainder;
  return spans;
}

function expertCount(count: number): string {
  return count === 1 ? "1 expert" : `${count} experts`;
}

const MOCKUP_CARD =
  "rounded-2xl bg-white/90 p-4 shadow-elevation-2 backdrop-blur";

/** Decorative product snippets; they illustrate the kind of session, not real bookings. */
function Mockup({ kind }: Readonly<{ kind: FieldMockup }>) {
  switch (kind) {
    case "live":
      return (
        <div className="flex items-center gap-3 rounded-2xl bg-zinc-950 px-4 py-3 text-white shadow-elevation-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-red-500" />
          </span>
          <div>
            <p className="text-xs text-zinc-400">Live now</p>
            <p className="text-sm font-medium">System design review</p>
          </div>
          <Video className="ml-2 h-4 w-4 text-zinc-400" />
        </div>
      );
    case "slots":
      return (
        <div className={cn(MOCKUP_CARD, "w-full max-w-xs")}>
          <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
            <CalendarDays className="h-4 w-4" />
            Book a 1:1 session
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs font-medium">
            <span className="rounded-lg border border-zinc-200 py-2 text-zinc-700">
              4:00 PM
            </span>
            <span className="rounded-lg bg-zinc-950 py-2 text-white">
              5:30 PM
            </span>
            <span className="rounded-lg border border-zinc-200 py-2 text-zinc-700">
              7:00 PM
            </span>
          </div>
          <p className="mt-3 rounded-lg bg-emerald-600 py-2 text-center text-xs font-semibold text-white">
            Confirm booking
          </p>
        </div>
      );
    case "review":
      return (
        <div className={cn(MOCKUP_CARD, "w-full max-w-xs")}>
          <div className="h-16 rounded-xl bg-gradient-to-br from-rose-300 via-orange-200 to-amber-100" />
          <div className="mt-3 flex items-start gap-2">
            <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
            <p className="text-xs text-zinc-700">
              Strong palette. Give the cards more breathing room.
            </p>
          </div>
        </div>
      );
    case "progress":
      return (
        <div className={cn(MOCKUP_CARD, "w-60")}>
          <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
            <CircleCheck className="h-4 w-4 text-lime-600" />
            This month&apos;s plan
          </p>
          <div className="mt-3 h-2 rounded-full bg-zinc-100">
            <div className="h-2 w-3/4 rounded-full bg-lime-500" />
          </div>
          <p className="mt-2 text-xs text-zinc-500">3 of 4 sessions done</p>
        </div>
      );
  }
}

function GroupTile({
  group,
  domains,
  span,
}: Readonly<{
  group: FieldGroup;
  domains: { name: string; count: number }[];
  span: number;
}>) {
  const wide = span > 2;
  return (
    <article
      className={cn(
        "relative isolate flex min-h-[26rem] flex-col justify-between overflow-hidden rounded-3xl bg-zinc-900 p-7 text-white md:p-9",
        SPAN_CLASSES[span],
      )}
    >
      <Image
        src={group.photo.src}
        alt=""
        fill
        sizes={
          wide
            ? "(min-width: 1024px) 60vw, 100vw"
            : "(min-width: 1024px) 40vw, 100vw"
        }
        className="-z-10 object-cover"
      />
      {/* Darkest behind the text: from the left on wide tiles, from the top on narrow ones. */}
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0 -z-10",
          wide
            ? "bg-gradient-to-r from-black/85 via-black/55 to-black/15"
            : "bg-gradient-to-b from-black/85 via-black/50 to-black/25",
        )}
      />

      <div className={cn(wide && "lg:max-w-[55%]")}>
        <h3 className="text-2xl font-semibold tracking-tight md:text-3xl">
          {group.title}
        </h3>
        <p className="mt-3 text-base leading-relaxed text-zinc-200">
          {group.benefit}
        </p>
        <ul className="mt-5 flex flex-wrap gap-x-6 gap-y-2">
          {domains.map(({ name, count }) => (
            <li key={name}>
              <Link
                href={domainPath(name)}
                className="group inline-flex items-center gap-1.5 text-sm font-medium underline decoration-white/40 underline-offset-4 transition-colors hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                {name}
                <span className="text-zinc-300">· {expertCount(count)}</span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                />
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div aria-hidden="true" className="mt-8 flex justify-end">
        <Mockup kind={group.mockup} />
      </div>
    </article>
  );
}

export function CategoriesSection({
  consultantsByDomain,
}: Readonly<{
  /** Verified consultant counts keyed by lowercased domain name. */
  consultantsByDomain: Record<string, number>;
}>) {
  // A tile shows while any of its domains has verified experts, and lists only those domains.
  const groups = FIELD_GROUPS.map((group) => ({
    group,
    domains: group.domains
      .map((name) => ({
        name,
        count: consultantsByDomain[name.toLowerCase()] ?? 0,
      }))
      .filter(({ count }) => count > 0),
  })).filter(({ domains }) => domains.length > 0);
  const spans = tileSpans(groups.length);

  return (
    <section className="py-20 md:py-32 bg-gradient-to-b from-white to-zinc-50 relative overflow-hidden">
      <div className="absolute inset-0 grid-pattern-dark opacity-30" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <div className="text-center mb-12">
          <Badge
            variant="secondary"
            className="mb-4 bg-secondary text-secondary-foreground hover:bg-secondary border-0"
          >
            Categories
          </Badge>
          <h2 className="text-fluid-4xl font-bold text-foreground mb-4 tracking-tight">
            Browse by <span className="text-muted-foreground">expertise</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Find experts in your field and start learning from the best
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          {groups.map(({ group, domains }, index) => (
            <GroupTile
              key={group.title}
              group={group}
              domains={domains}
              span={spans[index]}
            />
          ))}
        </div>

        <div className="mt-10 flex flex-col items-center gap-4">
          <p className="text-sm font-medium text-muted-foreground">
            Or start from a goal
          </p>
          <ul className="flex flex-wrap justify-center gap-2">
            {GOAL_LINKS.map(({ label, href, icon: Icon }) => (
              <li key={label}>
                <Link
                  href={href}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-muted"
                >
                  <Icon aria-hidden="true" className="h-4 w-4" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="text-center mt-10">
          <Button
            variant="outline"
            size="lg"
            className="border-border hover:bg-muted"
            asChild
          >
            <Link href="/explore/experts">
              View all experts
              <ChevronRight aria-hidden="true" className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
