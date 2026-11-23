import { ArrowUpRight, ChevronRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { domainPath } from "@/lib/explore/domain-slug";
import { cn } from "@/utils/tailwind";
import { FIELD_GROUPS, GOAL_LINKS, type FieldGroup } from "./fields";

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
        "relative isolate flex min-h-[22rem] flex-col justify-between overflow-hidden rounded-3xl bg-zinc-900 p-7 text-white md:p-9",
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
