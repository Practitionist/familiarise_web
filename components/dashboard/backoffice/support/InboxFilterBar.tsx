"use client";

import { Link2 } from "lucide-react";

import { FilterBar } from "@/components/dashboard/FilterBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { CASE_TOPICS, CASE_TOPIC_LABEL } from "@/lib/support/case-topic";
import { INBOX_STATUSES } from "@/lib/support/inbox-query";
import { humanizeEnum } from "@/lib/ui/tone";

import {
  INBOX_SEARCH_INPUT_ID,
  useInboxListParams,
} from "./useInboxListParams";

const ANY = "any";

/**
 * The queue's filters, bound to the URL keys in `INBOX_FILTER_KEYS`. The URL
 * is the only state: every control here writes a query parameter, so a
 * filtered queue is shareable by link and survives a reload.
 */
export function InboxFilterBar({
  className,
}: Readonly<{ className?: string }>) {
  const list = useInboxListParams();
  const f = list.filters;
  const { toast } = useToast();

  const setFilter =
    (key: "scope" | "status" | "priority" | "topic") => (value: string) =>
      list.setFilter(key, value === ANY ? null : value);

  const copyLink = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast({
        title: "Link copied",
        description: "This view's search, filters and sort are in the link.",
      });
    } catch {
      toast({
        title: "Couldn't copy the link",
        description: "Copy the address bar instead — it holds the same view.",
        variant: "destructive",
      });
    }
  };

  const clear = () =>
    list.setParams({
      q: "",
      filters: {
        scope: null,
        status: null,
        priority: null,
        topic: null,
        from: null,
        to: null,
      },
    });

  return (
    <FilterBar
      className={className}
      search={{
        label: "Search cases",
        placeholder: "Name, email, subject or reference",
        value: list.q,
        onChange: list.setQ,
        inputId: INBOX_SEARCH_INPUT_ID,
      }}
      chips={{
        label: "Status",
        options: INBOX_STATUSES.map((s) => ({
          value: s,
          label: humanizeEnum(s),
        })),
        value: f.status,
        onChange: (value) => list.setFilter("status", value),
        clearable: true,
      }}
      selects={[
        {
          key: "scope",
          label: "Kind",
          value: f.scope ?? ANY,
          options: [
            { value: ANY, label: "Session and platform" },
            { value: "session", label: "Session" },
            { value: "platform", label: "Platform" },
          ],
          onChange: setFilter("scope"),
        },
        {
          key: "priority",
          label: "Priority",
          value: f.priority ?? ANY,
          options: [
            { value: ANY, label: "Any priority" },
            { value: "URGENT", label: "Urgent" },
            { value: "HIGH", label: "High" },
            { value: "MEDIUM", label: "Medium" },
            { value: "LOW", label: "Low" },
          ],
          onChange: setFilter("priority"),
        },
        {
          key: "topic",
          label: "Category",
          value: f.topic ?? ANY,
          options: [
            { value: ANY, label: "Any category" },
            ...CASE_TOPICS.map((t) => ({
              value: t,
              label: CASE_TOPIC_LABEL[t],
            })),
          ],
          onChange: setFilter("topic"),
        },
      ]}
      onClear={clear}
      canClear={
        !!list.q ||
        f.scope !== null ||
        f.status !== null ||
        f.priority !== null ||
        f.topic !== null ||
        f.from !== null ||
        f.to !== null
      }
    >
      <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
        From
        <Input
          type="date"
          className="h-9 w-auto"
          value={f.from ?? ""}
          onChange={(e) => list.setFilter("from", e.target.value || null)}
        />
      </label>
      <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
        To
        <Input
          type="date"
          className="h-9 w-auto"
          value={f.to ?? ""}
          onChange={(e) => list.setFilter("to", e.target.value || null)}
        />
      </label>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9"
        onClick={() => void copyLink()}
      >
        <Link2 className="mr-1.5 h-4 w-4" aria-hidden />
        Copy link to this view
      </Button>
    </FilterBar>
  );
}
