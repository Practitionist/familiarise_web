import { Suspense } from "react";
import { Users, Star, TrendingUp } from "lucide-react";
import { ExploreHero } from "../components/ExploreHero";
import { FeaturedExperts } from "./components/FeaturedExperts";
import ExpertsInteractiveContent from "./ExpertsInteractiveContent";
import {
  getExpertsMetadata,
  getCuratedExperts,
  EMPTY_EXPERTS_METADATA,
} from "@/lib/data/explore-experts";
import {
  emptyOnTransientDbError,
  fallbackOnTransientDbError,
} from "@/lib/data/fail-open";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

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
    <ExploreHero
      badge="World-Class Mentorship"
      title={
        <>
          Meet Your Perfect <span className="silver-text">Mentor</span>
        </>
      }
      description="Ready to level up? Our amazing mentors are here to guide you! Connect with industry experts who understand your journey."
      stats={STATS}
    />
  );
}

export default async function ExploreExperts() {
  // Degrade gracefully: a heavy curated read that times out (cold query brushing
  // the pg query budget) renders an empty row instead of erroring the whole page.
  const [metadata, featuredExperts, trendingExperts, newestExperts] =
    await Promise.all([
      getExpertsMetadata().catch(
        fallbackOnTransientDbError("experts metadata", EMPTY_EXPERTS_METADATA),
      ),
      getCuratedExperts("rating", 5).catch(
        emptyOnTransientDbError("featured experts"),
      ),
      getCuratedExperts("trending", 8).catch(
        emptyOnTransientDbError("trending experts"),
      ),
      getCuratedExperts("newest", 8).catch(
        emptyOnTransientDbError("newest experts"),
      ),
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
