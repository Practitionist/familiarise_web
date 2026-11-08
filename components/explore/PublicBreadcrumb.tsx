import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface PublicBreadcrumbItem {
  label: string;
  href?: string;
}

/** Experts › Expert name › Item title; the last item is the current page. */
export function publicBreadcrumbItems(
  expert: { id: string; name: string | null } | null | undefined,
  title: string,
): PublicBreadcrumbItem[] {
  return [
    { label: "Experts", href: "/explore/experts" },
    ...(expert
      ? [
          {
            label: expert.name ?? "Expert",
            href: `/explore/experts/${expert.id}`,
          },
        ]
      : []),
    { label: title },
  ];
}

function itemClass(isLast: boolean, isRoot: boolean): string {
  if (isLast) return "flex min-w-0 items-center truncate text-foreground";
  // The root stays on phones: it is the only direct route back to the list.
  const width = isRoot ? "shrink-0" : "max-w-[45%] sm:max-w-[16rem]";
  return `flex min-w-0 items-center gap-1.5 ${width}`;
}

/** The breadcrumb band above a plan detail page. */
export function PlanBreadcrumb({
  plan,
}: Readonly<{
  plan: {
    title: string;
    consultantProfile: { id: string; user: { name: string | null } } | null;
  };
}>) {
  const { consultantProfile } = plan;
  return (
    <div className="w-full border-b border-border bg-card px-4 py-4 md:px-8 lg:px-12">
      <PublicBreadcrumb
        items={publicBreadcrumbItems(
          consultantProfile
            ? { id: consultantProfile.id, name: consultantProfile.user.name }
            : null,
          plan.title,
        )}
      />
    </div>
  );
}

export function PublicBreadcrumb({
  items,
}: Readonly<{ items: PublicBreadcrumbItem[] }>) {
  const lastIndex = items.length - 1;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 text-sm">
      <ol className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {items.map((item, index) => {
          const isLast = index === lastIndex;
          const isRoot = index === 0 && !isLast;
          return (
            <li
              key={`${index}-${item.label}`}
              className={itemClass(isLast, isRoot)}
              aria-current={isLast ? "page" : undefined}
            >
              {isLast || !item.href ? (
                <span className="truncate">{item.label}</span>
              ) : (
                <Link
                  href={item.href}
                  className="truncate hover:text-foreground"
                >
                  {item.label}
                </Link>
              )}
              {!isLast && (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
