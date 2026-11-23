import { ArrowUpRight, ChevronRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { domainPath } from "@/lib/explore/domain-slug";
import { cn } from "@/utils/tailwind";
import {
  FIELD_TILES,
  GOAL_LINKS,
  SUBTOPIC_TILES,
  type FieldTile,
  type SubtopicTile,
} from "./fields";

type FieldSize = "hero" | "wide" | "small";

// The first field fills a 2x2 cell, the next two a 2x1 cell each, and the rest one cell.
const FIELD_SIZE_CLASSES: Record<FieldSize, string> = {
  hero: "col-span-2 row-span-2 min-h-[22rem]",
  wide: "col-span-2",
  small: "col-span-1",
};

function fieldSize(index: number): FieldSize {
  if (index === 0) return "hero";
  return index < 3 ? "wide" : "small";
}

function expertCount(count: number): string {
  return count === 1 ? "1 expert" : `${count} experts`;
}

const DOT_GRID_STYLE = {
  backgroundImage:
    "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1.5px)",
  backgroundSize: "20px 20px",
  maskImage:
    "radial-gradient(ellipse 80% 80% at 100% 0%, #000 20%, transparent 70%)",
  WebkitMaskImage:
    "radial-gradient(ellipse 80% 80% at 100% 0%, #000 20%, transparent 70%)",
} as const;

function FieldCard({
  field,
  count,
  size,
}: Readonly<{ field: FieldTile; count: number; size: FieldSize }>) {
  const Icon = field.icon;
  const hero = size === "hero";
  return (
    <Link
      href={domainPath(field.domain)}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl bg-zinc-950 p-5 text-white transition-all duration-300 hover:-translate-y-1 hover:shadow-elevation-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:p-6",
        FIELD_SIZE_CLASSES[size],
      )}
    >
      {field.photo ? (
        <>
          <Image
            src={field.photo.src}
            alt={field.photo.alt}
            fill
            sizes={
              hero
                ? "(min-width: 1024px) 50vw, 100vw"
                : "(min-width: 1024px) 25vw, 50vw"
            }
            className="object-cover transition-transform duration-500 group-hover:scale-105"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/45 to-black/10"
          />
        </>
      ) : (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={DOT_GRID_STYLE}
        />
      )}
      <div className="relative flex items-start justify-between gap-4">
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-xl bg-white/10 backdrop-blur-sm",
            hero ? "h-12 w-12" : "h-10 w-10",
          )}
        >
          <Icon aria-hidden="true" className={hero ? "h-6 w-6" : "h-5 w-5"} />
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="h-5 w-5 shrink-0 text-zinc-300 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
        />
      </div>
      <div className="relative mt-auto pt-6">
        <h3
          className={cn(
            "font-semibold tracking-tight",
            hero ? "text-3xl" : size === "wide" ? "text-2xl" : "text-lg",
          )}
        >
          {field.label}
        </h3>
        <p
          className={cn(
            "mt-1 text-sm text-zinc-300",
            size === "small" && "line-clamp-1",
          )}
        >
          {field.subtopics.join(" · ")}
        </p>
        <p className="mt-3 text-sm font-medium">{expertCount(count)}</p>
      </div>
    </Link>
  );
}

function SubtopicCard({ subtopic }: Readonly<{ subtopic: SubtopicTile }>) {
  const Icon = subtopic.icon;
  return (
    <Link
      href={`/explore/experts?search=${encodeURIComponent(subtopic.search)}`}
      className="group col-span-1 flex flex-col justify-between rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-1 hover:border-foreground/30 hover:shadow-elevation-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white">
          <Icon aria-hidden="true" className="h-5 w-5" />
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
        />
      </div>
      <div className="pt-6">
        <h3 className="font-semibold tracking-tight text-foreground">
          {subtopic.label}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">Search experts</p>
      </div>
    </Link>
  );
}

export function CategoriesSection({
  consultantsByDomain,
}: Readonly<{
  /** Verified consultant counts keyed by lowercased domain name. */
  consultantsByDomain: Record<string, number>;
}>) {
  const countFor = (domain: string) =>
    consultantsByDomain[domain.toLowerCase()] ?? 0;
  // Demand order decides the sequence; a field or subtopic shows only while its field has verified experts.
  const fields = FIELD_TILES.map((field) => ({
    field,
    count: countFor(field.domain),
  })).filter(({ count }) => count > 0);
  const subtopics = SUBTOPIC_TILES.filter(
    (subtopic) => countFor(subtopic.domain) > 0,
  );

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

        <div className="grid grid-flow-row-dense auto-rows-[minmax(11rem,auto)] grid-cols-2 gap-4 lg:grid-cols-4">
          {fields.map(({ field, count }, index) => (
            <FieldCard
              key={field.domain}
              field={field}
              count={count}
              size={fieldSize(index)}
            />
          ))}
          {subtopics.map((subtopic) => (
            <SubtopicCard key={subtopic.label} subtopic={subtopic} />
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
