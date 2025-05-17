"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LayoutGrid, List } from "lucide-react";
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

export default function Programs() {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [sortBy, setSortBy] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [programType, setProgramType] = useState<ProgramType>("all");
  const observer = useRef<IntersectionObserver>();

  const { programs, isLoading, hasMore, loadMore } = usePrograms(programType);

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
    if (item.type === "class") {
      router.push(`/explore/programs/classes/${item.id}`);
    } else {
      router.push(`/explore/programs/webinars/${item.id}`);
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
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-40 pb-32">
      <div className="mb-12 text-center">
        <h1 className="text-4xl font-bold mb-4 text-gray-900">
          Search Classes and Webinars
        </h1>
        <p className="text-lg text-gray-600">
          Find the perfect class or webinar to suit your needs.
        </p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 mb-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <div>
            <Label
              htmlFor="type"
              className="text-sm font-medium text-gray-700 mb-2"
            >
              Type
            </Label>
            <Select
              value={programType}
              onValueChange={(value: ProgramType) => setProgramType(value)}
            >
              <SelectTrigger
                id="type"
                className="w-full rounded-lg border-gray-200 bg-white"
              >
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Programs</SelectItem>
                <SelectItem value="class">Classes Only</SelectItem>
                <SelectItem value="webinar">Webinars Only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label
              htmlFor="category"
              className="text-sm font-medium text-gray-700 mb-2"
            >
              Level
            </Label>
            <Select
              value={selectedCategory}
              onValueChange={setSelectedCategory}
            >
              <SelectTrigger
                id="category"
                className="w-full rounded-lg border-gray-200 bg-white"
              >
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
          <div>
            <Label
              htmlFor="sort"
              className="text-sm font-medium text-gray-700 mb-2"
            >
              Sort By
            </Label>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger
                id="sort"
                className="w-full rounded-lg border-gray-200 bg-white"
              >
                <SelectValue placeholder="Select sorting option" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="price-asc">Price: Low to High</SelectItem>
                <SelectItem value="price-desc">Price: High to Low</SelectItem>
                <SelectItem value="title-asc">Title: A to Z</SelectItem>
                <SelectItem value="title-desc">Title: Z to A</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label
              htmlFor="view"
              className="text-sm font-medium text-gray-700 mb-2"
            >
              View Mode
            </Label>
            <Select
              value={viewMode}
              onValueChange={(value: "list" | "grid") => setViewMode(value)}
            >
              <SelectTrigger
                id="view"
                className="w-full rounded-lg border-gray-200 bg-white"
              >
                <SelectValue>
                  <div className="flex items-center gap-2">
                    {viewMode === "list" ? (
                      <>
                        <List className="h-4 w-4" />
                        <span>List</span>
                      </>
                    ) : (
                      <>
                        <LayoutGrid className="h-4 w-4" />
                        <span>Grid</span>
                      </>
                    )}
                  </div>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="list">
                  <div className="flex items-center gap-2">
                    <List className="h-4 w-4" />
                    <span>List</span>
                  </div>
                </SelectItem>
                <SelectItem value="grid">
                  <div className="flex items-center gap-2">
                    <LayoutGrid className="h-4 w-4" />
                    <span>Grid</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="relative">
          <Label htmlFor="search" className="sr-only">
            Search classes and webinars
          </Label>
          <Input
            id="search"
            type="text"
            placeholder="Search classes and webinars"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border-gray-200 bg-white pl-4 pr-12 py-3 text-sm focus:border-gray-300 focus:ring-gray-300"
            aria-label="Search classes and webinars"
          />
          <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none">
            <svg
              className="h-5 w-5 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
        </div>
      </div>

      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredAndSortedPrograms.map((item, index) => (
            <div
              key={item.id}
              ref={
                index === filteredAndSortedPrograms.length - 1
                  ? lastElementRef
                  : null
              }
              className="w-full text-left bg-white rounded-xl overflow-hidden shadow-sm border border-gray-100 cursor-pointer hover:shadow-md transition-all duration-300"
              onClick={() => handleProgramClick(item)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleProgramClick(item);
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`View details for ${isClassProgram(item) ? item.classPlan.title : item.webinarPlan.title}`}
            >
              <Image
                src={item.imageUrl}
                alt={
                  isClassProgram(item)
                    ? item.classPlan.title
                    : item.webinarPlan.title
                }
                width={600}
                height={400}
                className="w-full h-48 object-cover"
                style={{ aspectRatio: "600/400", objectFit: "cover" }}
              />
              <div className="p-6">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {isClassProgram(item)
                      ? item.classPlan.title
                      : item.webinarPlan.title}
                  </h3>
                  <output
                    className="bg-gray-100 text-gray-600 text-xs px-2.5 py-1 rounded-full font-medium inline-block"
                    aria-label={`Program type: ${item.type}`}
                  >
                    {item.type}
                  </output>
                </div>
                <p className="text-gray-600 text-sm mb-4 line-clamp-2">
                  {isClassProgram(item)
                    ? item.classPlan.description
                    : item.webinarPlan.description}
                </p>
                <div className="flex items-center justify-between">
                  <div className="text-gray-900 font-semibold">
                    $
                    {isClassProgram(item)
                      ? item.classPlan.price
                      : item.webinarPlan.price}
                  </div>
                  <Button
                    variant="outline"
                    className="text-sm border-gray-200 hover:bg-gray-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleProgramClick(item);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    Learn More
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredAndSortedPrograms.map((item, index) => (
            <div
              key={item.id}
              ref={
                index === filteredAndSortedPrograms.length - 1
                  ? lastElementRef
                  : null
              }
              className="w-full text-left bg-white rounded-xl overflow-hidden shadow-sm border border-gray-100 flex cursor-pointer hover:shadow-md transition-all duration-300"
              onClick={() => handleProgramClick(item)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleProgramClick(item);
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`View details for ${isClassProgram(item) ? item.classPlan.title : item.webinarPlan.title}`}
            >
              <Image
                src={item.imageUrl}
                alt={
                  isClassProgram(item)
                    ? item.classPlan.title
                    : item.webinarPlan.title
                }
                width={200}
                height={150}
                className="w-48 object-cover"
                style={{ aspectRatio: "200/150", objectFit: "cover" }}
              />
              <div className="p-6 flex-1">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {isClassProgram(item)
                      ? item.classPlan.title
                      : item.webinarPlan.title}
                  </h3>
                  <output
                    className="bg-gray-100 text-gray-600 text-xs px-2.5 py-1 rounded-full font-medium inline-block"
                    aria-label={`Program type: ${item.type}`}
                  >
                    {item.type}
                  </output>
                </div>
                <p className="text-gray-600 text-sm mb-4 line-clamp-2">
                  {isClassProgram(item)
                    ? item.classPlan.description
                    : item.webinarPlan.description}
                </p>
                <div className="flex items-center justify-between">
                  <div className="text-gray-900 font-semibold">
                    $
                    {isClassProgram(item)
                      ? item.classPlan.price
                      : item.webinarPlan.price}
                  </div>
                  <Button
                    variant="outline"
                    className="text-sm border-gray-200 hover:bg-gray-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleProgramClick(item);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    Learn More
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isLoading && (
        <div className="text-center py-8 text-gray-500">Loading more...</div>
      )}
    </div>
  );
}
