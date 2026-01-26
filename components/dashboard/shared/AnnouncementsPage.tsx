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

interface Announcement {
  id: string;
  title: string;
  content: string;
  isActive: boolean;
  startDate: string | null;
  endDate: string | null;
  backgroundColor: string;
  textColor: string;
  linkUrl: string | null;
  linkText: string | null;
  createdAt: string;
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

  const { data: announcements = [], isLoading } = useQuery({
    queryKey,
    queryFn: async (): Promise<Announcement[]> => {
      const response = await fetch(apiBasePath);
      const result = await response.json();
      return result.success ? result.data : [];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Announcement>) => {
      const response = await fetch(apiBasePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return response.json();
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
      return response.json();
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
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Announcement deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete announcement", variant: "destructive" });
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
      createMutation.mutate(data);
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
                      {announcement.isActive ? "Active" : "Inactive"}
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
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => deleteMutation.mutate(announcement.id)}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete
                  </Button>
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
