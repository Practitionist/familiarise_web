"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import type { TimelineItem } from "@/types/support-case";

const PageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      sender: z.enum(["USER", "BOT", "AGENT", "SYSTEM"]),
      body: z.string(),
      isInternal: z.boolean(),
      createdAt: z.string(),
    }),
  ),
  nextBeforeSeq: z.number().nullable(),
  hasMore: z.boolean(),
});

export function useCaseTimeline(
  caseId: string,
  latest: TimelineItem[],
  before: number | null | undefined,
  more: boolean | undefined,
) {
  const { toast } = useToast();
  const [older, setOlder] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [hasOlder, setHasOlder] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setOlder([]);
    setCursor(undefined);
    setHasOlder(undefined);
  }, [caseId]);
  const loadOlder = async () => {
    const next = cursor === undefined ? before : cursor;
    if (loading || next === null || next === undefined) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/support/cases/${caseId}/messages?beforeSeq=${next}&limit=100`,
      );
      if (!res.ok) await throwSupportError(res, "older messages");
      const page = PageSchema.parse(await res.json());
      setOlder((rows) => [
        ...page.data.map((m) => ({
          id: m.id,
          seq: m.seq,
          author: m.sender,
          authorName: null,
          body: m.body,
          internal: m.isInternal,
          at: m.createdAt,
        })),
        ...rows,
      ]);
      setCursor(page.nextBeforeSeq);
      setHasOlder(page.hasMore);
    } catch (error) {
      toast({
        title: "Older messages could not be loaded",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };
  const unique = new Map([...older, ...latest].map((m) => [m.id, m]));
  return {
    timeline: [...unique.values()],
    hasMore: hasOlder ?? more ?? false,
    loading,
    loadOlder,
  };
}
