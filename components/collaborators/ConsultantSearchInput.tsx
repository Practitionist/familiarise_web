"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, X, Loader2 } from "lucide-react";

interface ConsultantResult {
  id: string;
  user: {
    name: string | null;
    email: string;
    image: string | null;
  };
}

interface ConsultantSearchInputProps {
  excludeId?: string;
  onSelect: (consultantProfileId: string) => void;
}

export function ConsultantSearchInput({
  excludeId,
  onSelect,
}: ConsultantSearchInputProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConsultantResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState<ConsultantResult | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const search = useCallback(
    async (q: string) => {
      if (q.length < 1) {
        setResults([]);
        setIsOpen(false);
        return;
      }

      setIsLoading(true);
      try {
        const params = new URLSearchParams({ q });
        if (excludeId) params.set("excludeId", excludeId);

        const res = await fetch(`/api/consultants/search?${params}`);
        if (res.ok) {
          const { data } = await res.json();
          setResults(data);
          setIsOpen(data.length > 0);
        }
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    },
    [excludeId],
  );

  // Debounce search calls by 300ms
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (consultant: ConsultantResult) => {
    setSelected(consultant);
    setQuery("");
    setIsOpen(false);
    onSelect(consultant.id);
  };

  const handleClear = () => {
    setSelected(null);
    setQuery("");
    onSelect("");
  };

  if (selected) {
    return (
      <div className="flex items-center gap-3 p-2 border border-zinc-200 rounded-lg bg-zinc-50">
        <Avatar className="w-7 h-7">
          <AvatarImage src={selected.user.image ?? undefined} />
          <AvatarFallback className="text-xs">
            {(selected.user.name ?? "?").charAt(0)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-800 truncate">
            {selected.user.name ?? "Unknown"}
          </p>
          <p className="text-xs text-zinc-500 truncate">
            {selected.user.email}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-zinc-400 hover:text-zinc-600"
          onClick={handleClear}
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
        <Input
          placeholder="Search by name or email..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setIsOpen(true)}
          className="pl-8 pr-8"
        />
        {isLoading && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-zinc-400" />
        )}
      </div>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-zinc-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {results.map((consultant) => (
            <button
              key={consultant.id}
              type="button"
              className="flex items-center gap-3 w-full px-3 py-2 text-left hover:bg-zinc-50 transition-colors"
              onClick={() => handleSelect(consultant)}
            >
              <Avatar className="w-7 h-7">
                <AvatarImage src={consultant.user.image ?? undefined} />
                <AvatarFallback className="text-xs">
                  {(consultant.user.name ?? "?").charAt(0)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-800 truncate">
                  {consultant.user.name ?? "Unknown"}
                </p>
                <p className="text-xs text-zinc-500 truncate">
                  {consultant.user.email}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {isOpen && results.length === 0 && !isLoading && query.length >= 1 && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-zinc-200 rounded-lg shadow-lg p-3">
          <p className="text-sm text-zinc-500 text-center">
            No consultants found
          </p>
        </div>
      )}
    </div>
  );
}
