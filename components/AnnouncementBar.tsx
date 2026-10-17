"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { X, ExternalLink } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isChromeHidden } from "@/lib/navigation/public-chrome";
import { useAnnouncementBar } from "@/providers/AnnouncementBarProvider";
import { useActiveAnnouncements } from "@/hooks/useActiveAnnouncements";

const STORAGE_KEY_PREFIX = "announcement_closed_";

const AnnouncementBar = () => {
  const pathname = usePathname();
  const chromeHidden = isChromeHidden(pathname);
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set());
  const [mounted, setMounted] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const { setVisible, setHeight } = useAnnouncementBar();

  const { data: announcements = [] } = useActiveAnnouncements();

  // Load closed announcements from localStorage on mount
  useEffect(() => {
    const closed = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) {
        const id = key.replace(STORAGE_KEY_PREFIX, "");
        closed.add(id);
      }
    }
    setClosedIds(closed);
    setMounted(true);
  }, []);

  // Filter out closed announcements
  const visibleAnnouncements = announcements.filter(
    (a) => !closedIds.has(a.id),
  );
  const announcement = visibleAnnouncements[0];

  // Update context visibility when announcement or route changes
  useEffect(() => {
    if (!mounted) return;
    if (chromeHidden) {
      setVisible(false);
      setHeight(0);
      return;
    }
    setVisible(!!announcement);
  }, [announcement, chromeHidden, mounted, setHeight, setVisible]);

  // Measure actual height with ResizeObserver
  useEffect(() => {
    if (!barRef.current || !announcement || chromeHidden) return;

    const observer = new ResizeObserver(([entry]) => {
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      setHeight(h);
    });

    observer.observe(barRef.current);
    return () => observer.disconnect();
  }, [setHeight, announcement, chromeHidden]);

  // Clean up CSS var when unmounting without an announcement or on non-chrome routes
  useEffect(() => {
    if (mounted && (!announcement || chromeHidden)) {
      setHeight(0);
    }
  }, [mounted, announcement, chromeHidden, setHeight]);

  const handleClose = useCallback(
    (id: string) => {
      localStorage.setItem(`${STORAGE_KEY_PREFIX}${id}`, "true");
      setClosedIds((prev) => {
        const newSet = new Set(prev);
        newSet.add(id);
        return newSet;
      });
      setVisible(false);
    },
    [setVisible],
  );

  // Don't render until mounted (prevents hydration mismatch) or on non-chrome routes
  if (!mounted || chromeHidden || !announcement) return null;

  const backgroundColor = announcement.backgroundColor || "#000000";
  const textColor = announcement.textColor || "#FFFFFF";

  return (
    <div
      ref={barRef}
      data-announcement-bar
      className="w-full text-center py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] fixed top-maintenance z-[1001] flex items-center justify-center gap-4 px-4 border-b border-white/10"
      style={{ backgroundColor, color: textColor }}
    >
      <span className="flex-1 text-center text-sm">
        {announcement.content}
        {announcement.linkUrl && (
          <Link
            href={announcement.linkUrl}
            className="inline-flex items-center gap-1 ml-2 underline hover:no-underline"
            style={{ color: textColor }}
          >
            {announcement.linkText || "Learn more"}
            <ExternalLink className="w-3 h-3" />
          </Link>
        )}
      </span>
      <button
        onClick={() => handleClose(announcement.id)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/10 transition-colors flex-shrink-0"
        aria-label="Close announcement"
        style={{ color: textColor }}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export default AnnouncementBar;
