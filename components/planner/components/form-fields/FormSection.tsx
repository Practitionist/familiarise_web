"use client";

import { cn } from "@/utils/tailwind";
import { LucideIcon } from "lucide-react";

interface FormSectionProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}

export function FormSection({
  title,
  description,
  icon: Icon,
  children,
  className,
}: Readonly<FormSectionProps>) {
  return (
    <div
      className={cn(
        "rounded-xl bg-card p-6 space-y-4 border border-border/50 shadow-elevation-1",
        className,
      )}
    >
      <div className="flex items-center gap-3 pb-3 border-b border-border/30">
        {Icon && (
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted ring-1 ring-border">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </span>
        )}
        <div>
          <h3 className="text-lg font-semibold tracking-tight text-foreground">
            {title}
          </h3>
          {description && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}
