"use client";

import { cn } from "@/utils/tailwind";
import { motion } from "framer-motion";
import { LucideIcon } from "lucide-react";
import { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: LucideIcon;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  variant?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
  onClick?: () => void;
}

export function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  variant = "default",
  className,
  onClick,
}: StatCardProps) {
  const variants = {
    default: {
      bg: "bg-white",
      iconBg: "bg-zinc-100",
      iconColor: "text-zinc-600",
      valueColor: "text-zinc-900",
    },
    success: {
      bg: "bg-white",
      iconBg: "bg-emerald-50",
      iconColor: "text-emerald-600",
      valueColor: "text-emerald-600",
    },
    warning: {
      bg: "bg-white",
      iconBg: "bg-amber-50",
      iconColor: "text-amber-600",
      valueColor: "text-amber-600",
    },
    danger: {
      bg: "bg-white",
      iconBg: "bg-red-50",
      iconColor: "text-red-600",
      valueColor: "text-red-600",
    },
    info: {
      bg: "bg-white",
      iconBg: "bg-blue-50",
      iconColor: "text-blue-600",
      valueColor: "text-blue-600",
    },
  };

  const v = variants[variant];

  return (
    <motion.div
      whileHover={{ y: -2, boxShadow: "0 8px 30px -12px rgba(0, 0, 0, 0.15)" }}
      transition={{ duration: 0.2 }}
      className={cn(
        "relative overflow-hidden rounded-xl border border-zinc-200/80 p-5 transition-all",
        v.bg,
        onClick && "cursor-pointer",
        className,
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-500 truncate">{title}</p>
          <p
            className={cn(
              "mt-2 text-2xl font-bold tracking-tight",
              v.valueColor,
            )}
          >
            {value}
          </p>
          {subtitle && <p className="mt-1 text-xs text-zinc-400">{subtitle}</p>}
          {trend && (
            <div className="mt-2 flex items-center gap-1">
              <span
                className={cn(
                  "inline-flex items-center text-xs font-medium",
                  trend.isPositive ? "text-emerald-600" : "text-red-600",
                )}
              >
                {trend.isPositive ? "↑" : "↓"} {Math.abs(trend.value)}%
              </span>
              <span className="text-xs text-zinc-400">vs last period</span>
            </div>
          )}
        </div>

        {Icon && (
          <div
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-xl",
              v.iconBg,
            )}
          >
            <Icon className={cn("h-5 w-5", v.iconColor)} />
          </div>
        )}
      </div>

      {/* Decorative gradient */}
      <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br from-zinc-100/50 to-transparent opacity-50" />
    </motion.div>
  );
}

interface StatCardSkeletonProps {
  className?: string;
}

export function StatCardSkeleton({ className }: StatCardSkeletonProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-zinc-200/80 bg-white p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-3">
          <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
          <div className="h-8 w-16 animate-pulse rounded bg-zinc-200" />
          <div className="h-3 w-20 animate-pulse rounded bg-zinc-200" />
        </div>
        <div className="h-11 w-11 animate-pulse rounded-xl bg-zinc-200" />
      </div>
    </div>
  );
}
