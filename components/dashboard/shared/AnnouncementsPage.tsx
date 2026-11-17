"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Pencil, Megaphone, Loader2 } from "lucide-react";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  keepPreviousPageOnly,
  usePageWithinTotal,
} from "@/components/dashboard/shared/paged-list-filters";
import { readListBody } from "@/lib/backoffice/money-list-schemas";
import {
  announcementPageSchema,
  type Announcement,
} from "@/lib/backoffice/people-list-schemas";
import { OperatorTime } from "@/lib/time/operator-time";

const PAGE_SIZE = 20;

const ApiErrorSchema = z.object({ error: z.string().optional() });
const InboxAudienceSchema = z.object({
  data: z.object({ eligible: z.number().nullable(), cap: z.number() }),
});

export interface AnnouncementsPageProps {
  /** API base path for announcements, defaults to "/api/announcements" */
  apiBasePath?: string;
  /** Query key prefix for React Query caching */
  queryKeyPrefix?: string;
  /** Page title, defaults to "Announcements" */
  title?: string;
  /** Page description, defaults to "Manage site-wide announcements" */
  description?: string;
}

export function AnnouncementsPage({
  apiBasePath = "/api/announcements",
  queryKeyPrefix = "announcements",
  title = "Announcements",
  description = "Manage site-wide announcements",
}: AnnouncementsPageProps) {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] =
    useState<Announcement | null>(null);
  const [postToInbox, setPostToInbox] = useState(false);
  const [confirmedRuns, setConfirmedRuns] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const queryKey = [queryKeyPrefix];
  const listKey = [queryKeyPrefix, page] as const;

  const list = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      const response = await fetch(`${apiBasePath}/manage?${params}`);
      return readListBody(
        response,
        announcementPageSchema,
        "Could not load announcements.",
      );
    },
    placeholderData: keepPreviousPageOnly(listKey, 1),
  });
  const announcements = list.data?.data ?? [];
  // Only this page's own answer may clamp it, not the previous page's placeholder.
  usePageWithinTotal(
    page,
    setPage,
    list.isPlaceholderData ? undefined : list.data?.total,
    PAGE_SIZE,
  );
  const isLoading = list.isLoading;

  // Counted only when an inbox post is being considered. The hook stays mounted,
  // so an earlier count is kept while it refetches and must not be confirmable.
  const inboxAudience = useQuery({
    queryKey: [queryKeyPrefix, "inbox-audience"],
    enabled: isCreateOpen && postToInbox,
    gcTime: 0,
    queryFn: async () => {
      const response = await fetch(`${apiBasePath}/audience`);
      const parsed = InboxAudienceSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!response.ok || !parsed.success) {
        throw new Error("Could not count the inbox audience.");
      }
      return parsed.data.data;
    },
  });
  const eligible = inboxAudience.data?.eligible;
  const inboxPostReady =
    !postToInbox ||
    (confirmedRuns &&
      !inboxAudience.isFetching &&
      eligible !== undefined &&
      eligible !== null);

  const openCreate = (open: boolean) => {
    setIsCreateOpen(open);
    if (!open) {
      setPostToInbox(false);
      setConfirmedRuns(false);
    }
  };

  const createMutation = useMutation({
    mutationFn: async (
      data: Partial<Announcement> & { postToInbox: boolean },
    ) => {
      const response = await fetch(apiBasePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = ApiErrorSchema.safeParse(result);
        throw new Error(
          parsed.success && parsed.data.error
            ? parsed.data.error
            : "The announcement was not created.",
        );
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      openCreate(false);
      toast({ title: "Announcement created" });
    },
    onError: (error) => {
      toast({
        title: "Failed to create announcement",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: Partial<Announcement>;
    }) => {
      const response = await fetch(`${apiBasePath}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = ApiErrorSchema.safeParse(result);
        throw new Error(
          parsed.success && parsed.data.error
            ? parsed.data.error
            : "The announcement was not updated.",
        );
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setEditingAnnouncement(null);
      toast({ title: "Announcement updated" });
    },
    onError: (error) => {
      toast({
        title: "Failed to update announcement",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`${apiBasePath}/${id}`, {
        method: "DELETE",
      });
      // Shown inside the confirm dialog, which stays open.
      if (!response.ok) throw new Error("The announcement was not deleted.");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Announcement deleted" });
    },
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const data = {
      title: formData.get("title") as string,
      content: formData.get("content") as string,
      isActive: formData.get("isActive") === "on",
      backgroundColor: formData.get("backgroundColor") as string,
      textColor: formData.get("textColor") as string,
      linkUrl: (formData.get("linkUrl") as string) || null,
      linkText: (formData.get("linkText") as string) || null,
    };

    if (editingAnnouncement) {
      updateMutation.mutate({ id: editingAnnouncement.id, data });
    } else {
      createMutation.mutate({ ...data, postToInbox });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={openCreate}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Announcement
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>Create Announcement</DialogTitle>
                <DialogDescription>
                  Create a new site-wide announcement
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input id="title" name="title" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="content">Content</Label>
                  <Textarea id="content" name="content" required />
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="isActive" name="isActive" defaultChecked />
                  <Label htmlFor="isActive">Active</Label>
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="postToInbox"
                    checked={postToInbox}
                    onCheckedChange={(checked) => {
                      setPostToInbox(checked === true);
                      setConfirmedRuns(false);
                    }}
                    aria-describedby="postToInbox-help"
                    className="mt-0.5"
                  />
                  <div className="space-y-1">
                    <Label htmlFor="postToInbox">
                      Also post to every user&apos;s notification inbox
                    </Label>
                    <p
                      id="postToInbox-help"
                      className="text-xs text-muted-foreground"
                    >
                      Rings the bell for every user who allows in-app
                      notifications, right away. An inbox post cannot be
                      recalled, and later edits change only the banner.
                    </p>
                  </div>
                </div>
                {postToInbox && (
                  <div
                    className="space-y-2 rounded-md border p-3 text-sm"
                    aria-live="polite"
                  >
                    {inboxAudience.isPending || inboxAudience.isFetching ? (
                      <p className="text-muted-foreground">
                        Counting eligible users…
                      </p>
                    ) : inboxAudience.isError ? (
                      <p className="text-destructive">
                        {inboxAudience.error.message}
                      </p>
                    ) : inboxAudience.data.eligible === null ? (
                      <p className="text-destructive">
                        More than {inboxAudience.data.cap.toLocaleString()}{" "}
                        users are eligible, which is over the inbox limit.
                        Create the announcement without posting to inboxes.
                      </p>
                    ) : (
                      <div className="flex items-start gap-2">
                        <Checkbox
                          id="confirmInboxRuns"
                          checked={confirmedRuns}
                          onCheckedChange={(checked) =>
                            setConfirmedRuns(checked === true)
                          }
                          className="mt-0.5"
                        />
                        <Label htmlFor="confirmInboxRuns" className="leading-5">
                          Post to {inboxAudience.data.eligible.toLocaleString()}{" "}
                          eligible{" "}
                          {inboxAudience.data.eligible === 1 ? "user" : "users"}
                          . Each recipient uses one Novu workflow run from the
                          monthly quota.
                        </Label>
                      </div>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="backgroundColor">Background Color</Label>
                    <Input
                      id="backgroundColor"
                      name="backgroundColor"
                      type="color"
                      defaultValue="#000000"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="textColor">Text Color</Label>
                    <Input
                      id="textColor"
                      name="textColor"
                      type="color"
                      defaultValue="#FFFFFF"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="linkUrl">Link URL (optional)</Label>
                    <Input id="linkUrl" name="linkUrl" type="url" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="linkText">Link Text</Label>
                    <Input
                      id="linkText"
                      name="linkText"
                      placeholder="Learn more"
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => openCreate(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending || !inboxPostReady}
                >
                  {createMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <AnnouncementList
        isLoading={isLoading}
        isError={list.isError}
        onRetry={() => void list.refetch()}
        announcements={announcements}
        renderCard={(announcement) => (
          <AnnouncementCard
            key={announcement.id}
            announcement={announcement}
            onEdit={() => setEditingAnnouncement(announcement)}
            onToggle={() =>
              updateMutation.mutate({
                id: announcement.id,
                data: { isActive: !announcement.isActive },
              })
            }
            onDelete={async () => {
              await deleteMutation.mutateAsync(announcement.id);
            }}
          />
        )}
      />
      {/* Kept mounted on an empty page, so the operator can always page back. */}
      {!list.isError && (list.data?.total ?? 0) > 0 && (
        <TablePagination
          page={list.data?.page ?? page}
          pageSize={list.data?.limit ?? PAGE_SIZE}
          total={list.data?.total ?? 0}
          onPageChange={setPage}
        />
      )}

      {/* Edit Dialog */}
      <Dialog
        open={!!editingAnnouncement}
        onOpenChange={() => setEditingAnnouncement(null)}
      >
        <DialogContent>
          {editingAnnouncement && (
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>Edit Announcement</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-title">Title</Label>
                  <Input
                    id="edit-title"
                    name="title"
                    defaultValue={editingAnnouncement.title}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-content">Content</Label>
                  <Textarea
                    id="edit-content"
                    name="content"
                    defaultValue={editingAnnouncement.content}
                    required
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="edit-isActive"
                    name="isActive"
                    defaultChecked={editingAnnouncement.isActive}
                  />
                  <Label htmlFor="edit-isActive">Active</Label>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-backgroundColor">
                      Background Color
                    </Label>
                    <Input
                      id="edit-backgroundColor"
                      name="backgroundColor"
                      type="color"
                      defaultValue={
                        editingAnnouncement.backgroundColor ?? "#000000"
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-textColor">Text Color</Label>
                    <Input
                      id="edit-textColor"
                      name="textColor"
                      type="color"
                      defaultValue={editingAnnouncement.textColor ?? "#FFFFFF"}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-linkUrl">Link URL</Label>
                    <Input
                      id="edit-linkUrl"
                      name="linkUrl"
                      type="url"
                      defaultValue={editingAnnouncement.linkUrl || ""}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-linkText">Link Text</Label>
                    <Input
                      id="edit-linkText"
                      name="linkText"
                      defaultValue={editingAnnouncement.linkText || ""}
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingAnnouncement(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Save
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The list's one state at a time: loading, failed, empty or the cards. */
function AnnouncementList({
  isLoading,
  isError,
  onRetry,
  announcements,
  renderCard,
}: Readonly<{
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  announcements: Announcement[];
  renderCard: (announcement: Announcement) => React.ReactNode;
}>) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <p role="alert" className="text-sm text-destructive">
            Announcements could not load.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (announcements.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Megaphone className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No announcements yet</p>
        </CardContent>
      </Card>
    );
  }
  return <div className="space-y-4">{announcements.map(renderCard)}</div>;
}

/** One announcement, with its edit, activate and confirmed delete. */
function AnnouncementCard({
  announcement,
  onEdit,
  onToggle,
  onDelete,
}: Readonly<{
  announcement: Announcement;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => Promise<void>;
}>) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-lg">{announcement.title}</CardTitle>
            <CardDescription>
              Created{" "}
              <OperatorTime value={announcement.createdAt} kind="date" />
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge
              label={announcement.isActive ? "Active" : "Inactive"}
              tone={announcement.isActive ? "success" : "neutral"}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div
          className="p-3 rounded-lg mb-4 text-sm"
          style={{
            backgroundColor: announcement.backgroundColor ?? undefined,
            color: announcement.textColor ?? undefined,
          }}
        >
          {announcement.content}
          {announcement.linkUrl && (
            <span className="ml-2 underline">
              {announcement.linkText || "Learn more"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
          <Button variant="outline" size="sm" onClick={onToggle}>
            {announcement.isActive ? "Deactivate" : "Activate"}
          </Button>
          {/* A platform-wide delete is confirmed. */}
          <ConfirmDialog
            trigger={
              <Button variant="destructive" size="sm">
                <Trash2 className="h-4 w-4 mr-1" />
                Delete
              </Button>
            }
            title="Delete this announcement?"
            description={`"${announcement.title}" disappears for every user. This cannot be undone.`}
            confirmLabel="Delete"
            tone="destructive"
            onConfirm={onDelete}
          />
        </div>
      </CardContent>
    </Card>
  );
}
