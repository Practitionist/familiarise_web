"use client";

import { User } from "@prisma/client";
import type { ConsultantDetailData } from "../types";
import {
  User2,
  Sparkles,
  Wrench,
  MessagesSquare,
  PlayCircle,
} from "lucide-react";

interface AboutSectionProps {
  userDetails: User;
  consultantDetails: ConsultantDetailData;
}

/**
 * Returns true if `value` is a non-empty string that isn't one of the
 * placeholder sentinels users/seeds sometimes leave behind ("none", "n/a", …).
 */
const isRealDescription = (
  value: string | null | undefined,
): value is string => {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/^(none|n\/?a|na|null|nil|tbd|-+|\.+)$/i.test(trimmed);
};

/** The profile field accepts any URL scheme; only a web address may become a link. */
function webUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function SectionTitle({
  icon: Icon,
  children,
}: Readonly<{ icon: typeof User2; children: React.ReactNode }>) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold text-foreground">{children}</h3>
    </div>
  );
}

function Chips({
  items,
}: Readonly<{ items: { key: string; label: string }[] }>) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item.key}
          className="px-3 py-1.5 bg-muted text-muted-foreground text-sm font-medium rounded-full"
        >
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function AboutSection({
  userDetails,
  consultantDetails,
}: AboutSectionProps) {
  const introVideo = webUrl(consultantDetails.videoIntroUrl);
  const tags = consultantDetails.tags ?? [];
  const tools = (consultantDetails.toolsAndTechnologies ?? []).filter(Boolean);
  const mentoringStyle = isRealDescription(consultantDetails.mentoringStyle)
    ? consultantDetails.mentoringStyle.trim()
    : null;
  const headline = consultantDetails.headline?.trim();

  return (
    <div className="bg-card rounded-2xl border border-border p-6 md:p-8 space-y-6">
      <div>
        <SectionTitle icon={User2}>About</SectionTitle>
        <p className="text-muted-foreground leading-relaxed">
          {isRealDescription(consultantDetails.description)
            ? consultantDetails.description.trim()
            : [userDetails.name, headline].filter(Boolean).join(", ")}
        </p>
        {introVideo && (
          <a
            href={introVideo}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-foreground underline underline-offset-4 hover:no-underline"
          >
            <PlayCircle className="w-4 h-4" aria-hidden />
            Watch intro video
          </a>
        )}
      </div>

      {mentoringStyle && (
        <div>
          <SectionTitle icon={MessagesSquare}>How they work</SectionTitle>
          <p className="text-muted-foreground leading-relaxed whitespace-pre-line">
            {mentoringStyle}
          </p>
        </div>
      )}

      {tags.length > 0 && (
        <div>
          <SectionTitle icon={Sparkles}>Skills & Specialties</SectionTitle>
          <Chips
            items={tags.map((tag) => ({ key: tag.id, label: tag.name }))}
          />
        </div>
      )}

      {tools.length > 0 && (
        <div>
          <SectionTitle icon={Wrench}>Tools & technologies</SectionTitle>
          <Chips items={tools.map((tool) => ({ key: tool, label: tool }))} />
        </div>
      )}
    </div>
  );
}
