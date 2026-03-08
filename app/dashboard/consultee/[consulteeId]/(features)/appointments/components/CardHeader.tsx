"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/utils/tailwind";

interface CollaboratorInfo {
  name: string;
  image?: string | null;
  role: string;
}

interface CardHeaderProps {
  title: string;
  consultant: string;
  image?: string | null;
  collaborators?: CollaboratorInfo[];
  metaLine?: string;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("");
}

export function CardHeader({
  title,
  consultant,
  image,
  collaborators = [],
  metaLine,
}: CardHeaderProps) {
  return (
    <div className="flex items-start gap-3">
      {/* Avatar stack */}
      <div className="flex items-center -space-x-2 shrink-0">
        <Avatar className="h-11 w-11 ring-2 ring-white z-10">
          <AvatarImage alt={consultant} src={image || undefined} />
          <AvatarFallback className="bg-gradient-to-br from-zinc-100 to-zinc-200 text-zinc-600 text-sm font-semibold">
            {getInitials(consultant)}
          </AvatarFallback>
        </Avatar>
        {collaborators.slice(0, 2).map((collab, idx) => (
          <Avatar
            key={idx}
            className={cn(
              "h-8 w-8 ring-2 ring-white",
              idx === 0 ? "z-[5]" : "z-0",
            )}
            title={`${collab.name} (${collab.role})`}
          >
            <AvatarImage alt={collab.name} src={collab.image || undefined} />
            <AvatarFallback className="bg-purple-100 text-purple-700 text-[10px] font-semibold">
              {getInitials(collab.name)}
            </AvatarFallback>
          </Avatar>
        ))}
        {collaborators.length > 2 && (
          <div className="h-8 w-8 rounded-full bg-zinc-100 ring-2 ring-white flex items-center justify-center text-[10px] font-semibold text-zinc-600 z-0">
            +{collaborators.length - 2}
          </div>
        )}
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <h3
          className="font-semibold text-zinc-900 text-sm leading-tight line-clamp-2 mb-0.5"
          title={title}
        >
          {title}
        </h3>
        <p className="text-xs text-zinc-500 line-clamp-1" title={consultant}>
          {collaborators.length === 0
            ? consultant
            : collaborators.length === 1
              ? `${consultant} & ${collaborators[0].name}`
              : `${consultant} + ${collaborators.length} others`}
        </p>
        {metaLine && (
          <p className="text-[10px] text-zinc-400 mt-0.5">{metaLine}</p>
        )}
      </div>
    </div>
  );
}
