"use client";

interface DomainTabsProps {
  domains: { id: string; name: string }[];
  activeTab: string | null;
  onTabChange: (domainId: string | null) => void;
}

export default function DomainTabs({
  domains,
  activeTab,
  onTabChange,
}: DomainTabsProps) {
  return (
    <div
      className="flex gap-2 overflow-x-auto scrollbar-hide pb-2"
      style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
    >
      <button
        onClick={() => onTabChange(null)}
        className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
          activeTab === null
            ? "bg-zinc-900 text-white"
            : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
        }`}
      >
        All
      </button>
      {domains.map((domain) => (
        <button
          key={domain.id}
          onClick={() => onTabChange(domain.id)}
          className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
            activeTab === domain.id
              ? "bg-zinc-900 text-white"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
          }`}
        >
          {domain.name}
        </button>
      ))}
    </div>
  );
}
