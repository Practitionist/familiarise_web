"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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

import { format } from "date-fns";
import {
  AnnouncementListResponseSchema,
  AnnouncementMutationResponseSchema,
  CreateAnnouncementSchema,
  UpdateAnnouncementSchema,
  type AnnouncementListItem as Announcement,
} from "@/schemas/announcements";

async function requireAnnouncementSuccess(response: Response) {
  const result = AnnouncementMutationResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!response.ok || !result.success || !result.data.success) {
    throw new Error(
      result.success
        ? (result.data.error ?? "Announcement request failed")
        : "Announcement request failed",
    );
  }
  return result.data;
}

function scheduleStatus(announcement: Announcement) {
  if (!announcement.isActive) return "Inactive";
  const now = Date.now();
  if (announcement.endDate && new Date(announcement.endDate).getTime() <= now)
    return "Expired";
  if (
    announcement.startDate &&
    new Date(announcement.startDate).getTime() > now
  )
    return "Scheduled";
  return "Active";
}

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
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const queryKey = [queryKeyPrefix];

  const {
    data: announcements = [],
    isLoading,
    error,
  } = useQuery({
    queryKey,
    queryFn: async (): Promise<Announcement[]> => {
      const response = await fetch(`${apiBasePath}?view=manage`);
      if (!response.ok) throw new Error("Failed to load announcements");
      return AnnouncementListResponseSchema.parse(await response.json()).data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Announcement>) => {
      const response = await fetch(apiBasePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return requireAnnouncementSuccess(response);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setIsCreateOpen(false);
      toast({ title: "Announcement created" });
    },
    onError: () => {
      toast({ title: "Failed to create announcement", variant: "destructive" });
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
      return requireAnnouncementSuccess(response);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setEditingAnnouncement(null);
      toast({ title: "Announcement updated" });
    },
    onError: () => {
      toast({ title: "Failed to update announcement", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`${apiBasePath}/${id}`, {
        method: "DELETE",
      });
      // Shown inside the confirm dialog, which stays open.
      if (!response.ok) throw new Error("The announcement was not deleted.");
      return requireAnnouncementSuccess(response);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Announcement deleted" });
    },
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    try {
      const dateField = (key: string) => {
        const raw = formData.get(key);
        return typeof raw === "string" && raw
          ? new Date(raw).toISOString()
          : null;
      };
      const data = {
        title: String(formData.get("title") ?? ""),
        content: String(formData.get("content") ?? ""),
        isActive: formData.get("isActive") === "on",
        backgroundColor: String(formData.get("backgroundColor") ?? "#000000"),
        textColor: String(formData.get("textColor") ?? "#FFFFFF"),
        linkUrl: String(formData.get("linkUrl") ?? "") || null,
        linkText: String(formData.get("linkText") ?? "") || null,
        startDate: dateField("startDate"),
        endDate: dateField("endDate"),
      };
      const result = (
        editingAnnouncement
          ? UpdateAnnouncementSchema
          : CreateAnnouncementSchema
      ).safeParse(data);
      if (!result.success) {
        toast({
          title: "Check the announcement",
          description: result.error.issues[0]?.message,
          variant: "destructive",
        });
        return;
      }
      if (editingAnnouncement)
        updateMutation.mutate({
          id: editingAnnouncement.id,
          data: result.data,
        });
      else createMutation.mutate(result.data);
    } catch {
      toast({
        title: "Enter valid announcement dates",
        variant: "destructive",
      });
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="startDate">Start (local time)</Label>
                    <Input
                      id="startDate"
                      name="startDate"
                      type="datetime-local"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="endDate">End (optional)</Label>
                    <Input id="endDate" name="endDate" type="datetime-local" />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Scheduled inbox notices are sent shortly after the start time.
                </p>
                <div className="flex items-center gap-2">
                  <Switch id="isActive" name="isActive" defaultChecked />
                  <Label htmlFor="isActive">Active</Label>
                </div>
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
                  onClick={() => setIsCreateOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending}>
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

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center">
            Announcements could not be loaded. Try again.
          </CardContent>
        </Card>
      ) : announcements.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Megaphone className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No announcements yet</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {announcements.map((announcement) => (
            <Card key={announcement.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-lg">
                      {announcement.title}
                    </CardTitle>
                    <CardDescription>
                      Created {formatDate(announcement.createdAt)}
                      {announcement.startDate &&
                        ` · Starts ${new Date(announcement.startDate).toLocaleString()}`}
                      {announcement.endDate &&
                        ` · Ends ${new Date(announcement.endDate).toLocaleString()}`}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${
                        announcement.isActive
                          ? "bg-green-100 text-green-700"
                          : "bg-zinc-100 text-zinc-700"
                      }`}
                    >
                      {scheduleStatus(announcement)}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div
                  className="p-3 rounded-lg mb-4 text-sm"
                  style={{
                    backgroundColor: announcement.backgroundColor,
                    color: announcement.textColor,
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingAnnouncement(announcement)}
                  >
                    <Pencil className="h-4 w-4 mr-1" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      updateMutation.mutate({
                        id: announcement.id,
                        data: { isActive: !announcement.isActive },
                      })
                    }
                  >
                    {announcement.isActive ? "Deactivate" : "Activate"}
                  </Button>
                  {/* #1527 Q10 — a platform-wide delete is confirmed. */}
                  <ConfirmDialog
                    trigger={
                      <Button variant="destructive" size="sm">
                        <Trash2 className="h-4 w-4 mr-1" />
                        Delete
                      </Button>
                    }
                    title="Delete this announcement?"
                    description={`"${announcement.title}" will be removed and its queued notices cancelled. Delivered inbox notices will remain.`}
                    confirmLabel="Delete"
                    tone="destructive"
                    onConfirm={async () => {
                      await deleteMutation.mutateAsync(announcement.id);
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-startDate">Start (local time)</Label>
                    <Input
                      id="edit-startDate"
                      name="startDate"
                      type="datetime-local"
                      defaultValue={
                        editingAnnouncement.startDate
                          ? format(
                              new Date(editingAnnouncement.startDate),
                              "yyyy-MM-dd'T'HH:mm",
                            )
                          : ""
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-endDate">End (optional)</Label>
                    <Input
                      id="edit-endDate"
                      name="endDate"
                      type="datetime-local"
                      defaultValue={
                        editingAnnouncement.endDate
                          ? format(
                              new Date(editingAnnouncement.endDate),
                              "yyyy-MM-dd'T'HH:mm",
                            )
                          : ""
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-linkUrl">Link URL (optional)</Label>
                    <Input
                      id="edit-linkUrl"
                      name="linkUrl"
                      type="url"
                      defaultValue={editingAnnouncement.linkUrl ?? ""}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-linkText">Link text</Label>
                    <Input
                      id="edit-linkText"
                      name="linkText"
                      defaultValue={editingAnnouncement.linkText ?? ""}
                    />
                  </div>
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
                      defaultValue={editingAnnouncement.backgroundColor}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-textColor">Text Color</Label>
                    <Input
                      id="edit-textColor"
                      name="textColor"
                      type="color"
                      defaultValue={editingAnnouncement.textColor}
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
