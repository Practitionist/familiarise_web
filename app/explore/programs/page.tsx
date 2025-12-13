"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RegistrationBadge } from "@/components/ui/registration-badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  LayoutGrid, 
  List, 
  Search, 
  GraduationCap, 
  Video, 
  Users, 
  Clock,
  ArrowRight,
  Filter,
  Sparkles
} from "lucide-react";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import {
  filterAndSortPrograms,
  getUniqueLevels,
  isClassProgram,
  Program,
  ProgramType,
  usePrograms,
} from "./utils";

const STATS = [
  { icon: GraduationCap, value: "500+", label: "Classes Available" },
  { icon: Video, value: "200+", label: "Live Webinars" },
  { icon: Users, value: "25K+", label: "Students Enrolled" },
];

export default function Programs() {
  const router = useRouter();
  const { data: session } = useSession();
  const userId = session?.user?.id;

  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [sortBy, setSortBy] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "grid">("grid");
  const [programType, setProgramType] = useState<ProgramType>("all");
  const observer = useRef<IntersectionObserver>();

  const { programs, isLoading, hasMore, loadMore } = usePrograms(programType, {
    userId,
  });

  const lastElementRef = useCallback(
    (node: HTMLDivElement) => {
      if (isLoading) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          loadMore();
        }
      });
      if (node) observer.current.observe(node);
    },
    [isLoading, hasMore, loadMore],
  );

  const handleProgramClick = (item: Program) => {
    if (isClassProgram(item)) {
      router.push(`/explore/programs/plans/classes/${item.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${item.id}`);
    }
  };

  const filteredAndSortedPrograms = filterAndSortPrograms(
    programs,
    searchTerm,
    selectedCategory,
    sortBy,
  );

  const uniqueLevels = getUniqueLevels(programs);

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
              <span className="text-sm font-medium text-zinc-300">Learn from the Best</span>
            </div>

            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6">
              Classes & <span className="silver-text">Webinars</span>
            </h1>

            <p className="text-lg md:text-xl text-zinc-400 mb-12 max-w-2xl mx-auto">
              Expand your knowledge with expert-led classes and live webinars. 
              Learn at your own pace or join interactive sessions.
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
                  <div className="text-2xl md:text-3xl font-bold text-white">{stat.value}</div>
                  <div className="text-sm text-zinc-500">{stat.label}</div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* Programs Section */}
      <section className="py-16 md:py-20">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12">
          {/* Filters Card */}
          <motion.div 
            className="bg-zinc-50 rounded-2xl p-6 border border-zinc-200 mb-12"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <div className="flex items-center gap-2 mb-6">
              <div className="w-10 h-10 rounded-xl bg-zinc-900 flex items-center justify-center">
                <Filter className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-zinc-900">Filter Programs</h3>
                <p className="text-sm text-zinc-500">Find the perfect program for you</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              {/* Type Filter */}
              <div>
                <Label className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-1.5 block">
                  Type
                </Label>
                <Select
                  value={programType}
                  onValueChange={(value: ProgramType) => setProgramType(value)}
                >
                  <SelectTrigger className="h-11 bg-white border-zinc-200 rounded-xl focus:ring-zinc-900">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Programs</SelectItem>
                    <SelectItem value="class">Classes Only</SelectItem>
                    <SelectItem value="webinar">Webinars Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Level Filter */}
              <div>
                <Label className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-1.5 block">
                  Level
                </Label>
                <Select
                  value={selectedCategory}
                  onValueChange={setSelectedCategory}
                >
                  <SelectTrigger className="h-11 bg-white border-zinc-200 rounded-xl focus:ring-zinc-900">
                    <SelectValue placeholder="All Levels" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Levels</SelectItem>
                    {uniqueLevels.map((level) => (
                      <SelectItem key={level} value={level?.toString() ?? ""}>
                        {level ?? "Unknown Level"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Sort Filter */}
              <div>
                <Label className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-1.5 block">
                  Sort By
                </Label>
                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger className="h-11 bg-white border-zinc-200 rounded-xl focus:ring-zinc-900">
                    <SelectValue placeholder="Select sorting" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="price-asc">Price: Low to High</SelectItem>
                    <SelectItem value="price-desc">Price: High to Low</SelectItem>
                    <SelectItem value="title-asc">Title: A to Z</SelectItem>
                    <SelectItem value="title-desc">Title: Z to A</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* View Mode */}
              <div>
                <Label className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-1.5 block">
                  View
                </Label>
                <div className="flex gap-2">
                  <Button
                    variant={viewMode === "grid" ? "default" : "outline"}
                    className={`flex-1 h-11 rounded-xl ${viewMode === "grid" ? "bg-zinc-900 hover:bg-zinc-800" : "border-zinc-200"}`}
                    onClick={() => setViewMode("grid")}
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </Button>
                  <Button
                    variant={viewMode === "list" ? "default" : "outline"}
                    className={`flex-1 h-11 rounded-xl ${viewMode === "list" ? "bg-zinc-900 hover:bg-zinc-800" : "border-zinc-200"}`}
                    onClick={() => setViewMode("list")}
                  >
                    <List className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Search */}
              <div className="sm:col-span-2 lg:col-span-1">
                <Label className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-1.5 block">
                  Search
                </Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
                  <Input
                    type="text"
                    placeholder="Search..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="h-11 pl-10 bg-white border-zinc-200 rounded-xl focus:ring-zinc-900"
                  />
                </div>
              </div>
            </div>
          </motion.div>

          {/* Programs Grid/List */}
          {viewMode === "grid" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {filteredAndSortedPrograms.map((item: Program, index: number) => (
                <motion.div
                  key={item.id}
                  ref={index === filteredAndSortedPrograms.length - 1 ? lastElementRef : null}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: index * 0.05 }}
                >
                  <div
                    className="group bg-white rounded-2xl overflow-hidden border border-zinc-200 hover:border-zinc-300 hover:shadow-xl transition-all duration-300 cursor-pointer h-full flex flex-col"
                    onClick={() => handleProgramClick(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleProgramClick(item);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`View details for ${item.title}`}
                  >
                    {/* Image */}
                    <div className="relative aspect-[16/10] overflow-hidden">
                      <Image
                        src={item.imageUrl}
                        alt={item.title}
                        fill
                        className="object-cover group-hover:scale-105 transition-transform duration-500"
                        sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                      />
                      <div className="absolute top-3 left-3 flex gap-2">
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          item.type === "class" 
                            ? "bg-zinc-900 text-white" 
                            : "bg-white text-zinc-900"
                        }`}>
                          {item.type === "class" ? "Class" : "Webinar"}
                        </span>
                        {item.isRegistered && (
                          <RegistrationBadge
                            type={isClassProgram(item) ? "class" : "webinar"}
                            compact
                          />
                        )}
                      </div>
                    </div>

                    {/* Content */}
                    <div className="p-5 flex-1 flex flex-col">
                      <h3 className="text-lg font-semibold text-zinc-900 mb-2 line-clamp-1 group-hover:text-zinc-700 transition-colors">
                        {item.title}
                      </h3>
                      <p className="text-sm text-zinc-500 mb-4 line-clamp-2 flex-1">
                        {item.description}
                      </p>

                      <div className="flex items-center justify-between pt-4 border-t border-zinc-100">
                        <div className="text-xl font-bold text-zinc-900">
                          ${item.price}
                        </div>
                        <div className="flex items-center gap-1 text-sm font-medium text-zinc-500 group-hover:text-zinc-900 transition-colors">
                          <span>View Details</span>
                          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredAndSortedPrograms.map((item: Program, index: number) => (
                <motion.div
                  key={item.id}
                  ref={index === filteredAndSortedPrograms.length - 1 ? lastElementRef : null}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: index * 0.05 }}
                >
                  <div
                    className="group bg-white rounded-2xl overflow-hidden border border-zinc-200 hover:border-zinc-300 hover:shadow-xl transition-all duration-300 cursor-pointer flex"
                    onClick={() => handleProgramClick(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleProgramClick(item);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`View details for ${item.title}`}
                  >
                    {/* Image */}
                    <div className="relative w-48 md:w-64 flex-shrink-0">
                      <Image
                        src={item.imageUrl}
                        alt={item.title}
                        fill
                        className="object-cover"
                        sizes="256px"
                      />
                      <div className="absolute top-3 left-3">
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          item.type === "class" 
                            ? "bg-zinc-900 text-white" 
                            : "bg-white text-zinc-900"
                        }`}>
                          {item.type === "class" ? "Class" : "Webinar"}
                        </span>
                      </div>
                    </div>

                    {/* Content */}
                    <div className="p-6 flex-1 flex flex-col justify-between">
                      <div>
                        <div className="flex items-start justify-between gap-4 mb-2">
                          <h3 className="text-lg font-semibold text-zinc-900 group-hover:text-zinc-700 transition-colors">
                            {item.title}
                          </h3>
                          {item.isRegistered && (
                            <RegistrationBadge
                              type={isClassProgram(item) ? "class" : "webinar"}
                              compact
                            />
                          )}
                        </div>
                        <p className="text-sm text-zinc-500 line-clamp-2">
                          {item.description}
                        </p>
                      </div>

                      <div className="flex items-center justify-between mt-4">
                        <div className="text-xl font-bold text-zinc-900">
                          ${item.price}
                        </div>
                        <Button
                          variant="outline"
                          className="rounded-xl border-zinc-300 hover:bg-zinc-50"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleProgramClick(item);
                          }}
                        >
                          View Details
                          <ArrowRight className="w-4 h-4 ml-2" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          )}

          {/* Empty State */}
          {filteredAndSortedPrograms.length === 0 && !isLoading && (
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
                No programs found
              </h3>
              <p className="text-zinc-500 max-w-md mx-auto">
                Try adjusting your filters or search terms to discover more programs
              </p>
            </motion.div>
          )}

          {/* Loading State */}
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 border-3 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
                <span className="text-zinc-500">Loading programs...</span>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
