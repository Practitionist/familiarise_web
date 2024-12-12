"use client";

import { Input } from "@/components/ui/input";
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
  pricing: number;
  setPricing: (price: number) => void;
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
  pricing,
  setPricing,
}: FiltersSectionProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

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
    metadata?.tags.filter(
      (tag) =>
        tag.name.toLowerCase().includes(searchTerm.toLowerCase()) &&
        !selectedTags.includes(tag.name)
    ) || [];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
        <div>
          <label
            className="block mb-2 text-sm font-medium text-black dark:text-black"
            htmlFor="domain"
          >
            Domain
          </label>
          <Select onValueChange={(value) => setSelectedDomain(value)}>
            <SelectTrigger id="domain" aria-label="Select domain">
              <SelectValue placeholder="Select domain" />
            </SelectTrigger>
            <SelectContent>
              {metadata?.domains.map((domain) => (
                <SelectItem
                  key={domain.id}
                  value={domain.id}
                  className="bg-slate-200 text-black"
                >
                  {domain.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-4">
          <label
            className="block mb-2 text-sm font-medium text-black dark:text-black"
            htmlFor="subdomain"
          >
            Subdomain
          </label>
          <Select
            disabled={!selectedDomain}
            onValueChange={(value) => setSelectedSubdomain(value)}
          >
            <SelectTrigger id="subdomain" aria-label="Select subdomain">
              <SelectValue placeholder="Select subdomain" />
            </SelectTrigger>
            <SelectContent>
              {metadata?.subdomains
                .filter((subdomain) => subdomain.domainId === selectedDomain)
                .map((subdomain) => (
                  <SelectItem
                    key={subdomain.id}
                    value={subdomain.id}
                    className="bg-slate-200 text-black"
                  >
                    {subdomain.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between bg-white text-black dark:border-gray-800">
        <div>
          <label
            className="block mb-2 text-sm font-medium text-black"
            htmlFor="tags"
          >
            Tags
          </label>
          <div className="relative">
            <input
              className="bg-white border border-gray-300 text-black text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5"
              id="tags"
              placeholder="Search tags..."
              type="text"
              value={searchTerm}
              onChange={handleInputChange}
              onFocus={() => setIsDropdownOpen(true)}
            />
            {isDropdownOpen && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg">
                <ul className="py-1 overflow-auto max-h-60">
                  {filteredTags.map((tag) => (
                    <li
                      key={tag.id}
                      className="px-3 py-2 hover:bg-gray-100 cursor-pointer text-black"
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
                className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-black"
              >
                {tag}
                <button
                  className="ml-2 inline-flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:text-gray-500"
                  onClick={() => handleTagRemove(tag)}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
        <div>
          <label
            className="block mb-2 text-sm font-medium text-black"
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
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
          />
          <div className="flex justify-between mt-2 text-sm text-gray-600">
            <span>0</span>
            <span>15</span>
            <span>30+</span>
          </div>
          <div className="text-center mt-2 font-semibold text-lg">
            {experienceYears === 30 ? "30+" : experienceYears} years
          </div>
        </div>
      </div>
      <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
        <div>
          <label
            className="block mb-2 text-sm font-medium text-black"
            htmlFor="pricing"
          >
            Pricing (per hour)
          </label>
          <input
            type="range"
            min="0"
            max="1000"
            step="10"
            value={pricing}
            onChange={(e) => setPricing(Number(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
          />
          <div className="flex justify-between mt-2 text-sm text-gray-600">
            <span>$0</span>
            <span>$500</span>
            <span>$1000+</span>
          </div>
          <div className="text-center mt-2 font-semibold text-lg">
            ${pricing === 1000 ? "1000+" : pricing}
          </div>
        </div>
      </div>
    </div>
  );
}
