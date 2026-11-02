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
              className={
                isLast
                  ? "flex min-w-0 items-center truncate text-foreground"
                  : `flex min-w-0 items-center gap-1.5 ${
                      isRoot
                        ? "hidden shrink-0 sm:flex"
                        : "max-w-[45%] sm:max-w-[16rem]"
                    }`
              }
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
