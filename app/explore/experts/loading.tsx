import { Sparkles } from "lucide-react";

// The hero's static copy is rendered for real here — identical to the page's
// HeroSection — because a skeleton made only of pulsing boxes cannot fire
// First Contentful Paint (#1102): FCP needs text, an image, canvas or SVG.
// Only the data-dependent parts (stat values, the grid) stay as skeletons.
export default function Loading() {
  return (
    <main className="min-h-screen bg-background">
      <section className="relative pt-32 pb-20 bg-zinc-950 overflow-hidden">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12">
          <div className="max-w-4xl mx-auto text-center">
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
              Ready to level up? Our amazing mentors are here to guide you!
              Connect with industry experts who understand your journey.
            </p>

            <div className="flex flex-wrap justify-center gap-8 md:gap-16">
              {["Active Experts", "Average Rating", "Sessions Completed"].map(
                (label) => (
                  <div key={label} className="text-center">
                    <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50 animate-pulse" />
                    <div className="h-8 w-16 bg-zinc-800 rounded-lg mx-auto mb-1 animate-pulse" />
                    <div className="text-sm text-zinc-500">{label}</div>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </section>
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-72 bg-muted rounded-2xl animate-pulse"
            />
          ))}
        </div>
      </div>
    </main>
  );
}
