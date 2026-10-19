"use client";

import { useSearchParams } from "next/navigation";

import { useListParams } from "@/hooks/useListParams";
import {
  INBOX_FILTER_KEYS,
  defaultInboxSort,
  inboxViewOf,
  type InboxFilterKey,
} from "@/lib/support/inbox-query";

/** The id of the queue's search box, so a shortcut can focus it. */
export const INBOX_SEARCH_INPUT_ID = "support-inbox-search";

/**
 * The queue's URL state: `{ q, sort, filters, page }`. The URL is the only
 * source of truth — the filter bar, the table's sort headers and the copy-link
 * button are all views over it.
 *
 * The default sort depends on the view (the urgency views read the SLA clock,
 * the rest read the last activity), so the view is read from the URL first and
 * handed to `useListParams` as the default.
 */
export function useInboxListParams() {
  const searchParams = useSearchParams();
  const view = inboxViewOf(searchParams.get("view"));
  return useListParams<InboxFilterKey>({
    filterKeys: INBOX_FILTER_KEYS,
    defaultSort: defaultInboxSort(view),
  });
}
