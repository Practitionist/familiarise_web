"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search,
  BookOpen,
  FileText,
  Video,
  ExternalLink,
  ChevronRight,
  Bookmark,
  Clock,
  Star,
  FolderOpen,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

// Mock data
const categories = [
  {
    id: "1",
    name: "Getting Started",
    icon: BookOpen,
    articles: 8,
    color: "text-blue-600 bg-blue-50 dark:bg-blue-950",
  },
  {
    id: "2",
    name: "Support Procedures",
    icon: FileText,
    articles: 15,
    color: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950",
  },
  {
    id: "3",
    name: "Payment & Refunds",
    icon: FileText,
    articles: 12,
    color: "text-amber-600 bg-amber-50 dark:bg-amber-950",
  },
  {
    id: "4",
    name: "Technical Issues",
    icon: FileText,
    articles: 10,
    color: "text-purple-600 bg-purple-50 dark:bg-purple-950",
  },
  {
    id: "5",
    name: "Escalation Guidelines",
    icon: FileText,
    articles: 6,
    color: "text-red-600 bg-red-50 dark:bg-red-950",
  },
  {
    id: "6",
    name: "Video Tutorials",
    icon: Video,
    articles: 5,
    color: "text-pink-600 bg-pink-50 dark:bg-pink-950",
  },
];

const popularArticles = [
  {
    id: "1",
    title: "How to Process Refund Requests",
    category: "Payment & Refunds",
    views: 1250,
    rating: 4.8,
  },
  {
    id: "2",
    title: "Handling Consultant No-Shows",
    category: "Support Procedures",
    views: 980,
    rating: 4.6,
  },
  {
    id: "3",
    title: "Video Call Troubleshooting Guide",
    category: "Technical Issues",
    views: 856,
    rating: 4.9,
  },
  {
    id: "4",
    title: "When to Escalate to Admin",
    category: "Escalation Guidelines",
    views: 723,
    rating: 4.7,
  },
];

const recentArticles = [
  {
    id: "1",
    title: "New Ticket Categorization System",
    category: "Support Procedures",
    updatedAt: "2025-12-19",
    isNew: true,
  },
  {
    id: "2",
    title: "Updated Refund Policy Guidelines",
    category: "Payment & Refunds",
    updatedAt: "2025-12-18",
    isNew: true,
  },
  {
    id: "3",
    title: "Stream SDK Integration Guide",
    category: "Technical Issues",
    updatedAt: "2025-12-15",
    isNew: false,
  },
];

const faqs = [
  {
    question: "How do I assign a ticket to myself?",
    answer:
      "Navigate to the Support Tickets page, find the ticket you want to handle, click on the actions menu (three dots), and select 'Assign to me'. The ticket will then appear in your assigned tickets list.",
  },
  {
    question: "What is the standard response time for tickets?",
    answer:
      "High priority tickets should be responded to within 1 hour. Medium priority tickets within 4 hours. Low priority tickets within 24 hours. Always acknowledge the ticket first if you need more time to investigate.",
  },
  {
    question: "When should I escalate a ticket to admin?",
    answer:
      "Escalate to admin when: 1) The issue requires system-level changes, 2) Refund amount exceeds ₹10,000, 3) Legal/compliance issues are involved, 4) User is threatening legal action, 5) Issue persists after standard troubleshooting.",
  },
  {
    question: "How do I process a partial refund?",
    answer:
      "For partial refunds, go to the Payments section, find the transaction, click 'Process Refund', enter the partial amount with a reason. Partial refunds require admin approval for amounts over ₹5,000.",
  },
  {
    question: "What information do I need to verify a consultant profile?",
    answer:
      "Required documents include: 1) Government-issued ID, 2) Educational certificates, 3) Professional certifications (if claimed), 4) Proof of experience (employment letters, portfolio). Verify all documents are clear, valid, and match the profile information.",
  },
];

export default function KnowledgeBasePage() {
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Knowledge Base
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mt-2">
          Find answers, guides, and best practices for handling support requests
        </p>
        <div className="relative mt-6">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-400" />
          <Input
            placeholder="Search articles, guides, and FAQs..."
            className="pl-12 h-12 text-base"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Categories */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => (
          <Card
            key={category.id}
            className="cursor-pointer hover:shadow-md transition-shadow"
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${category.color}`}>
                  <category.icon className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <h3 className="font-medium">{category.name}</h3>
                  <p className="text-sm text-zinc-500">
                    {category.articles} articles
                  </p>
                </div>
                <ChevronRight className="h-5 w-5 text-zinc-400" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Popular Articles */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Star className="h-5 w-5 text-amber-500" />
              Popular Articles
            </CardTitle>
            <CardDescription>Most viewed resources this week</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {popularArticles.map((article) => (
                <div
                  key={article.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <FileText className="h-5 w-5 text-zinc-400" />
                    <div>
                      <p className="font-medium">{article.title}</p>
                      <p className="text-sm text-zinc-500">
                        {article.category}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-zinc-500">
                    <span className="flex items-center gap-1">
                      <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
                      {article.rating}
                    </span>
                    <span>{article.views} views</span>
                    <ExternalLink className="h-4 w-4" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Updates */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-blue-500" />
              Recent Updates
            </CardTitle>
            <CardDescription>Latest documentation changes</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentArticles.map((article) => (
                <div
                  key={article.id}
                  className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <p className="font-medium text-sm">{article.title}</p>
                    {article.isNew && (
                      <Badge className="bg-green-100 text-green-700">New</Badge>
                    )}
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">
                    {article.category} • Updated{" "}
                    {new Date(article.updatedAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                    })}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* FAQs */}
      <Card>
        <CardHeader>
          <CardTitle>Frequently Asked Questions</CardTitle>
          <CardDescription>Quick answers to common questions</CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq, index) => (
              <AccordionItem key={index} value={`item-${index}`}>
                <AccordionTrigger className="text-left">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-zinc-600 dark:text-zinc-400">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>

      {/* Quick Links */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Links</CardTitle>
          <CardDescription>Useful external resources</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Button variant="outline" className="justify-start gap-2">
              <Video className="h-4 w-4" />
              Training Videos
              <ExternalLink className="h-3 w-3 ml-auto" />
            </Button>
            <Button variant="outline" className="justify-start gap-2">
              <FileText className="h-4 w-4" />
              Policy Documents
              <ExternalLink className="h-3 w-3 ml-auto" />
            </Button>
            <Button variant="outline" className="justify-start gap-2">
              <FolderOpen className="h-4 w-4" />
              Template Library
              <ExternalLink className="h-3 w-3 ml-auto" />
            </Button>
            <Button variant="outline" className="justify-start gap-2">
              <Bookmark className="h-4 w-4" />
              Saved Articles
              <ExternalLink className="h-3 w-3 ml-auto" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
