"use client";

import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { ReactNode, useState, createContext, useContext } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// Context for mobile sidebar state
interface MobileSidebarContextType {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  toggle: () => void;
}

const MobileSidebarContext = createContext<MobileSidebarContextType | null>(
  null,
);

export function useMobileSidebar() {
  const context = useContext(MobileSidebarContext);
  if (!context) {
    throw new Error("useMobileSidebar must be used within DashboardShell");
  }
  return context;
}

interface DashboardShellProps {
  children: ReactNode;
  sidebar: ReactNode;
  className?: string;
}

export function DashboardShell({
  children,
  sidebar,
  className,
}: DashboardShellProps) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const contextValue: MobileSidebarContextType = {
    isOpen: isMobileSidebarOpen,
    setIsOpen: setIsMobileSidebarOpen,
    toggle: () => setIsMobileSidebarOpen((prev) => !prev),
  };

  return (
    <MobileSidebarContext.Provider value={contextValue}>
      <div className={cn("flex min-h-screen bg-zinc-100", className)}>
        {/* Desktop Sidebar */}
        <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 lg:block">
          {sidebar}
        </aside>

        {/* Mobile Sidebar Overlay */}
        <AnimatePresence>
          {isMobileSidebarOpen && (
            <>
              {/* Backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
                onClick={() => setIsMobileSidebarOpen(false)}
              />

              {/* Mobile Sidebar Drawer */}
              <motion.aside
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed left-0 top-0 z-50 h-screen w-72 lg:hidden"
              >
                {/* Close button */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsMobileSidebarOpen(false)}
                  className="absolute right-3 top-3 z-10 h-8 w-8 rounded-full bg-white/10 text-white hover:bg-white/20"
                >
                  <X className="h-5 w-5" />
                </Button>
                {sidebar}
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        {/* Main Content */}
        <main className="flex-1 lg:ml-64 min-h-screen bg-zinc-100">
          {/* Mobile Header Bar */}
          <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-3 bg-white border-b border-zinc-200 lg:hidden">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsMobileSidebarOpen(true)}
              className="h-9 w-9 shrink-0"
            >
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open menu</span>
            </Button>
            <span className="font-semibold text-zinc-900">Familiarise</span>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="min-h-0 p-6 lg:p-8 bg-zinc-100"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </MobileSidebarContext.Provider>
  );
}

// Mobile menu button component for use in headers
export function MobileMenuButton({ className }: { className?: string }) {
  const { toggle } = useMobileSidebar();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      className={cn("lg:hidden h-9 w-9 shrink-0", className)}
    >
      <Menu className="h-5 w-5" />
      <span className="sr-only">Toggle menu</span>
    </Button>
  );
}

interface DashboardHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}

export function DashboardHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
}: DashboardHeaderProps) {
  return (
    <div className="sticky top-0 z-20 bg-white/80 backdrop-blur-xl border-b border-zinc-200/50">
      <div className="px-4 sm:px-6 py-3 sm:py-4 lg:px-8">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="flex items-center gap-2 text-sm text-zinc-500 mb-2">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.label} className="flex items-center gap-2">
                {index > 0 && <span>/</span>}
                {crumb.href ? (
                  <a
                    href={crumb.href}
                    className="hover:text-zinc-900 transition-colors"
                  >
                    {crumb.label}
                  </a>
                ) : (
                  <span className="text-zinc-900">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-900 truncate">
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs sm:text-sm text-zinc-500 mt-0.5 truncate">
                {subtitle}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              {actions}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface DashboardContentProps {
  children: ReactNode;
  className?: string;
  fullHeight?: boolean;
}

export function DashboardContent({
  children,
  className,
  fullHeight = false,
}: DashboardContentProps) {
  return (
    <div
      className={cn(
        "px-6 py-6 lg:px-8",
        fullHeight && "flex-1 flex flex-col overflow-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface DashboardGridProps {
  children: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  className?: string;
}

export function DashboardGrid({
  children,
  columns = 3,
  className,
}: DashboardGridProps) {
  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
  };

  return (
    <div className={cn("grid gap-4 lg:gap-6", gridCols[columns], className)}>
      {children}
    </div>
  );
}
