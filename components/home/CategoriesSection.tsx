import { ArrowUpRight, ChevronRight } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { domainPath } from "@/lib/explore/domain-slug";
import { cn } from "@/utils/tailwind";
import { FIELD_TILES, GOAL_LINKS, type FieldTile } from "./fields";

function expertCount(count: number): string {
  return count === 1 ? "1 expert" : `${count} experts`;
}

function FieldCard({
  field,
  count,
  featured,
}: Readonly<{ field: FieldTile; count: number; featured: boolean }>) {
  const Icon = field.icon;
  return (
    <Link
      href={domainPath(field.domain)}
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        featured
          ? "min-h-[220px] bg-zinc-950 p-7 text-white hover:shadow-elevation-2 md:p-8"
          : "border border-border bg-card p-5 hover:border-foreground/30 hover:shadow-elevation-1",
      )}
    >
      {featured && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1.5px)",
            backgroundSize: "20px 20px",
            maskImage:
              "radial-gradient(ellipse 80% 80% at 100% 0%, #000 20%, transparent 70%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 80% 80% at 100% 0%, #000 20%, transparent 70%)",
          }}
        />
      )}
      <div className="relative flex items-start justify-between gap-4">
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-xl",
            featured
              ? "h-12 w-12 bg-white/10 text-white"
              : "h-10 w-10 bg-zinc-900 text-white",
          )}
        >
          <Icon
            aria-hidden="true"
            className={featured ? "h-6 w-6" : "h-5 w-5"}
          />
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className={cn(
            "h-5 w-5 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5",
            featured ? "text-zinc-400" : "text-muted-foreground",
          )}
        />
      </div>
      <div className="relative mt-auto pt-6">
        <h3
          className={cn(
            "font-semibold tracking-tight",
            featured ? "text-2xl" : "text-base text-foreground",
          )}
        >
          {field.label}
        </h3>
        <p
          className={cn(
            "mt-1 text-sm",
            featured ? "text-zinc-400" : "text-muted-foreground",
          )}
        >
          {field.subtopics.join(" · ")}
        </p>
        <p
          className={cn(
            "mt-3 text-sm font-medium",
            featured ? "text-white" : "text-foreground",
          )}
        >
          {expertCount(count)}
        </p>
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
  // Demand order decides the sequence; a field shows only while it has verified experts.
  const fields = FIELD_TILES.map((field) => ({
    field,
    count: consultantsByDomain[field.domain.toLowerCase()] ?? 0,
  })).filter(({ count }) => count > 0);
  const featured = fields.slice(0, 2);
  const rest = fields.slice(2);

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

        {featured.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            {featured.map(({ field, count }) => (
              <FieldCard
                key={field.domain}
                field={field}
                count={count}
                featured
              />
            ))}
          </div>
        )}
        {rest.length > 0 && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
            {rest.map(({ field, count }) => (
              <FieldCard
                key={field.domain}
                field={field}
                count={count}
                featured={false}
              />
            ))}
          </div>
        )}

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
