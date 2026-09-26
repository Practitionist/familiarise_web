"use client";

import Image from "next/image";
import { cn } from "@/utils/tailwind";
import { motion } from "framer-motion";
import { LucideIcon, ChevronRight } from "lucide-react";
import Link from "next/link";
import { ReactNode } from "react";

// EmptyState moved to its own module (#1527); kept importable from here.
export { EmptyState } from "./EmptyState";

interface DataCardProps {
  title: string;
  icon?: LucideIcon;
  headerAction?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  viewAllLink?: string;
  viewAllText?: string;
  className?: string;
  noPadding?: boolean;
}

export function DataCard({
  title,
  icon: Icon,
  headerAction,
  children,
  footer,
  viewAllLink,
  viewAllText = "View all",
  className,
  noPadding = false,
}: DataCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-elevation-1",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          {Icon && (
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
              <Icon className="h-4.5 w-4.5 text-muted-foreground" />
            </div>
          )}
          <h3 className="font-semibold text-foreground">{title}</h3>
        </div>
        {headerAction}
      </div>

      {/* Content */}
      <div className={cn(!noPadding && "p-5")}>{children}</div>

      {/* Footer */}
      {(footer || viewAllLink) && (
        <div className="border-t border-border px-5 py-3">
          {footer || (
            <Link
              href={viewAllLink!}
              className="group flex items-center justify-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {viewAllText}
              <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          )}
        </div>
      )}
    </motion.div>
  );
}

interface ActivityItemProps {
  avatar?: string;
  name: string;
  action: string;
  time: string;
  onClick?: () => void;
}

export function ActivityItem({
  avatar,
  name,
  action,
  time,
  onClick,
}: ActivityItemProps) {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <div
      className={cn(
        "flex items-center gap-3 py-3",
        onClick &&
          "cursor-pointer hover:bg-zinc-50 -mx-2 px-2 rounded-lg transition-colors",
      )}
      onClick={onClick}
    >
      <div className="h-9 w-9 rounded-full bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0">
        {avatar ? (
          <Image
            src={avatar}
            alt={name}
            width={36}
            height={36}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-xs font-medium text-zinc-600">{initials}</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-900">
          <span className="font-medium">{name}</span>{" "}
          <span className="text-zinc-500">{action}</span>
        </p>
        <p className="text-xs text-zinc-400">{time}</p>
      </div>
    </div>
  );
}

export function DataCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-elevation-1">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="h-9 w-9 animate-pulse rounded-lg bg-muted" />
        <div className="h-5 w-32 animate-pulse rounded bg-muted" />
      </div>
      <div className="p-5 space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
