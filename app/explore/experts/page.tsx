import { Suspense } from "react";
import { Sparkles, Users, Star, TrendingUp } from "lucide-react";
import { FeaturedExperts } from "./components/FeaturedExperts";
import ExpertsInteractiveContent from "./ExpertsInteractiveContent";
import {
  getExpertsMetadata,
  getCuratedExperts,
} from "@/lib/data/explore-experts";

function HeroSection({
  totalConsultants,
  averageRating,
}: {
  totalConsultants: number;
  averageRating: number;
}) {
  const STATS = [
    {
      icon: Users,
      value: totalConsultants > 0 ? `${totalConsultants}` : "10K+",
      label: "Active Experts",
    },
    {
      icon: Star,
      value: averageRating > 0 ? averageRating.toFixed(1) : "4.9",
      label: "Average Rating",
    },
    { icon: TrendingUp, value: "50K+", label: "Sessions Completed" },
  ];

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
            {STATS.map((stat) => (
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
        </div>
      </div>
    </section>
  );
}

export default async function ExploreExperts() {
  const [metadata, featuredExperts, trendingExperts, newestExperts] =
    await Promise.all([
      getExpertsMetadata(),
      getCuratedExperts("rating", 5),
      getCuratedExperts("trending", 8),
      getCuratedExperts("newest", 8),
    ]);

  return (
    <main className="min-h-screen bg-background">
      <HeroSection
        totalConsultants={metadata.consultantMetadata.totalConsultants}
        averageRating={metadata.consultantMetadata.averageRating}
      />

      <FeaturedExperts experts={featuredExperts} isLoading={false} />

      <Suspense
        fallback={
          <div className="flex items-center justify-center py-32">
            <div className="w-8 h-8 border-3 border-muted border-t-foreground rounded-full animate-spin" />
          </div>
        }
      >
        <ExpertsInteractiveContent
          metadata={metadata}
          trendingExperts={trendingExperts}
          newestExperts={newestExperts}
        />
      </Suspense>
    </main>
  );
}
