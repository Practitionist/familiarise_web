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

function XIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
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

  // Filter tags based on selected domain and search term
  const filteredTags =
    metadata?.tags.filter((tag) => {
      if (selectedDomain && tag.domainId !== selectedDomain) return false;
      if (!searchTerm) return true;
      if (selectedTags.includes(tag.name)) return false;
      return tag.name.toLowerCase().includes(searchTerm.toLowerCase());
    }) || [];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <div className="bg-gradient-to-br from-gray-900/80 to-gray-800/60 border border-gray-800/50 rounded-3xl p-4 flex flex-col justify-between backdrop-blur-sm">
        <div>
          <label
            className="block mb-2 text-sm font-medium text-gray-300"
            htmlFor="domain"
          >
            Domain
          </label>
          <Select
            value={selectedDomain || "all"}
            onValueChange={handleDomainChange}
          >
            <SelectTrigger id="domain" aria-label="Select domain" className="bg-gray-800/50 border-gray-700 text-gray-100">
              <SelectValue placeholder="All Domains" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                All Domains
              </SelectItem>
              {metadata?.domains.map((domain) => (
                <SelectItem
                  key={domain.id}
                  value={domain.id}
                >
                  {domain.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-4">
          <label
            className="block mb-2 text-sm font-medium text-gray-300"
            htmlFor="subdomain"
          >
            Subdomain
          </label>
          <Select
            disabled={!selectedDomain}
            value={selectedSubdomain || "all"}
            onValueChange={handleSubdomainChange}
          >
            <SelectTrigger id="subdomain" aria-label="Select subdomain" className="bg-gray-800/50 border-gray-700 text-gray-100">
              <SelectValue
                placeholder={
                  selectedDomain ? "All Subdomains" : "Select a domain first"
                }
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                All Subdomains
              </SelectItem>
              {metadata?.subdomains
                .filter((subdomain) => subdomain.domainId === selectedDomain)
                .map((subdomain) => (
                  <SelectItem
                    key={subdomain.id}
                    value={subdomain.id}
                  >
                    {subdomain.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="bg-gradient-to-br from-gray-900/80 to-gray-800/60 border border-gray-800/50 rounded-3xl p-4 flex flex-col justify-between backdrop-blur-sm">
        <div>
          <label
            className="block mb-2 text-sm font-medium text-gray-300"
            htmlFor="tags"
          >
            Tags
          </label>
          <div className="relative">
            <input
              className="bg-gray-800/50 border border-gray-700 text-gray-100 text-sm rounded-lg focus:ring-gray-600 focus:border-gray-600 block w-full p-2.5 placeholder:text-gray-500"
              id="tags"
              placeholder={
                selectedDomain ? "Search tags..." : "Select a domain first"
              }
              type="text"
              value={searchTerm}
              onChange={handleInputChange}
              onFocus={() => setIsDropdownOpen(true)}
              disabled={!selectedDomain}
            />
            {isDropdownOpen && filteredTags.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-lg">
                <ul className="py-1 overflow-auto max-h-60">
                  {filteredTags.map((tag) => (
                    <li
                      key={tag.id}
                      className="px-3 py-2 hover:bg-gray-700 cursor-pointer text-gray-100"
                      onClick={() => handleTagSelect(tag.name)}
                    >
                      {tag.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            {selectedTags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full bg-gray-800/50 border border-gray-700/50 px-3 py-1 text-xs font-medium text-gray-300"
              >
                {tag}
                <button
                  className="ml-2 inline-flex h-4 w-4 items-center justify-center rounded-full text-gray-500 hover:text-gray-300"
                  onClick={() => handleTagRemove(tag)}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="bg-gradient-to-br from-gray-900/80 to-gray-800/60 border border-gray-800/50 rounded-3xl p-4 flex flex-col justify-between backdrop-blur-sm">
        <div>
          <label
            className="block mb-2 text-sm font-medium text-gray-300"
            htmlFor="experience"
          >
            Experience Years
          </label>
          <input
            type="range"
            min="0"
            max="30"
            value={experienceYears}
            onChange={(e) => setExperienceYears(Number(e.target.value))}
            className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between mt-2 text-sm text-gray-400">
            <span>0</span>
            <span>15</span>
            <span>30+</span>
          </div>
          <div className="text-center mt-2 font-semibold text-lg text-gray-100">
            {experienceYears === 30 ? "30+" : experienceYears} years
          </div>
        </div>
      </div>
    </div>
  );
}
