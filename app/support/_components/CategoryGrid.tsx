import Link from "next/link";
import {
  Building2,
  CalendarClock,
  CirclePlay,
  CreditCard,
  GraduationCap,
  LifeBuoy,
  UserRound,
  Video,
} from "lucide-react";

import {
  articlesForCategory,
  supportCategories,
} from "../_data/support-content";

const ICONS: Record<string, typeof UserRound> = {
  account: UserRound,
  booking: CalendarClock,
  payments: CreditCard,
  video: Video,
  recordings: CirclePlay,
  experts: GraduationCap,
  organizations: Building2,
  help: LifeBuoy,
};

/** Eight category cards linking to each category hub. Server-rendered. */
export function CategoryGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {supportCategories.map((category) => {
        const Icon = ICONS[category.icon] ?? LifeBuoy;
        const count = articlesForCategory(category.slug).length;
        return (
          <Link
            key={category.slug}
            href={`/support/${category.slug}`}
            className="group flex flex-col rounded-2xl border border-border bg-card p-5 shadow-elevation-1 transition-all hover:-translate-y-0.5 hover:shadow-elevation-2"
          >
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-950 text-white">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <span className="font-semibold leading-snug">{category.title}</span>
            <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {category.description}
            </span>
            <span className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {count} articles
            </span>
          </Link>
        );
      })}
    </div>
  );
}
