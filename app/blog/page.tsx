"use client";

import { ArrowRight, BookOpen, Clock, FileText, Sparkles } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface BlogPost {
  title: string;
  teaser: string;
  readTime: string;
}

const BLOG_SECTIONS: { category: string; posts: BlogPost[] }[] = [
  {
    category: "Career Growth",
    posts: [
      {
        title: "How to Break Into Product Companies From a Service Background",
        teaser:
          "The playbook that hundreds of engineers have used to make the switch — and what most advice gets wrong.",
        readTime: "8 min read",
      },
      {
        title: "Salary Negotiation: What Your Recruiter Won't Tell You",
        teaser:
          "Real comp data and negotiation scripts from professionals who've been on both sides of the table.",
        readTime: "9 min read",
      },
      {
        title: "The Career Ladder Is a Myth — Here's What Actually Works",
        teaser:
          "Why linear promotions are the exception, and how to build a career through lateral moves and leverage.",
        readTime: "7 min read",
      },
    ],
  },
  {
    category: "Interview Prep",
    posts: [
      {
        title: "The Mock Interview Mistake That Costs You Offers",
        teaser:
          "Why practicing alone isn't working, and how structured feedback from hiring managers changes everything.",
        readTime: "5 min read",
      },
      {
        title: "System Design Interviews: The Preparation That Actually Works",
        teaser:
          "Forget memorizing architectures. Learn the thinking framework that top candidates use.",
        readTime: "12 min read",
      },
      {
        title:
          "Behavioral Interviews: Stop Memorizing STAR, Start Telling Stories",
        teaser:
          "The difference between a rehearsed answer and a compelling one — with real examples.",
        readTime: "6 min read",
      },
    ],
  },
  {
    category: "Mentorship",
    posts: [
      {
        title: "One-Off Calls vs. Long-Term Mentorship: Which Do You Need?",
        teaser:
          "A framework for deciding when you need a quick answer versus an ongoing relationship.",
        readTime: "6 min read",
      },
      {
        title: "How to Get the Most Out of a 30-Minute Expert Session",
        teaser:
          "The preparation ritual, question framework, and follow-up system that maximizes every consultation.",
        readTime: "4 min read",
      },
      {
        title: "Finding the Right Mentor: It's Not About Pedigree",
        teaser:
          "Why the best mentor for you isn't always the most senior person — and how to identify the right fit.",
        readTime: "5 min read",
      },
    ],
  },
  {
    category: "Skill Building",
    posts: [
      {
        title: "The 90-Day Learning Roadmap: How to Actually Close Skill Gaps",
        teaser:
          "Stop collecting courses. Here's a structured approach to learning that sticks, with accountability built in.",
        readTime: "6 min read",
      },
      {
        title: "From Side Gig to Full-Time: A Guide to Going Independent",
        teaser:
          "How top experts built sustainable consulting businesses while keeping their day jobs.",
        readTime: "10 min read",
      },
      {
        title: "The Skills That Actually Matter in Your First 3 Years",
        teaser:
          "Senior engineers share what they wish they'd focused on early — and what turned out to be noise.",
        readTime: "7 min read",
      },
    ],
  },
];

const FEATURED_POST: BlogPost = {
  title: "The Complete Guide to Career Transitions in Tech",
  teaser:
    "Everything you need to know about switching roles, domains, or companies — from people who've done it. A deep dive into timelines, trade-offs, and the decisions that matter most.",
  readTime: "15 min read",
};

function EditorialPreviewCard({
  category,
  post,
}: {
  category: string;
  post: BlogPost;
}) {
  return (
    <article className="flex h-full flex-col justify-between rounded-2xl border border-border bg-card p-6 shadow-elevation-1 transition-all duration-200 hover:border-foreground/20 hover:shadow-elevation-2">
      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <Badge variant="secondary" className="text-xs font-medium">
            {category}
          </Badge>
          <Badge
            variant="outline"
            className="text-[11px] font-medium text-muted-foreground"
          >
            Coming Soon
          </Badge>
        </div>
        <h3 className="mb-2.5 text-lg font-semibold leading-snug tracking-tight text-foreground">
          {post.title}
        </h3>
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          {post.teaser}
        </p>
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-border pt-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          {post.readTime}
        </span>
        <span className="font-medium text-foreground/70">Editorial preview</span>
      </div>
    </article>
  );
}

export default function BlogPage() {
  return (
    <div className="w-full bg-background">
      {/* Dark Hero */}
      <section className="relative overflow-hidden bg-zinc-950 text-white pt-32 pb-20 md:pb-28">
        <div className="grid-pattern pointer-events-none absolute inset-0 opacity-20" />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[720px] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(255,255,255,0.08),transparent)]"
        />

        <div className="container relative z-10 mx-auto max-w-3xl px-4 text-center md:px-6">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-700/60 bg-zinc-900/80 px-4 py-1.5 text-sm text-zinc-300 backdrop-blur-sm">
            <Sparkles className="h-4 w-4 text-zinc-300" aria-hidden />
            <span>Editorial &amp; Playbooks · Coming Soon</span>
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl mb-6 font-bold tracking-tight">
            The Familiarise <span className="silver-text">Blog</span>
          </h1>
          <p className="mx-auto max-w-2xl text-lg leading-relaxed text-zinc-400 md:text-xl">
            Career advice, interview strategies, and expert insights — written
            by the practitioners you&apos;ll meet on the platform.
          </p>
        </div>
      </section>

      <main className="container mx-auto max-w-[1200px] space-y-16 px-4 py-16 md:px-6 md:py-24">
        {/* Featured / Top Story */}
        <section>
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-fluid-2xl md:text-fluid-3xl font-bold tracking-tight">
              Featured Playbook
            </h2>
          </div>
          <article className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1 md:p-10">
            <div className="grid items-center gap-8 md:grid-cols-12">
              <div className="md:col-span-8">
                <div className="mb-4 flex flex-wrap items-center gap-2.5">
                  <Badge variant="secondary" className="gap-1.5">
                    <BookOpen className="h-3.5 w-3.5" aria-hidden />
                    Deep Dive Guide
                  </Badge>
                  <Badge variant="outline" className="text-muted-foreground">
                    Coming Soon
                  </Badge>
                </div>
                <h3 className="text-fluid-2xl md:text-fluid-3xl mb-3 font-bold tracking-tight text-foreground">
                  {FEATURED_POST.title}
                </h3>
                <p className="mb-6 max-w-2xl text-base leading-relaxed text-muted-foreground">
                  {FEATURED_POST.teaser}
                </p>
                <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="h-4 w-4" aria-hidden />
                    {FEATURED_POST.readTime}
                  </span>
                  <span aria-hidden>•</span>
                  <span>Written with verified engineering &amp; PM mentors</span>
                </div>
              </div>
              <div className="flex flex-col justify-between rounded-xl border border-border bg-muted/60 p-6 md:col-span-4">
                <FileText className="mb-4 h-8 w-8 text-foreground" aria-hidden />
                <div>
                  <p className="font-semibold text-foreground">
                    In final editorial review
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Need tailored career transition guidance right away? Book a
                    1-on-1 session with a verified mentor.
                  </p>
                </div>
                <div className="mt-5">
                  <Button asChild variant="outline" size="sm" className="w-full">
                    <Link href="/use-cases/career-switchers">
                      Explore Career Switcher Path
                      <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </article>
        </section>

        {/* Category sections */}
        {BLOG_SECTIONS.map((section) => (
          <section key={section.category}>
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-fluid-2xl md:text-fluid-3xl font-bold tracking-tight">
                {section.category}
              </h2>
              <span className="text-sm text-muted-foreground">
                {section.posts.length} articles in progress
              </span>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {section.posts.map((post) => (
                <EditorialPreviewCard
                  key={post.title}
                  category={section.category}
                  post={post}
                />
              ))}
            </div>
          </section>
        ))}
      </main>

      {/* Dark Closing CTA Band */}
      <section className="relative overflow-hidden bg-zinc-950 py-20 text-white md:py-28">
        <div className="grid-pattern pointer-events-none absolute inset-0 opacity-20" />
        <div className="container relative z-10 mx-auto max-w-2xl px-4 text-center md:px-6">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
            <FileText className="h-6 w-6 text-zinc-300" aria-hidden />
          </div>
          <h2 className="text-fluid-3xl md:text-fluid-4xl mb-4 font-bold tracking-tight">
            We&apos;re writing the first articles now
          </h2>
          <p className="mb-8 text-base leading-relaxed text-zinc-400 md:text-lg">
            Real stories and tactical playbooks from the experts on our
            platform. Don&apos;t want to wait? Get direct 1-on-1 guidance from a
            verified practitioner today.
          </p>
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="h-12 rounded-xl bg-white px-8 text-zinc-900 hover:bg-zinc-100"
            >
              <Link href="/explore/experts">
                Explore Experts
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 rounded-xl border-zinc-700 bg-transparent px-8 text-white hover:bg-zinc-900 hover:text-white"
            >
              <Link href="/use-cases/career-switchers">
                Career Switcher Guide
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
