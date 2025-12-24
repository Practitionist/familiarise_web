"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Domain, SubDomain, Tag } from "@prisma/client";
import { useState } from "react";
import { X, Filter, Layers, Tag as TagIcon, Clock } from "lucide-react";

interface FiltersSectionProps {
  metadata: {
    domains: Domain[];
    subdomains: SubDomain[];
    tags: Tag[];
  } | null;
  selectedDomain: string | null;
  setSelectedDomain: (value: string | null) => void;
  selectedSubdomain: string | null;
  setSelectedSubdomain: (value: string | null) => void;
  selectedTags: string[];
  setSelectedTags: (tags: string[]) => void;
  experienceYears: number;
  setExperienceYears: (years: number) => void;
}

export function FiltersSection({
  metadata,
  selectedDomain,
  setSelectedDomain,
  selectedSubdomain,
  setSelectedSubdomain,
  selectedTags,
  setSelectedTags,
  experienceYears,
  setExperienceYears,
}: FiltersSectionProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const handleDomainChange = (value: string) => {
    setSelectedDomain(value === "all" ? null : value);
    setSelectedSubdomain(null);
    setSelectedTags([]);
    setSearchTerm("");
  };

  const handleSubdomainChange = (value: string) => {
    setSelectedSubdomain(value === "all" ? null : value);
  };

  const handleTagSelect = (tag: string) => {
    if (!selectedTags.includes(tag)) {
      setSelectedTags([...selectedTags, tag]);
    }
    setIsDropdownOpen(false);
    setSearchTerm("");
  };

  const handleTagRemove = (tag: string) => {
    setSelectedTags(selectedTags.filter((t) => t !== tag));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
    setIsDropdownOpen(true);
  };

  const filteredTags =
    metadata?.tags.filter((tag) => {
      if (selectedDomain && tag.domainId !== selectedDomain) return false;
      if (!searchTerm) return true;
      if (selectedTags.includes(tag.name)) return false;
      return tag.name.toLowerCase().includes(searchTerm.toLowerCase());
    }) || [];

  return (
    <div className="bg-zinc-50 rounded-2xl p-6 border border-zinc-200">
      <div className="flex items-center gap-2 mb-6">
        <div className="w-10 h-10 rounded-xl bg-zinc-900 flex items-center justify-center">
          <Filter className="w-5 h-5 text-white" />
        </div>
        <div>
          <h3 className="font-semibold text-zinc-900">Filter Experts</h3>
          <p className="text-sm text-zinc-500">Refine your search</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Domain & Subdomain */}
        <div className="bg-white rounded-xl p-4 border border-zinc-200">
          <div className="flex items-center gap-2 mb-4">
            <Layers className="w-4 h-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-700">Category</span>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block mb-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                Domain
              </label>
              <Select
                value={selectedDomain || "all"}
                onValueChange={handleDomainChange}
              >
                <SelectTrigger className="w-full h-11 bg-zinc-50 border-zinc-200 rounded-lg focus:ring-zinc-900">
                  <SelectValue placeholder="All Domains" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Domains</SelectItem>
                  {metadata?.domains.map((domain) => (
                    <SelectItem key={domain.id} value={domain.id}>
                      {domain.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block mb-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                Subdomain
              </label>
              <Select
                disabled={!selectedDomain}
                value={selectedSubdomain || "all"}
                onValueChange={handleSubdomainChange}
              >
                <SelectTrigger className="w-full h-11 bg-zinc-50 border-zinc-200 rounded-lg focus:ring-zinc-900 disabled:opacity-50">
                  <SelectValue
                    placeholder={
                      selectedDomain ? "All Subdomains" : "Select domain first"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Subdomains</SelectItem>
                  {metadata?.subdomains
                    .filter(
                      (subdomain) => subdomain.domainId === selectedDomain,
                    )
                    .map((subdomain) => (
                      <SelectItem key={subdomain.id} value={subdomain.id}>
                        {subdomain.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Tags */}
        <div className="bg-white rounded-xl p-4 border border-zinc-200">
          <div className="flex items-center gap-2 mb-4">
            <TagIcon className="w-4 h-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-700">
              Skills & Tags
            </span>
          </div>
          <div>
            <label className="block mb-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wide">
              Search Tags
            </label>
            <div className="relative">
              <input
                className="w-full h-11 px-4 bg-zinc-50 border border-zinc-200 text-zinc-900 text-sm rounded-lg focus:ring-2 focus:ring-zinc-900 focus:border-transparent transition-all disabled:opacity-50"
                placeholder={
                  selectedDomain ? "Search skills..." : "Select domain first"
                }
                type="text"
                value={searchTerm}
                onChange={handleInputChange}
                onFocus={() => setIsDropdownOpen(true)}
                disabled={!selectedDomain}
              />
              {isDropdownOpen && filteredTags.length > 0 && (
                <div className="absolute z-20 w-full mt-2 bg-white border border-zinc-200 rounded-xl shadow-xl max-h-48 overflow-auto">
                  {filteredTags.map((tag) => (
                    <button
                      key={tag.id}
                      className="w-full px-4 py-2.5 text-left text-sm text-zinc-700 hover:bg-zinc-50 first:rounded-t-xl last:rounded-b-xl transition-colors"
                      onClick={() => handleTagSelect(tag.name)}
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selectedTags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {selectedTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 text-white text-xs font-medium rounded-full"
                  >
                    {tag}
                    <button
                      className="hover:bg-white/20 rounded-full p-0.5 transition-colors"
                      onClick={() => handleTagRemove(tag)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Experience */}
        <div className="bg-white rounded-xl p-4 border border-zinc-200">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-4 h-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-700">
              Experience
            </span>
          </div>
          <div>
            <label className="block mb-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wide">
              Minimum Years
            </label>
            <div className="mt-2">
              <input
                type="range"
                min="0"
                max="30"
                value={experienceYears}
                onChange={(e) => setExperienceYears(Number(e.target.value))}
                className="w-full h-2 bg-zinc-200 rounded-full appearance-none cursor-pointer accent-zinc-900"
              />
              <div className="flex justify-between mt-2 text-xs text-zinc-500">
                <span>0 yrs</span>
                <span>15 yrs</span>
                <span>30+ yrs</span>
              </div>
              <div className="text-center mt-4">
                <span className="inline-flex items-center px-4 py-2 bg-zinc-900 text-white rounded-full text-sm font-semibold">
                  {experienceYears === 30 ? "30+" : experienceYears} years
                  minimum
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
