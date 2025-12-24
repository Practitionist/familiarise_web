"use client";

import { useState, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { Search, Sparkles, Users, Star, TrendingUp } from "lucide-react";
import { TConsultantProfile } from "@/types/consultant";
import { FiltersSection } from "./components/FiltersSection";
import { ConsultantCard } from "./components/ConsultantCard";
import { FeaturedExperts } from "./components/FeaturedExperts";
import { SatisfiedTestimonial } from "./components/SatisfiedTestimonial";
import { SearchBar, SortOption } from "./components/SearchBar";
import {
  useConsultantsMetadata,
  useConsultants,
  groupConsultantsByDomain,
} from "./utils";

const STATS = [
  { icon: Users, value: "10K+", label: "Active Experts" },
  { icon: Star, value: "4.9", label: "Average Rating" },
  { icon: TrendingUp, value: "50K+", label: "Sessions Completed" },
];

function FindExperts() {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [experienceYears, setExperienceYears] = useState(0);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedSubdomain, setSelectedSubdomain] = useState<string | null>(
    null,
  );
  const [sortBy, setSortBy] = useState<SortOption>("nameAsc");

  const {
    metadata,
    isLoading: isLoadingMetadata,
    refresh: _refreshMetadata,
  } = useConsultantsMetadata();

  const {
    consultants,
    isLoading: isLoadingConsultants,
    isLoadingMore,
    hasMore,
    loadMore,
    refresh: refreshConsultants,
  } = useConsultants({
    selectedDomain,
    selectedSubdomain,
    selectedTags,
    experienceYears,
    searchTerm,
    sortBy,
  });

  const observer = useRef<IntersectionObserver | null>(null);
  const lastConsultantRef = useCallback(
    (node: HTMLDivElement) => {
      if (isLoadingMore) return;
      if (observer.current) observer.current.disconnect();

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          loadMore();
        }
      });

      if (node) observer.current.observe(node);
    },
    [isLoadingMore, hasMore, loadMore],
  );

  const groupedConsultants = groupConsultantsByDomain(consultants);

  if (isLoadingMetadata) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
          <p className="text-zinc-500 text-sm">Loading experts...</p>
        </div>
      </div>
    );
  }

  return (
    <section className="py-16 md:py-20 bg-white">
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12">
        {/* Section Header */}
        <motion.div
          className="text-center mb-12"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-100 rounded-full mb-6">
            <Search className="w-4 h-4 text-zinc-600" />
            <span className="text-sm font-medium text-zinc-700">
              Find Your Expert
            </span>
          </div>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-zinc-900 mb-4">
            Browse All <span className="silver-text">Experts</span>
          </h2>
          <p className="text-lg text-zinc-600 max-w-2xl mx-auto">
            Use filters to find experts that match your specific needs and goals
          </p>
        </motion.div>

        {/* Filters */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          <FiltersSection
            metadata={metadata}
            selectedDomain={selectedDomain}
            setSelectedDomain={setSelectedDomain}
            selectedSubdomain={selectedSubdomain}
            setSelectedSubdomain={setSelectedSubdomain}
            selectedTags={selectedTags}
            setSelectedTags={setSelectedTags}
            experienceYears={experienceYears}
            setExperienceYears={setExperienceYears}
          />
        </motion.div>

        {/* Search Bar */}
        <motion.div
          className="mt-8"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          <SearchBar
            onSearch={(term) => {
              setSearchTerm(term);
              refreshConsultants();
            }}
            onSort={(option) => {
              setSortBy(option);
              refreshConsultants();
            }}
            sortBy={sortBy}
          />
        </motion.div>

        {/* Results */}
        <div className="mt-12 min-h-[400px] relative">
          {isLoadingConsultants ? (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm rounded-2xl">
              <div className="flex flex-col items-center gap-4">
                <div className="w-12 h-12 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
                <p className="text-zinc-500 text-sm">Finding experts...</p>
              </div>
            </div>
          ) : (
            <>
              {metadata?.domains.map((domain) => {
                const domainConsultants = groupedConsultants[domain.name] || [];

                if (domainConsultants.length === 0) return null;

                return (
                  <motion.div
                    key={domain.id}
                    className="mb-12"
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5 }}
                  >
                    <div className="flex items-center gap-3 mb-6">
                      <div className="w-1 h-8 bg-gradient-to-b from-zinc-900 to-zinc-400 rounded-full" />
                      <h3 className="text-2xl font-bold text-zinc-900">
                        {domain.name}
                      </h3>
                      <span className="px-3 py-1 bg-zinc-100 rounded-full text-sm text-zinc-600">
                        {domainConsultants.length} expert
                        {domainConsultants.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className="space-y-6">
                      {domainConsultants.map(
                        (consultant: TConsultantProfile, index: number) => {
                          if (domainConsultants.length === index + 1) {
                            return (
                              <div key={consultant.id} ref={lastConsultantRef}>
                                <ConsultantCard
                                  consultant={consultant}
                                  metadata={metadata}
                                />
                              </div>
                            );
                          }
                          return (
                            <ConsultantCard
                              key={consultant.id}
                              consultant={consultant}
                              metadata={metadata}
                            />
                          );
                        },
                      )}
                    </div>
                  </motion.div>
                );
              })}

              {consultants.length === 0 && (
                <motion.div
                  className="text-center py-16"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-zinc-100 flex items-center justify-center">
                    <Search className="w-10 h-10 text-zinc-400" />
                  </div>
                  <h3 className="text-xl font-semibold text-zinc-900 mb-2">
                    No experts found
                  </h3>
                  <p className="text-zinc-500 max-w-md mx-auto">
                    Try adjusting your filters or search terms to discover more
                    amazing mentors
                  </p>
                </motion.div>
              )}

              {isLoadingMore && (
                <div className="flex justify-center py-8">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 border-3 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
                    <span className="text-zinc-500 text-sm">
                      Loading more...
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export default function ExploreExperts() {
  return (
    <main className="min-h-screen bg-white">
      {/* Hero Section */}
      <section className="relative pt-32 pb-20 bg-zinc-950 overflow-hidden">
        {/* Background Effects */}
        <div className="absolute inset-0">
          <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
          <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
        </div>
        <div className="absolute inset-0 grid-pattern opacity-20" />

        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 relative z-10">
          <motion.div
            className="max-w-4xl mx-auto text-center"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-8">
              <Sparkles className="w-4 h-4 text-white" />
              <span className="text-sm font-medium text-zinc-300">
                World-Class Mentorship
              </span>
            </div>

            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6">
              Meet Your Perfect <span className="silver-text">Mentor</span>
            </h1>

            <p className="text-lg md:text-xl text-zinc-400 mb-12 max-w-2xl mx-auto">
              Ready to level up? Our amazing mentors are here to guide you!
              Connect with industry experts who understand your journey.
            </p>

            {/* Stats */}
            <div className="flex flex-wrap justify-center gap-8 md:gap-16">
              {STATS.map((stat, index) => (
                <motion.div
                  key={stat.label}
                  className="text-center"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.2 + index * 0.1 }}
                >
                  <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50 flex items-center justify-center">
                    <stat.icon className="w-6 h-6 text-white" />
                  </div>
                  <div className="text-2xl md:text-3xl font-bold text-white">
                    {stat.value}
                  </div>
                  <div className="text-sm text-zinc-500">{stat.label}</div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* Featured Experts */}
      <FeaturedExperts />

      {/* Find Experts Section */}
      <FindExperts />

      {/* Testimonial Section */}
      <SatisfiedTestimonial />
    </main>
  );
}
