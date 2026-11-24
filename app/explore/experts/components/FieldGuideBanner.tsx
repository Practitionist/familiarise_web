import { BookOpen } from "lucide-react";
import Link from "next/link";

import { domainPath } from "@/lib/explore/domain-slug";

/** Shown while the directory is filtered to one field, pointing to that field's category page. */
export function FieldGuideBanner({
  fieldName,
}: Readonly<{ fieldName: string }>) {
  const href = domainPath(fieldName);
  return (
    <div className="mb-6 mt-6 flex flex-col gap-3 rounded-2xl border border-border bg-muted/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-center gap-2 text-sm text-foreground">
        <BookOpen aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>
          Browsing{" "}
          <Link
            href={href}
            className="font-semibold underline underline-offset-4"
          >
            {fieldName}
          </Link>{" "}
          experts. New to the field? Its guide lists popular topics and top
          experts.
        </span>
      </p>
      <Link
        href={href}
        className="shrink-0 text-sm font-medium underline underline-offset-4 hover:text-foreground/80"
      >
        See the {fieldName} guide →
      </Link>
    </div>
  );
}
