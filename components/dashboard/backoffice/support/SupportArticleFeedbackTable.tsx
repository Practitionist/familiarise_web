"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { z } from "zod";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SupportArticleFeedbackTally } from "@/schemas/support";

const ArticleFeedbackResponseSchema = z.object({
  data: z.object({ tallies: z.array(SupportArticleFeedbackTally) }),
});

type ArticleFeedbackTally = z.infer<typeof SupportArticleFeedbackTally>;

/**
 * The Help Center article votes, read by the support team.
 *
 * Ordered by the failures first (the server sorts that way), because the
 * article support needs to fix is the point of the table — not the one with
 * the most votes.
 */
export function SupportArticleFeedbackTable() {
  const query = useQuery({
    queryKey: ["staff-support-article-feedback"],
    queryFn: async (): Promise<ArticleFeedbackTally[]> => {
      const res = await fetch("/api/staff/support-article-feedbacks");
      if (!res.ok) throw new Error("Failed to fetch article feedback");
      return ArticleFeedbackResponseSchema.parse(await res.json()).data.tallies;
    },
  });

  const tallies = query.data ?? [];

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <ThumbsDown className="h-4 w-4 text-amber-600" /> Help Center article
          votes
        </CardTitle>
        <CardDescription>
          What readers said about each Help Center article. One vote per reader
          per article; the least helpful articles are listed first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <p className="text-sm text-destructive">
            Unable to load the article votes.
          </p>
        ) : query.isPending ? (
          <p className="text-sm text-muted-foreground">
            Loading article votes…
          </p>
        ) : tallies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reader has voted on a Help Center article yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Article
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Topic
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Helpful
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Not helpful
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Total
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Helpful rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {tallies.map((tally) => (
                  <tr
                    key={tally.articleKey}
                    className="border-b border-border/60"
                  >
                    <td className="py-2 pr-4">
                      {tally.category ? (
                        <Link
                          href={`/support/${tally.category}/${tally.articleKey}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium underline underline-offset-4"
                        >
                          {tally.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{tally.title}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {tally.categoryTitle}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="inline-flex items-center gap-1">
                        <ThumbsUp className="h-3.5 w-3.5 text-emerald-600" />
                        {tally.helpful}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="inline-flex items-center gap-1">
                        <ThumbsDown className="h-3.5 w-3.5 text-amber-600" />
                        {tally.notHelpful}
                      </span>
                    </td>
                    <td className="py-2 pr-4">{tally.total}</td>
                    <td className="py-2">
                      {tally.total === 0
                        ? "—"
                        : `${Math.round((tally.helpful / tally.total) * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
