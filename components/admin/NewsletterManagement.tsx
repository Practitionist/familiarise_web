"use client";

/**
 * Backoffice newsletter subscriber management.
 *
 * Lists every newsletter subscriber and is the one surface that sends a
 * broadcast: an audience filter with a count preview, a test send to the admin,
 * a warm-up send and a send to all matching. Gated by `newsletter.manage`.
 */

import { useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { NewsletterSource, NewsletterStatus } from "@prisma/client";
import { format } from "date-fns";
import { Download, Mail, Search, Send, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { newsletterStatusBadge } from "@/lib/labels/session-labels";
import { useToast } from "@/components/ui/use-toast";
import {
  BROADCAST_AUDIENCE_LIMIT,
  BROADCAST_ROLES,
  settledSendable,
  type BroadcastAudience,
} from "@/lib/newsletter/broadcast-audience";

const ALL = "all";
const PER_PAGE = 50;

type Subscriber = {
  id: string;
  email: string;
  name: string | null;
  status: NewsletterStatus;
  source: NewsletterSource;
  tags: string[];
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
};

type SubscribersResponse = {
  items: Subscriber[];
  total: number;
  page: number;
  perPage: number;
  stats: Record<NewsletterStatus, number>;
};

type Filters = {
  status: string;
  source: string;
  search: string;
  page: number;
};

function toQuery(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status !== ALL) params.set("status", filters.status);
  if (filters.source !== ALL) params.set("source", filters.source);
  if (filters.search) params.set("search", filters.search);
  params.set("page", String(filters.page));
  params.set("perPage", String(PER_PAGE));
  return params;
}

async function fetchSubscribers(
  filters: Filters,
): Promise<SubscribersResponse> {
  const response = await fetch(`/api/admin/newsletter?${toQuery(filters)}`);
  if (!response.ok) throw new Error("Failed to load subscribers");
  return response.json();
}

type AudiencePreview = {
  matching: number;
  sendable: number;
  skippedNoConsent: number;
  skippedSuppressed: number;
  skippedHeld: number;
  limit: number;
};

type SendMode = "test" | "warmup" | "all";

const ROLE_LABELS: Record<(typeof BROADCAST_ROLES)[number], string> = {
  LEARNER: "Learners (account, not an expert)",
  EXPERT: "Experts",
  NO_ACCOUNT: "No account",
};

async function postBroadcast<T>(body: unknown): Promise<T> {
  const response = await fetch("/api/admin/newsletter/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Failed to send");
  return payload as T;
}

function toAudience(
  sources: NewsletterSource[],
  tags: string,
  role: string,
): BroadcastAudience {
  const tagList = tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const chosenRole = BROADCAST_ROLES.find((value) => value === role);
  return {
    ...(sources.length > 0 ? { sources } : {}),
    ...(tagList.length > 0 ? { tags: tagList } : {}),
    ...(chosenRole ? { role: chosenRole } : {}),
  };
}

/** Human label for an enum member: USE_CASE_PAGE → Use case page. */
function humanize(value: string): string {
  const lower = value.toLowerCase().replaceAll("_", " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const COLUMNS: ResponsiveColumn<Subscriber>[] = [
  {
    key: "email",
    header: "Email",
    primary: true,
    cell: (row) => (
      <div>
        <p className="font-medium">{row.email}</p>
        {row.name && (
          <p className="text-xs text-muted-foreground">{row.name}</p>
        )}
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (row) => (
      <StatusBadge {...newsletterStatusBadge(row.status)} withDot size="sm" />
    ),
  },
  {
    key: "source",
    header: "Source",
    cell: (row) => (
      <span className="text-sm text-muted-foreground">
        {humanize(row.source)}
      </span>
    ),
  },
  {
    key: "tags",
    header: "Tags",
    cell: (row) =>
      row.tags.length > 0 ? (
        <span className="text-sm text-muted-foreground">
          {row.tags.join(", ")}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
  },
  {
    key: "joined",
    header: "Signed up",
    cell: (row) => format(new Date(row.createdAt), "MMM d, yyyy"),
  },
  {
    key: "confirmed",
    header: "Confirmed",
    cell: (row) =>
      row.confirmedAt ? format(new Date(row.confirmedAt), "MMM d, yyyy") : "—",
  },
];

export function NewsletterManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<Filters>({
    status: ALL,
    source: ALL,
    search: "",
    page: 1,
  });
  // Applied separately from the input so typing doesn't refetch per keystroke.
  const [searchDraft, setSearchDraft] = useState("");

  const [subject, setSubject] = useState("");
  const [htmlBody, setHtmlBody] = useState("");
  const [audienceSources, setAudienceSources] = useState<NewsletterSource[]>(
    [],
  );
  const [audienceTags, setAudienceTags] = useState("");
  // Applied on blur so the count preview does not refetch per keystroke.
  const [tagsDraft, setTagsDraft] = useState("");
  const [audienceRole, setAudienceRole] = useState(ALL);
  const [warmupLimit, setWarmupLimit] = useState(50);
  const audience = toAudience(audienceSources, audienceTags, audienceRole);
  // #1527 — staff triage the list; only admin sends (the route 403s otherwise).
  const canSend = useBackofficeCapability().can("newsletter.send");

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-newsletter", filters],
    queryFn: () => fetchSubscribers(filters),
    // Paging or filtering must not blank the stat cards while the next page loads.
    placeholderData: keepPreviousData,
  });

  const preview = useQuery({
    queryKey: ["admin-newsletter-audience", audience],
    queryFn: () =>
      postBroadcast<AudiencePreview>({ mode: "preview", audience }),
    enabled: canSend,
    placeholderData: keepPreviousData,
  });

  const broadcast = useMutation({
    mutationFn: (mode: SendMode) =>
      postBroadcast<{ sent: number; failed: number; total: number }>({
        mode,
        subject,
        htmlBody,
        ...(mode === "test" ? {} : { audience }),
        ...(mode === "warmup" ? { limit: warmupLimit } : {}),
      }),
    onSuccess: (result, mode) => {
      toast({
        title: mode === "test" ? "Test sent to you" : "Newsletter sent",
        description: `${result.sent} delivered, ${result.failed} failed, ${result.total} addressed.`,
      });
      if (mode === "test") return;
      setSubject("");
      setHtmlBody("");
      queryClient.invalidateQueries({ queryKey: ["admin-newsletter"] });
    },
    onError: (failure, mode) => {
      // Dialog sends show their failure inside the dialog, which stays open.
      if (mode !== "test") return;
      toast({
        title: "Test not sent",
        description: failure.message,
        variant: "destructive",
      });
    },
  });

  // Null while the count is stale, loading or failed; every send stays off until it settles.
  const settled = settledSendable(preview);
  const sendable = settled ?? 0;
  const previewReady = settled !== null;
  const sendAllLabel = previewReady
    ? `Send to all matching (${sendable})`
    : "Send to all matching";
  const overLimit = sendable > BROADCAST_AUDIENCE_LIMIT;
  const warmupCount = Math.min(warmupLimit, sendable);
  const messageReady = subject.trim() !== "" && htmlBody.trim() !== "";

  const stats = data?.stats;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const statCards: Array<{ label: string; value: number }> = stats
    ? [
        { label: "Subscribed", value: stats.SUBSCRIBED },
        { label: "Awaiting confirmation", value: stats.PENDING },
        { label: "Unsubscribed", value: stats.UNSUBSCRIBED },
        { label: "Bounced", value: stats.BOUNCED },
      ]
    : [];

  function renderSubscriberTable() {
    if (error) {
      return (
        <p className="py-8 text-center text-muted-foreground">
          Could not load subscribers.
        </p>
      );
    }
    if (isLoading) {
      return <Skeleton className="h-64 rounded-lg" />;
    }
    return (
      <ResponsiveTable<Subscriber>
        columns={COLUMNS}
        rows={items}
        getRowId={(row) => row.id}
        empty={
          <div className="py-8 text-center text-muted-foreground">
            No subscribers match these filters.
          </div>
        }
      />
    );
  }

  return (
    <>
      <DashboardHeader
        title="Newsletter"
        subtitle="Everyone signed up for the Familiarise newsletter"
        actions={
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/admin/newsletter?${toQuery(filters)}&format=csv`}>
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </a>
          </Button>
        }
      />

      <div className="p-4 sm:p-6 lg:p-8 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading
            ? Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-24 rounded-lg" />
              ))
            : statCards.map((card) => (
                <Card key={card.label}>
                  <CardContent className="pt-6">
                    <p className="text-sm text-muted-foreground">
                      {card.label}
                    </p>
                    <p className="text-2xl font-semibold mt-1">{card.value}</p>
                  </CardContent>
                </Card>
              ))}
        </div>

        {/* #1527 QA B13 — the send form sits above the 50-row list: as the
            last control on the page it ended flush with the viewport bottom,
            under the fixed cookie bar, which swallowed the click. */}
        {canSend && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Mail className="h-4 w-4" /> Send a newsletter
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="space-y-2">
                  <Label>Sources</Label>
                  <div className="space-y-1.5">
                    {Object.values(NewsletterSource).map((source) => (
                      <label
                        key={source}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          checked={audienceSources.includes(source)}
                          onCheckedChange={(checked) =>
                            setAudienceSources((prev) =>
                              checked === true
                                ? [...prev, source]
                                : prev.filter((value) => value !== source),
                            )
                          }
                        />
                        {humanize(source)}
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    None ticked means every source.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newsletter-role">Who</Label>
                  <Select value={audienceRole} onValueChange={setAudienceRole}>
                    <SelectTrigger id="newsletter-role">
                      <SelectValue placeholder="Everyone" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>Everyone</SelectItem>
                      {BROADCAST_ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newsletter-tags">Tags</Label>
                  <Input
                    id="newsletter-tags"
                    value={tagsDraft}
                    onChange={(event) => setTagsDraft(event.target.value)}
                    onBlur={() => setAudienceTags(tagsDraft)}
                    placeholder="beta, india"
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma separated; a subscriber with any of them matches.
                  </p>
                </div>
              </div>

              <p className="text-sm text-muted-foreground">
                {previewReady && preview.data
                  ? `${preview.data.sendable} sendable of ${preview.data.matching} confirmed subscribers matching (${preview.data.skippedNoConsent} without a live marketing consent, ${preview.data.skippedSuppressed} suppressed, ${preview.data.skippedHeld} held before launch).`
                  : "Counting the audience…"}{" "}
                An unsubscribe footer is appended automatically.
              </p>
              {overLimit && (
                <p className="text-sm text-destructive">
                  This audience is above {BROADCAST_AUDIENCE_LIMIT} recipients,
                  the most one broadcast sends. Narrow it or use a warm-up send.
                </p>
              )}
              {preview.error && (
                <p className="text-sm text-destructive">
                  The audience count did not load, so sending stays off until it
                  does.
                </p>
              )}

              <div className="space-y-2">
                <Label htmlFor="newsletter-subject">Subject</Label>
                <Input
                  id="newsletter-subject"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="What is new at Familiarise"
                  maxLength={200}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="newsletter-body">Body (HTML)</Label>
                <Textarea
                  id="newsletter-body"
                  value={htmlBody}
                  onChange={(event) => setHtmlBody(event.target.value)}
                  placeholder="<p>Hello…</p>"
                  rows={10}
                  className="font-mono text-sm"
                />
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <Button
                  variant="outline"
                  disabled={
                    broadcast.isPending || !messageReady || !previewReady
                  }
                  onClick={() => broadcast.mutate("test")}
                >
                  <Mail className="mr-2 h-4 w-4" /> Send test to me
                </Button>

                <div className="flex items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="newsletter-warmup" className="text-xs">
                      Warm-up size
                    </Label>
                    <Input
                      id="newsletter-warmup"
                      type="number"
                      min={1}
                      max={BROADCAST_AUDIENCE_LIMIT}
                      value={warmupLimit}
                      onChange={(event) =>
                        setWarmupLimit(
                          Math.min(
                            BROADCAST_AUDIENCE_LIMIT,
                            Math.max(1, Number(event.target.value) || 1),
                          ),
                        )
                      }
                      className="w-24"
                    />
                  </div>
                  <ConfirmDialog
                    trigger={
                      <Button
                        variant="secondary"
                        disabled={
                          broadcast.isPending ||
                          !messageReady ||
                          !previewReady ||
                          sendable === 0
                        }
                      >
                        Warm-up send (first {warmupCount})
                      </Button>
                    }
                    title={`Send to the ${warmupCount} most recently confirmed?`}
                    description={`"${subject.trim()}" goes out now to the ${warmupCount} subscribers in this audience who confirmed most recently. An email cannot be recalled.`}
                    confirmLabel="Send warm-up"
                    onConfirm={async () => {
                      await broadcast.mutateAsync("warmup");
                    }}
                  />
                </div>

                {/* A mass send is confirmed with its audience size. */}
                <ConfirmDialog
                  trigger={
                    <Button
                      disabled={
                        broadcast.isPending ||
                        !messageReady ||
                        !previewReady ||
                        sendable === 0 ||
                        overLimit
                      }
                    >
                      <Send className="mr-2 h-4 w-4" />
                      {broadcast.isPending ? "Sending…" : sendAllLabel}
                    </Button>
                  }
                  title={`Send to ${sendable} subscribers?`}
                  description={`"${subject.trim()}" goes out now to every sendable subscriber in this audience. An email cannot be recalled.`}
                  confirmLabel="Send newsletter"
                  onConfirm={async () => {
                    await broadcast.mutateAsync("all");
                  }}
                />
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" /> Subscribers
              {total > 0 && (
                <span className="text-sm font-normal text-muted-foreground">
                  ({total})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <form
                className="flex-1 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setFilters((prev) => ({
                    ...prev,
                    search: searchDraft,
                    page: 1,
                  }));
                }}
              >
                <Input
                  placeholder="Search by email or name"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                />
                <Button type="submit" variant="outline" size="icon">
                  <Search className="h-4 w-4" />
                </Button>
              </form>

              <Select
                value={filters.status}
                onValueChange={(value) =>
                  setFilters((prev) => ({ ...prev, status: value, page: 1 }))
                }
              >
                <SelectTrigger className="sm:w-48">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {Object.values(NewsletterStatus).map((status) => (
                    <SelectItem key={status} value={status}>
                      {humanize(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filters.source}
                onValueChange={(value) =>
                  setFilters((prev) => ({ ...prev, source: value, page: 1 }))
                }
              >
                <SelectTrigger className="sm:w-48">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All sources</SelectItem>
                  {Object.values(NewsletterSource).map((source) => (
                    <SelectItem key={source} value={source}>
                      {humanize(source)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {renderSubscriberTable()}

            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Page {filters.page} of {totalPages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={filters.page <= 1}
                    onClick={() =>
                      setFilters((prev) => ({ ...prev, page: prev.page - 1 }))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={filters.page >= totalPages}
                    onClick={() =>
                      setFilters((prev) => ({ ...prev, page: prev.page + 1 }))
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
