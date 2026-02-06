"use client";

import { RegistrationBadge } from "@/components/ui/registration-badge";
import { Button } from "@/components/ui/button";
import { ArrowRight, Flame, Sparkles } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { isClassProgram, Program } from "../utils";

export type ProgramCardVariant = "grid" | "list" | "carousel";
export type ProgramBadge = "featured" | "trending" | "new";

interface ProgramCardProps {
  program: Program;
  variant?: ProgramCardVariant;
  badge?: ProgramBadge;
}

const badgeConfig: Record<
  ProgramBadge,
  { label: string; icon: React.ReactNode; className: string }
> = {
  featured: {
    label: "Featured",
    icon: <Sparkles className="w-3 h-3" />,
    className: "bg-amber-500 text-white",
  },
  trending: {
    label: "Trending",
    icon: <Flame className="w-3 h-3" />,
    className: "bg-rose-500 text-white",
  },
  new: {
    label: "New",
    icon: <Sparkles className="w-3 h-3" />,
    className: "bg-emerald-500 text-white",
  },
};

function TypeBadge({ type }: { type: "class" | "webinar" }) {
  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-medium ${
        type === "class" ? "bg-zinc-900 text-white" : "bg-white text-zinc-900"
      }`}
    >
      {type === "class" ? "Class" : "Webinar"}
    </span>
  );
}

function ExtraBadge({ badge }: { badge: ProgramBadge }) {
  const config = badgeConfig[badge];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${config.className}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

function GridCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const router = useRouter();

  const handleClick = () => {
    if (isClassProgram(program)) {
      router.push(`/explore/programs/plans/classes/${program.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${program.id}`);
    }
  };

  return (
    <div
      className="group bg-white rounded-2xl overflow-hidden border border-zinc-200 hover:border-zinc-300 hover:shadow-xl transition-all duration-300 cursor-pointer h-full flex flex-col"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`View details for ${program.title}`}
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <TypeBadge type={program.type} />
          {program.isRegistered && (
            <RegistrationBadge
              type={isClassProgram(program) ? "class" : "webinar"}
              compact
            />
          )}
        </div>
        {badge && (
          <div className="absolute top-3 right-3">
            <ExtraBadge badge={badge} />
          </div>
        )}
      </div>

      <div className="p-5 flex-1 flex flex-col">
        <h3 className="text-lg font-semibold text-zinc-900 mb-2 line-clamp-1 group-hover:text-zinc-700 transition-colors">
          {program.title}
        </h3>
        <p className="text-sm text-zinc-500 mb-4 line-clamp-2 flex-1">
          {program.description}
        </p>

        <div className="flex items-center justify-between pt-4 border-t border-zinc-100">
          <div className="text-xl font-bold text-zinc-900">
            ${program.price}
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-zinc-500 group-hover:text-zinc-900 transition-colors">
            <span>View Details</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ListCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const router = useRouter();

  const handleClick = () => {
    if (isClassProgram(program)) {
      router.push(`/explore/programs/plans/classes/${program.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${program.id}`);
    }
  };

  return (
    <div
      className="group bg-white rounded-2xl overflow-hidden border border-zinc-200 hover:border-zinc-300 hover:shadow-xl transition-all duration-300 cursor-pointer flex"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`View details for ${program.title}`}
    >
      <div className="relative w-48 md:w-64 flex-shrink-0">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover"
          sizes="256px"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <TypeBadge type={program.type} />
          {badge && <ExtraBadge badge={badge} />}
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col justify-between">
        <div>
          <div className="flex items-start justify-between gap-4 mb-2">
            <h3 className="text-lg font-semibold text-zinc-900 group-hover:text-zinc-700 transition-colors">
              {program.title}
            </h3>
            {program.isRegistered && (
              <RegistrationBadge
                type={isClassProgram(program) ? "class" : "webinar"}
                compact
              />
            )}
          </div>
          <p className="text-sm text-zinc-500 line-clamp-2">
            {program.description}
          </p>
        </div>

        <div className="flex items-center justify-between mt-4">
          <div className="text-xl font-bold text-zinc-900">
            ${program.price}
          </div>
          <Button
            variant="outline"
            className="rounded-xl border-zinc-300 hover:bg-zinc-50"
            onClick={(e) => {
              e.stopPropagation();
              handleClick();
            }}
          >
            View Details
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function CarouselCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const router = useRouter();

  const handleClick = () => {
    if (isClassProgram(program)) {
      router.push(`/explore/programs/plans/classes/${program.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${program.id}`);
    }
  };

  return (
    <div
      className="group bg-white rounded-2xl overflow-hidden border border-zinc-200 hover:border-zinc-300 hover:shadow-xl transition-all duration-300 cursor-pointer flex-shrink-0 w-[320px] md:w-[360px]"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`View details for ${program.title}`}
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          sizes="360px"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <TypeBadge type={program.type} />
        </div>
        {badge && (
          <div className="absolute top-3 right-3">
            <ExtraBadge badge={badge} />
          </div>
        )}
      </div>

      <div className="p-4">
        <h3 className="text-base font-semibold text-zinc-900 mb-1 line-clamp-1 group-hover:text-zinc-700 transition-colors">
          {program.title}
        </h3>
        <p className="text-sm text-zinc-500 line-clamp-1 mb-3">
          {program.description}
        </p>
        <div className="flex items-center justify-between">
          <div className="text-lg font-bold text-zinc-900">
            ${program.price}
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-zinc-500 group-hover:text-zinc-900 transition-colors">
            <span>View</span>
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProgramCard({
  program,
  variant = "grid",
  badge,
}: ProgramCardProps) {
  switch (variant) {
    case "list":
      return <ListCard program={program} badge={badge} />;
    case "carousel":
      return <CarouselCard program={program} badge={badge} />;
    default:
      return <GridCard program={program} badge={badge} />;
  }
}
