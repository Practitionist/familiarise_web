import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

export interface ExploreHeroStat {
  key: string;
  icon: LucideIcon;
  display: string;
  label: string;
}

interface ExploreHeroProps {
  /** Small pill above the title, e.g. "Expert Networks & Agencies". */
  eyebrow: string;
  eyebrowIcon?: LucideIcon;
  /** H1 content — callers embed their `<span className="silver-text">` accent. */
  title: ReactNode;
  description: string;
  /** Real figures or nothing: empty renders `emptyStatsCopy` instead. */
  stats: ExploreHeroStat[];
  emptyStatsCopy: string;
}

/**
 * One hero geometry for every explore surface (experts / organisations /
 * programs). Previously each page owned its own hero with different H1
 * scales, pill styles, and stat layouts, so the three directories never
 * felt like one marketplace. Content differs per page; chrome never does.
 */
export default function ExploreHero({
  eyebrow,
  eyebrowIcon: EyebrowIcon = Sparkles,
  title,
  description,
  stats,
  emptyStatsCopy,
}: ExploreHeroProps) {
  return (
    <section className="relative pt-32 pb-20 bg-zinc-950 overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
      </div>
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 relative z-10">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-8">
            <EyebrowIcon className="w-4 h-4 text-white" />
            <span className="text-sm font-medium text-zinc-300">{eyebrow}</span>
          </div>

          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight text-white mb-6">
            {title}
          </h1>

          <p className="text-lg md:text-xl text-zinc-400 mb-12 max-w-2xl mx-auto">
            {description}
          </p>

          {stats.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-8 md:gap-16">
              {stats.map((stat) => {
                const Icon = stat.icon;
                return (
                  <div key={stat.key} className="text-center">
                    <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50 flex items-center justify-center">
                      <Icon className="w-6 h-6 text-white" />
                    </div>
                    <div className="text-2xl md:text-3xl font-bold text-white">
                      {stat.display}
                    </div>
                    <div className="text-sm text-zinc-500">{stat.label}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">{emptyStatsCopy}</p>
          )}
        </div>
      </div>
    </section>
  );
}
