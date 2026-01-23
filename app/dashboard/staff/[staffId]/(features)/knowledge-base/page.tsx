"use client";

import { useState, useEffect } from "react";
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
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useToast } from "@/hooks/use-toast";

interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  order: number;
  _count: {
    articles: number;
  };
}

interface Article {
  id: string;
  title: string;
  slug: string;
  content: string;
  excerpt: string | null;
  status: string;
  viewCount: number;
  helpfulCount: number;
  createdAt: string;
  updatedAt: string;
  category: {
    id: string;
    name: string;
  };
}

interface FAQ {
  id: string;
  question: string;
  answer: string;
  category: string;
}

const getCategoryIcon = (iconName: string | null) => {
  switch (iconName) {
    case "BookOpen":
      return BookOpen;
    case "Video":
      return Video;
    default:
      return FileText;
  }
};

const getCategoryColor = (index: number) => {
  const colors = [
    "text-blue-600 bg-blue-50 dark:bg-blue-950",
    "text-emerald-600 bg-emerald-50 dark:bg-emerald-950",
    "text-amber-600 bg-amber-50 dark:bg-amber-950",
    "text-purple-600 bg-purple-50 dark:bg-purple-950",
    "text-red-600 bg-red-50 dark:bg-red-950",
    "text-pink-600 bg-pink-50 dark:bg-pink-950",
  ];
  return colors[index % colors.length];
};

export default function KnowledgeBasePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Data states
  const [categories, setCategories] = useState<Category[]>([]);
  const [popularArticles, setPopularArticles] = useState<Article[]>([]);
  const [recentArticles, setRecentArticles] = useState<Article[]>([]);
  const [searchResults, setSearchResults] = useState<Article[]>([]);
  const [faqs, setFaqs] = useState<FAQ[]>([]);

  // Loading states
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [loadingPopular, setLoadingPopular] = useState(true);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [loadingFaqs, setLoadingFaqs] = useState(true);

  const { toast } = useToast();

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Search when debounced query changes
  useEffect(() => {
    if (debouncedSearch.length >= 2) {
      searchArticles(debouncedSearch);
    } else {
      setSearchResults([]);
    }
  }, [debouncedSearch]);

  // Fetch categories
  const fetchCategories = async () => {
    try {
      setLoadingCategories(true);
      const response = await fetch("/api/staff/knowledge-base/categories");
      if (!response.ok) throw new Error("Failed to fetch categories");
      const data = await response.json();
      setCategories(data.categories || []);
    } catch (error) {
      console.error("Error fetching categories:", error);
      toast({
        title: "Error",
        description: "Failed to load categories",
        variant: "destructive",
      });
    } finally {
      setLoadingCategories(false);
    }
  };

  // Fetch popular articles
  const fetchPopularArticles = async () => {
    try {
      setLoadingPopular(true);
      const response = await fetch("/api/staff/knowledge-base/popular?limit=4");
      if (!response.ok) throw new Error("Failed to fetch popular articles");
      const data = await response.json();
      setPopularArticles(data.articles || []);
    } catch (error) {
      console.error("Error fetching popular articles:", error);
      toast({
        title: "Error",
        description: "Failed to load popular articles",
        variant: "destructive",
      });
    } finally {
      setLoadingPopular(false);
    }
  };

  // Fetch recent articles
  const fetchRecentArticles = async () => {
    try {
      setLoadingRecent(true);
      const response = await fetch("/api/staff/knowledge-base/recent?limit=3");
      if (!response.ok) throw new Error("Failed to fetch recent articles");
      const data = await response.json();
      setRecentArticles(data.articles || []);
    } catch (error) {
      console.error("Error fetching recent articles:", error);
      toast({
        title: "Error",
        description: "Failed to load recent articles",
        variant: "destructive",
      });
    } finally {
      setLoadingRecent(false);
    }
  };

  // Fetch FAQs
  const fetchFaqs = async () => {
    try {
      setLoadingFaqs(true);
      const response = await fetch("/api/staff/help/faqs");
      if (!response.ok) throw new Error("Failed to fetch FAQs");
      const data = await response.json();
      setFaqs(data.faqs || []);
    } catch (error) {
      console.error("Error fetching FAQs:", error);
    } finally {
      setLoadingFaqs(false);
    }
  };

  // Search articles
  const searchArticles = async (query: string) => {
    try {
      setLoadingSearch(true);
      const response = await fetch(
        `/api/staff/knowledge-base/search?q=${encodeURIComponent(query)}`
      );
      if (!response.ok) throw new Error("Failed to search articles");
      const data = await response.json();
      setSearchResults(data.articles || []);
    } catch (error) {
      console.error("Error searching articles:", error);
    } finally {
      setLoadingSearch(false);
    }
  };

  useEffect(() => {
    fetchCategories();
    fetchPopularArticles();
    fetchRecentArticles();
    fetchFaqs();
  }, []);

  // Check if an article is "new" (updated within last 7 days)
  const isNewArticle = (updatedAt: string) => {
    const updated = new Date(updatedAt);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return updated > sevenDaysAgo;
  };

  // Calculate average rating (helpfulCount / viewCount * 5)
  const getArticleRating = (article: Article) => {
    if (article.viewCount === 0) return 0;
    return Math.min(5, (article.helpfulCount / article.viewCount) * 10).toFixed(
      1
    );
  };

  const showSearchResults = debouncedSearch.length >= 2;

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
          {loadingSearch && (
            <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 h-5 w-5 animate-spin text-zinc-400" />
          )}
        </div>
      </div>

      {/* Search Results */}
      {showSearchResults && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Search Results for &quot;{debouncedSearch}&quot;
            </CardTitle>
            <CardDescription>
              {searchResults.length} article(s) found
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingSearch ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : searchResults.length === 0 ? (
              <p className="text-center text-zinc-500 py-8">
                No articles found matching your search
              </p>
            ) : (
              <div className="space-y-3">
                {searchResults.map((article) => (
                  <div
                    key={article.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <FileText className="h-5 w-5 text-zinc-400" />
                      <div>
                        <p className="font-medium">{article.title}</p>
                        <p className="text-sm text-zinc-500">
                          {article.category.name}
                        </p>
                        {article.excerpt && (
                          <p className="text-xs text-zinc-400 mt-1 line-clamp-1">
                            {article.excerpt}
                          </p>
                        )}
                      </div>
                    </div>
                    <ExternalLink className="h-4 w-4 text-zinc-400" />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Categories */}
      {!showSearchResults && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Categories</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchCategories}
              disabled={loadingCategories}
            >
              <RefreshCw
                className={`h-4 w-4 ${loadingCategories ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
          {loadingCategories ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : categories.length === 0 ? (
            <p className="text-center text-zinc-500 py-8">
              No categories available
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {categories.map((category, index) => {
                const Icon = getCategoryIcon(category.icon);
                return (
                  <Card
                    key={category.id}
                    className="cursor-pointer hover:shadow-md transition-shadow"
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <div
                          className={`p-2 rounded-lg ${getCategoryColor(index)}`}
                        >
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-medium">{category.name}</h3>
                          <p className="text-sm text-zinc-500">
                            {category._count.articles} articles
                          </p>
                        </div>
                        <ChevronRight className="h-5 w-5 text-zinc-400" />
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            {/* Popular Articles */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Star className="h-5 w-5 text-amber-500" />
                      Popular Articles
                    </CardTitle>
                    <CardDescription>
                      Most viewed resources this week
                    </CardDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={fetchPopularArticles}
                    disabled={loadingPopular}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${loadingPopular ? "animate-spin" : ""}`}
                    />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {loadingPopular ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
                  </div>
                ) : popularArticles.length === 0 ? (
                  <p className="text-center text-zinc-500 py-8">
                    No popular articles available
                  </p>
                ) : (
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
                              {article.category.name}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-zinc-500">
                          <span className="flex items-center gap-1">
                            <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
                            {getArticleRating(article)}
                          </span>
                          <span>{article.viewCount} views</span>
                          <ExternalLink className="h-4 w-4" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recent Updates */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Clock className="h-5 w-5 text-blue-500" />
                      Recent Updates
                    </CardTitle>
                    <CardDescription>
                      Latest documentation changes
                    </CardDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={fetchRecentArticles}
                    disabled={loadingRecent}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${loadingRecent ? "animate-spin" : ""}`}
                    />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {loadingRecent ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
                  </div>
                ) : recentArticles.length === 0 ? (
                  <p className="text-center text-zinc-500 py-8">
                    No recent articles
                  </p>
                ) : (
                  <div className="space-y-3">
                    {recentArticles.map((article) => (
                      <div
                        key={article.id}
                        className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer transition-colors"
                      >
                        <div className="flex items-start justify-between">
                          <p className="font-medium text-sm">{article.title}</p>
                          {isNewArticle(article.updatedAt) && (
                            <Badge className="bg-green-100 text-green-700">
                              New
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-zinc-500 mt-1">
                          {article.category.name} • Updated{" "}
                          {new Date(article.updatedAt).toLocaleDateString(
                            "en-IN",
                            {
                              day: "numeric",
                              month: "short",
                            }
                          )}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* FAQs */}
          <Card>
            <CardHeader>
              <CardTitle>Frequently Asked Questions</CardTitle>
              <CardDescription>
                Quick answers to common questions
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingFaqs ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
                </div>
              ) : faqs.length === 0 ? (
                <p className="text-center text-zinc-500 py-8">
                  No FAQs available
                </p>
              ) : (
                <Accordion type="single" collapsible className="w-full">
                  {faqs.map((faq) => (
                    <AccordionItem key={faq.id} value={faq.id}>
                      <AccordionTrigger className="text-left">
                        {faq.question}
                      </AccordionTrigger>
                      <AccordionContent className="text-zinc-600 dark:text-zinc-400">
                        {faq.answer}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              )}
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
        </>
      )}
    </div>
  );
}
