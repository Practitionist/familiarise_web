"use client";

import React, { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { faqs, searchFAQs } from "../questions";

export function HelpTab() {
  const [searchQuery, setSearchQuery] = useState("");
  const filteredFaqs = searchQuery ? searchFAQs(searchQuery) : faqs;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="text-sm font-medium text-blue-600 mb-4">FAQs</div>
        <h1 className="text-4xl font-semibold text-[#1D2939] mb-6">
          What can we help you find?
        </h1>
        <div className="relative">
          <Input
            type="search"
            placeholder="Search"
            className="w-full max-w-md pl-10 py-2"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <svg
            className="absolute left-3 top-2.5 h-5 w-5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
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

      {/* FAQs */}
      <Accordion type="single" collapsible className="space-y-4">
        {filteredFaqs.map((faq) => (
          <AccordionItem
            key={faq.id}
            value={faq.id}
            className="border-b border-gray-200"
          >
            <AccordionTrigger className="text-base font-medium text-[#1D2939] hover:text-blue-600">
              {faq.question}
            </AccordionTrigger>
            <AccordionContent className="text-[#475467]">
              {faq.answer}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
