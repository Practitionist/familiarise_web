"use client";

import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Input } from "@/components/ui/input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  HelpCircle,
  Search,
  User,
  Calendar,
  Briefcase,
  Video,
  CreditCard,
  ChevronRight,
  MessageCircleQuestion,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import { type FAQ } from "./questions";

interface HelpTabProps {
  faqs: FAQ[];
}

// Category configuration with icons and colors
const categoryConfig: Record<
  string,
  { icon: typeof User; color: string; bgColor: string }
> = {
  Profile: {
    icon: User,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
  },
  Scheduling: {
    icon: Calendar,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
  },
  Services: {
    icon: Briefcase,
    color: "text-purple-600",
    bgColor: "bg-purple-50",
  },
  Meetings: {
    icon: Video,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
  },
  Payments: {
    icon: CreditCard,
    color: "text-rose-600",
    bgColor: "bg-rose-50",
  },
};

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.2,
      ease: "easeOut",
    },
  },
};

export function HelpTab({ faqs: initialFaqs }: Readonly<HelpTabProps>) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  // Get unique categories
  const categories = useMemo(() => {
    const categorySet = new Set(initialFaqs.map((faq) => faq.category));
    return Array.from(categorySet);
  }, [initialFaqs]);

  // Filter FAQs based on search and category
  const filteredFaqs = useMemo(() => {
    let result = initialFaqs;

    if (selectedCategory) {
      result = result.filter((faq) => faq.category === selectedCategory);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (faq) =>
          faq.question.toLowerCase().includes(query) ||
          faq.answer.toLowerCase().includes(query)
      );
    }

    return result;
  }, [initialFaqs, searchQuery, selectedCategory]);

  // Group FAQs by category
  const groupedFaqs = useMemo(() => {
    const groups: Record<string, FAQ[]> = {};
    filteredFaqs.forEach((faq) => {
      if (!groups[faq.category]) {
        groups[faq.category] = [];
      }
      groups[faq.category].push(faq);
    });
    return groups;
  }, [filteredFaqs]);

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Page Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-10"
        >
          <div className="flex items-center gap-4 mb-6">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-900">
              <HelpCircle className="h-7 w-7 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-zinc-900">Help Center</h1>
              <p className="text-zinc-500 mt-1">
                Find answers to common questions about using the platform
              </p>
            </div>
          </div>

          {/* Search Bar */}
          <div className="relative max-w-xl">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-400" />
            <Input
              type="search"
              placeholder="Search for help..."
              className="w-full pl-12 pr-4 py-3 h-12 text-base rounded-xl border-zinc-200 bg-zinc-50/50 focus:bg-white focus:ring-2 focus:ring-zinc-900/10 transition-all"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Category Filters */}
          <div className="flex flex-wrap items-center gap-2 mt-6">
            <button
              onClick={() => setSelectedCategory(null)}
              className={cn(
                "px-4 py-2 rounded-full text-sm font-medium transition-all",
                selectedCategory === null
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              )}
            >
              All Topics
            </button>
            {categories.map((category) => {
              const config = categoryConfig[category] || {
                icon: HelpCircle,
                color: "text-zinc-600",
                bgColor: "bg-zinc-50",
              };
              const Icon = config.icon;
              const isSelected = selectedCategory === category;

              return (
                <button
                  key={category}
                  onClick={() =>
                    setSelectedCategory(isSelected ? null : category)
                  }
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                    isSelected
                      ? "bg-zinc-900 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {category}
                </button>
              );
            })}
          </div>

          {/* Results count */}
          <div className="mt-4 text-sm text-zinc-500">
            {filteredFaqs.length} {filteredFaqs.length === 1 ? "result" : "results"} found
            {searchQuery && ` for "${searchQuery}"`}
            {selectedCategory && ` in ${selectedCategory}`}
          </div>
        </motion.div>

        {/* FAQ Content */}
        <AnimatePresence mode="wait">
          {filteredFaqs.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center justify-center py-16 text-center"
            >
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-zinc-100 mb-6">
                <MessageCircleQuestion className="h-10 w-10 text-zinc-400" />
              </div>
              <h3 className="text-lg font-semibold text-zinc-900 mb-2">
                No results found
              </h3>
              <p className="text-zinc-500 max-w-sm">
                We couldn't find any FAQs matching your search. Try adjusting
                your filters or search terms.
              </p>
              {(searchQuery || selectedCategory) && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setSelectedCategory(null);
                  }}
                  className="mt-4 px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
                >
                  Clear all filters
                </button>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="content"
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              className="space-y-8"
            >
              {Object.entries(groupedFaqs).map(([category, faqs]) => {
                const config = categoryConfig[category] || {
                  icon: HelpCircle,
                  color: "text-zinc-600",
                  bgColor: "bg-zinc-50",
                };
                const Icon = config.icon;

                return (
                  <motion.div
                    key={category}
                    variants={itemVariants}
                    className="bg-zinc-50/50 border border-zinc-100 rounded-2xl p-6"
                  >
                    {/* Category Header */}
                    <div className="flex items-center gap-3 mb-5">
                      <div
                        className={cn(
                          "flex h-10 w-10 items-center justify-center rounded-xl",
                          config.bgColor
                        )}
                      >
                        <Icon className={cn("h-5 w-5", config.color)} />
                      </div>
                      <div>
                        <h2 className="text-lg font-semibold text-zinc-900">
                          {category}
                        </h2>
                        <p className="text-sm text-zinc-500">
                          {faqs.length} {faqs.length === 1 ? "question" : "questions"}
                        </p>
                      </div>
                    </div>

                    {/* FAQ Items */}
                    <Accordion type="single" collapsible className="space-y-2">
                      {faqs.map((faq) => (
                        <AccordionItem
                          key={faq.id}
                          value={faq.id}
                          className="border border-zinc-200/60 rounded-xl bg-white overflow-hidden data-[state=open]:shadow-sm transition-shadow"
                        >
                          <AccordionTrigger className="px-5 py-4 text-left text-base font-medium text-zinc-900 hover:text-zinc-900 hover:no-underline hover:bg-zinc-50/50 [&[data-state=open]]:bg-zinc-50/50 transition-colors">
                            <div className="flex items-center gap-3 pr-4">
                              <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0 transition-transform duration-200 [[data-state=open]_&]:rotate-90" />
                              <span>{faq.question}</span>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-5 pb-5 pt-0">
                            <div className="pl-7 text-zinc-600 leading-relaxed">
                              {faq.answer}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer Help */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="mt-12 text-center py-8 border-t border-zinc-100"
        >
          <p className="text-zinc-500">
            Still have questions?{" "}
            <a
              href="mailto:support@familiarise.com"
              className="text-zinc-900 font-medium hover:underline"
            >
              Contact our support team
            </a>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
