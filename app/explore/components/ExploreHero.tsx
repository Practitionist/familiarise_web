import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";

interface ExploreHeroStat {
  icon: LucideIcon;
  value: string;
  label: string;
}

interface ExploreHeroProps {
  badge: string;
  title: React.ReactNode;
  description: string;
  stats?: ExploreHeroStat[];
  /** Optional search slot rendered below the copy. */
  children?: React.ReactNode;
  containerClassName?: string;
}

// Shared dark hero for the explore verticals. No "use client": it must stay
// renderable from both RSC pages and client pages, so icon props cross no
// serialization boundary. Keep dark — these routes are in Navbar darkHeroPages.
export function ExploreHero({
  badge,
  title,
  description,
  stats,
  children,
  containerClassName = "max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12",
}: ExploreHeroProps) {
  return (
    <section className="relative pt-28 pb-14 bg-zinc-950 overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
      </div>
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className={`${containerClassName} relative z-10`}>
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-8">
            <Sparkles className="w-4 h-4 text-white" />
            <span className="text-sm font-medium text-zinc-300">{badge}</span>
          </div>

          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight text-white mb-6">
            {title}
          </h1>

          <p className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto">
            {description}
          </p>

          {stats && stats.length > 0 && (
            <div className="flex flex-wrap justify-center gap-8 md:gap-16 mt-12">
              {stats.map((stat) => (
                <div key={stat.label} className="text-center">
                  <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50 flex items-center justify-center">
                    <stat.icon className="w-6 h-6 text-white" />
                  </div>
                  <div className="text-2xl md:text-3xl font-bold text-white">
                    {stat.value}
                  </div>
                  <div className="text-sm text-zinc-500">{stat.label}</div>
                </div>
              ))}
            </div>
          )}

          {children && <div className="mt-12">{children}</div>}
        </div>
      </div>
    </section>
  );
}
