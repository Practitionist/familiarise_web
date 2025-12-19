"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";

const STORAGE_KEY = "announcementBarClosed";

const AnnouncementBar = () => {
  // Start with null to avoid hydration mismatch, then check localStorage
  const [isVisible, setIsVisible] = useState<boolean | null>(null);

  useEffect(() => {
    // Check localStorage after mount to avoid SSR/client mismatch
    const isClosed = localStorage.getItem(STORAGE_KEY) === "true";
    setIsVisible(!isClosed);
  }, []);

  const handleClose = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    setIsVisible(false);
    // Dispatch a custom event that works in the same window
    // (native storage events only fire in OTHER windows)
    window.dispatchEvent(new CustomEvent("announcementBarClosed"));
  };

  // Don't render anything until we've checked localStorage (prevents flash)
  if (isVisible === null || !isVisible) return null;

  return (
    <div className="w-full bg-black text-white text-center py-2.5 fixed top-0 z-[1001] flex items-center justify-center gap-4 px-4">
      <span>
        🔥 Exciting sale coming soon! Get ready for amazing discounts on
        consultancy sessions! 🔥
      </span>
      <button
        onClick={handleClose}
        className="p-1 hover:bg-white/20 rounded transition-colors"
        aria-label="Close announcement"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export default AnnouncementBar;
