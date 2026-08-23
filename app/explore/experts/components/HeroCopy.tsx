import { Sparkles } from "lucide-react";

/** Static hero copy shared by the page's HeroSection and loading.tsx, so the
 *  loading state renders real text (skeletons cannot fire FCP, #1102)
 *  without duplicating the markup. */
export function ExpertsHeroCopy() {
  return (
    <>
      <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-8">
        <Sparkles className="w-4 h-4 text-white" />
        <span className="text-sm font-medium text-zinc-300">
          World-Class Mentorship
        </span>
      </div>

      <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight text-white mb-6">
        Meet Your Perfect <span className="silver-text">Mentor</span>
      </h1>

      <p className="text-lg md:text-xl text-zinc-400 mb-12 max-w-2xl mx-auto">
        Ready to level up? Our amazing mentors are here to guide you! Connect
        with industry experts who understand your journey.
      </p>
    </>
  );
}
