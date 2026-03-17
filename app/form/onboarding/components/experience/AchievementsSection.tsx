"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Pencil, Trash2, ExternalLink } from "lucide-react";
import { AddAchievementModal } from "./AddAchievementModal";

export interface Achievement {
  id: string;
  title: string;
  description?: string;
  url?: string;
  imageUrl?: string;
  achievementType: string;
}

interface AchievementsSectionProps {
  achievements: Achievement[];
  onUpdate: (achievements: Achievement[]) => void;
}

const ACHIEVEMENT_TYPE_LABELS: Record<string, string> = {
  AWARD: "Award",
  PUBLICATION: "Publication",
  PROJECT: "Project",
  TALK: "Talk / Conference",
  OPEN_SOURCE: "Open Source",
  OTHER: "Other",
};

export default function AchievementsSection({
  achievements,
  onUpdate,
}: AchievementsSectionProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAchievement, setEditingAchievement] =
    useState<Achievement | null>(null);

  const handleSave = (
    achievement: Achievement | Omit<Achievement, "id">,
  ) => {
    if ("id" in achievement && achievement.id) {
      // Editing: narrow union after runtime "id" in check — TS can't prove this
      onUpdate(
        achievements.map((a) =>
          a.id === achievement.id ? (achievement as Achievement) : a,
        ),
      );
      setEditingAchievement(null);
    } else {
      // Adding: spread + explicit id creates a full Achievement at runtime
      onUpdate([
        ...achievements,
        {
          ...achievement,
          id: `ach_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        } as Achievement,
      ]);
    }
    setIsModalOpen(false);
  };

  const handleEdit = (achievement: Achievement) => {
    setEditingAchievement(achievement);
    setIsModalOpen(true);
  };

  const handleDelete = (id: string) => {
    onUpdate(achievements.filter((a) => a.id !== id));
  };

  return (
    <div className="space-y-3">
      {achievements.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">
          No achievements added yet. Showcase your key accomplishments!
        </p>
      ) : (
        <div className="space-y-3">
          {achievements.map((achievement) => (
            <div
              key={achievement.id}
              className="flex items-start justify-between p-3 border rounded-lg"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="font-medium text-sm truncate">
                    {achievement.title}
                  </h4>
                  {achievement.url && (
                    <a
                      href={achievement.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary/80 flex-shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {ACHIEVEMENT_TYPE_LABELS[achievement.achievementType] ||
                    achievement.achievementType}
                </span>
                {achievement.description && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {achievement.description}
                  </p>
                )}
              </div>
              <div className="flex gap-1 ml-2 flex-shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handleEdit(achievement)}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(achievement.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setEditingAchievement(null);
          setIsModalOpen(true);
        }}
        className="w-full"
      >
        <Plus className="w-4 h-4 mr-2" />
        Add Achievement
      </Button>

      <AddAchievementModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingAchievement(null);
        }}
        onSave={handleSave}
        achievement={editingAchievement}
      />
    </div>
  );
}
