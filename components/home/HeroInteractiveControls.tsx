"use client";

import { useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  Calendar,
  Lock,
  Search,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

const QUICK_DOMAINS = [
  "Technology",
  "Business",
  "Creative Arts",
  "Education",
  "Health",
  "Personal Development",
];

const PREVIEW_FORMATS = [
  {
    id: "consultation",
    label: "1:1 Consultation",
    meta: "45 min • Live HD video",
    href: "/explore/experts#all-experts",
  },
  {
    id: "mentorship",
    label: "Mentorship Plan",
    meta: "Weekly calls + async chat",
    href: "/explore/experts#all-experts",
  },
  {
    id: "class",
    label: "Cohort Class",
    meta: "Multi-week structured curriculum",
    href: "/explore/programs?type=class#all-programs",
  },
] as const;

const PREVIEW_SLOTS = ["Today, 6:00 PM", "Tomorrow, 11:00 AM", "Thu, 4:30 PM"];

export function HeroSearchControls() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    const target = trimmed
      ? `/explore/experts?search=${encodeURIComponent(trimmed)}#all-experts`
      : "/explore/experts#all-experts";
    router.push(target);
  };

  return (
    <>
      <form
        action="/explore/experts#all-experts"
        method="GET"
        onSubmit={handleSubmit}
        className="mb-5 max-w-2xl"
      >
        <div className="flex flex-col sm:flex-row gap-2.5 p-2 rounded-2xl bg-zinc-900/90 border border-white/10 focus-within:border-white/25 transition-colors shadow-xl">
          <div className="relative flex-1 flex items-center">
            <Search className="w-4 h-4 text-zinc-400 ml-3.5 shrink-0" />
            <input
              type="text"
              name="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search experts by skill, role, or topic"
              placeholder="Search by skill, role, domain, or company..."
              className="w-full bg-transparent px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none"
            />
          </div>
          <Button
            type="submit"
            size="lg"
            className="h-11 px-6 rounded-xl bg-white text-zinc-900 hover:bg-zinc-100 font-medium shrink-0"
          >
            Explore Experts
            <ArrowRight className="ml-2 w-4 h-4" />
          </Button>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2 mb-10">
        <span className="text-xs font-medium text-zinc-500 mr-1">
          Popular domains:
        </span>
        {QUICK_DOMAINS.map((domain) => {
          const trimmed = searchQuery.trim();
          const params = new URLSearchParams({ domain });
          if (trimmed) params.set("search", trimmed);
          return (
            <Link
              key={domain}
              href={`/explore/experts?${params.toString()}#all-experts`}
              className="text-xs px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08] hover:text-white hover:border-white/20 transition-colors"
            >
              {domain}
            </Link>
          );
        })}
        <Link
          href="/become-an-expert"
          className="text-xs px-3 py-1.5 rounded-full text-zinc-400 hover:text-white underline underline-offset-4 ml-1 transition-colors"
        >
          Become an Expert →
        </Link>
      </div>
    </>
  );
}

export function HeroPreviewCard() {
  const router = useRouter();
  const [selectedFormatId, setSelectedFormatId] = useState<string>(
    PREVIEW_FORMATS[0].id,
  );
  const [selectedSlot, setSelectedSlot] = useState<string>(PREVIEW_SLOTS[0]);

  const handleFormatSelect = (format: (typeof PREVIEW_FORMATS)[number]) => {
    setSelectedFormatId(format.id);
    router.push(format.href);
  };

  const handleSlotSelect = (slot: string) => {
    setSelectedSlot(slot);
    router.push("/explore/experts#all-experts");
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/70 backdrop-blur-md p-6 shadow-2xl">
      {/* Header bar */}
      <div className="flex items-center justify-between pb-5 mb-5 border-b border-white/[0.08]">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-zinc-800 border border-white/10 flex items-center justify-center font-semibold text-sm text-white">
            1:1
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-white">
                Verified Expert Session
              </span>
              <BadgeCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            </div>
            <p className="text-xs text-zinc-400">
              Architecture, Career &amp; Product Advisory
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs font-medium">
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full bg-emerald-400"
          />
          <span>Available</span>
        </span>
      </div>

      {/* Session Format Selector Preview */}
      <div className="space-y-2.5 mb-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Choose Your Format
        </p>
        {PREVIEW_FORMATS.map((item) => {
          const isActive = item.id === selectedFormatId;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleFormatSelect(item)}
              className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-colors ${
                isActive
                  ? "border-white/25 bg-white/[0.06] hover:bg-white/[0.1]"
                  : "border-white/[0.06] bg-zinc-950/50 hover:border-white/15 hover:bg-white/[0.04]"
              }`}
            >
              <div>
                <p className="text-sm font-medium text-white">{item.label}</p>
                <p className="text-xs text-zinc-400">{item.meta}</p>
              </div>
              <span
                className={`text-xs px-2.5 py-1 rounded-md font-medium ${
                  isActive
                    ? "bg-white text-zinc-950"
                    : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {isActive ? "Selected" : "Explore →"}
              </span>
            </button>
          );
        })}
      </div>

      {/* Next Available Slots */}
      <div className="mb-6">
        <div className="flex items-center justify-between text-xs text-zinc-400 mb-2.5">
          <span className="flex items-center gap-1.5 font-medium text-zinc-300">
            <Calendar className="w-3.5 h-3.5 text-zinc-400" />
            Instant Timezone-Aware Slots
          </span>
          <span>Auto-detected</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {PREVIEW_SLOTS.map((slot) => {
            const isSelected = slot === selectedSlot;
            return (
              <button
                key={slot}
                type="button"
                onClick={() => handleSlotSelect(slot)}
                className={`text-center py-2 px-2 rounded-lg border text-xs font-medium transition-colors ${
                  isSelected
                    ? "border-white/30 bg-white/10 text-white hover:bg-white/15"
                    : "border-white/[0.08] bg-zinc-950/60 text-zinc-400 hover:border-white/20 hover:text-white"
                }`}
              >
                {slot}
              </button>
            );
          })}
        </div>
      </div>

      {/* Built-in Platform Guarantees Footer */}
      <div className="grid grid-cols-2 gap-3 pt-4 border-t border-white/[0.08] mb-5">
        <div className="flex items-center gap-2 text-xs text-zinc-300">
          <Video className="w-4 h-4 text-zinc-400 shrink-0" />
          <span>Browser HD Video &amp; Recording</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-300">
          <Lock className="w-4 h-4 text-zinc-400 shrink-0" />
          <span>Escrow Payment Protection</span>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2.5">
        <Button
          asChild
          className="flex-1 h-11 rounded-xl bg-white text-zinc-900 hover:bg-zinc-100 font-medium"
        >
          <Link href="/explore/experts#all-experts">
            Browse 1:1 Experts
            <ArrowRight className="ml-1.5 w-4 h-4" />
          </Link>
        </Button>
        <Button
          asChild
          variant="outline"
          className="h-11 rounded-xl border-white/15 bg-white/[0.04] text-white hover:bg-white/10 hover:text-white"
        >
          <Link href="/explore/programs#all-programs">Cohort Programs</Link>
        </Button>
      </div>
    </div>
  );
}
