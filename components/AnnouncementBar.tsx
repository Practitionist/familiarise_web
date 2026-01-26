"use client";

import { useState, useEffect, useCallback } from "react";
import { X, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

interface Announcement {
  id: string;
  title: string;
  content: string;
  type: string;
  backgroundColor?: string;
  textColor?: string;
  linkUrl?: string;
  linkText?: string;
}

const STORAGE_KEY_PREFIX = "announcement_closed_";

async function fetchAnnouncements(): Promise<Announcement[]> {
  const response = await fetch("/api/announcements");
  if (!response.ok) {
    throw new Error("Failed to fetch announcements");
  }
  const result = await response.json();
  return result.success ? result.data : [];
}

const AnnouncementBar = () => {
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set());
  const [mounted, setMounted] = useState(false);

  const { data: announcements = [] } = useQuery({
    queryKey: ["announcements"],
    queryFn: fetchAnnouncements,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });

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

  const handleClose = useCallback((id: string) => {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${id}`, "true");
    setClosedIds((prev) => {
      const newSet = new Set(prev);
      newSet.add(id);
      return newSet;
    });
    window.dispatchEvent(new CustomEvent("announcementBarClosed"));
  }, []);

  // Don't render until mounted (prevents hydration mismatch)
  if (!mounted) return null;

  // Filter out closed announcements
  const visibleAnnouncements = announcements.filter(
    (a) => !closedIds.has(a.id),
  );

  // Show the first visible announcement
  const announcement = visibleAnnouncements[0];

  if (!announcement) return null;

  const backgroundColor = announcement.backgroundColor || "#000000";
  const textColor = announcement.textColor || "#FFFFFF";

  return (
    <div
      className="w-full text-center py-2.5 fixed top-0 z-[1001] flex items-center justify-center gap-4 px-4"
      style={{ backgroundColor, color: textColor }}
    >
      <span className="flex-1 text-center">
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
        className="p-1 hover:bg-white/20 rounded transition-colors flex-shrink-0"
        aria-label="Close announcement"
        style={{ color: textColor }}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export default AnnouncementBar;
