import * as React from "react";
import { cn } from "@/utils/tailwind";

/**
 * Shared page/section heading using the fluid type scale, so spacing and
 * type rhythm stay consistent across the dashboards and marketing surfaces.
 */
interface PageHeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
  as?: "h1" | "h2" | "h3";
}

const PageHeading = React.forwardRef<HTMLHeadingElement, PageHeadingProps>(
  ({ as: Tag = "h1", className, ...props }, ref) => (
    <Tag
      ref={ref}
      className={cn(
        "text-fluid-2xl font-semibold tracking-tight text-foreground",
        className,
      )}
      {...props}
    />
  ),
);
PageHeading.displayName = "PageHeading";

interface PageHeaderProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Inline badge/status rendered next to the title. */
  badge?: React.ReactNode;
  /** Right-aligned actions (buttons, filters). */
  actions?: React.ReactNode;
  headingAs?: "h1" | "h2" | "h3";
}

const PageHeader = React.forwardRef<HTMLDivElement, PageHeaderProps>(
  (
    { title, description, badge, actions, headingAs, className, ...props },
    ref,
  ) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <PageHeading as={headingAs}>{title}</PageHeading>
          {badge}
        </div>
        {description && (
          <p className="text-fluid-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  ),
);
PageHeader.displayName = "PageHeader";

export { PageHeader, PageHeading };
