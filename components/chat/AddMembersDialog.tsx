"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import { Loader2Icon, SearchIcon, UserPlusIcon, XIcon } from "lucide-react";
import type { ConsulteeSearchResult } from "@/app/api/stream/search-consultees/route";

interface AddMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingMemberIds: string[];
  onMembersAdded: (userIds: string[]) => Promise<void>;
}

export const AddMembersDialog = ({
  open,
  onOpenChange,
  existingMemberIds,
  onMembersAdded,
}: AddMembersDialogProps) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [consultees, setConsultees] = useState<ConsulteeSearchResult[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const { toast } = useToast();

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setSearchTerm("");
      setConsultees([]);
      setSelectedIds(new Set());
      setHasSearched(false);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!open) return;

    const timeoutId = setTimeout(() => {
      searchConsultees();
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchTerm, open]);

  const searchConsultees = useCallback(async () => {
    setIsSearching(true);
    setHasSearched(true);

    try {
      const excludeParam = existingMemberIds.join(",");
      const response = await fetch(
        `/api/stream/search-consultees?term=${encodeURIComponent(searchTerm)}&exclude=${excludeParam}`,
      );

      if (!response.ok) {
        throw new Error("Failed to search consultees");
      }

      const data = await response.json();
      setConsultees(data.consultees || []);
    } catch (error) {
      console.error("Error searching consultees:", error);
      toast({
        title: "Error",
        description: "Failed to search consultees",
        variant: "destructive",
      });
    } finally {
      setIsSearching(false);
    }
  }, [searchTerm, existingMemberIds, toast]);

  const toggleSelection = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const removeSelection = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  };

  const handleAddMembers = async () => {
    if (selectedIds.size === 0) return;

    setIsAdding(true);
    try {
      await onMembersAdded(Array.from(selectedIds));
      onOpenChange(false);
    } catch (error) {
      console.error("Error adding members:", error);
      toast({
        title: "Error",
        description: "Failed to add some members",
        variant: "destructive",
      });
    } finally {
      setIsAdding(false);
    }
  };

  const getRelationshipLabel = (
    type: ConsulteeSearchResult["relationshipType"],
  ) => {
    switch (type) {
      case "consultation":
        return "Consultation";
      case "subscription":
        return "Subscription";
      case "webinar":
        return "Webinar";
      case "class":
        return "Class";
      default:
        return "";
    }
  };

  const selectedConsultees = consultees.filter((c) => selectedIds.has(c.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlusIcon className="h-5 w-5" />
            Add Members
          </DialogTitle>
          <DialogDescription>
            Search and select consultees to add to this channel.
          </DialogDescription>
        </DialogHeader>

        {/* Search Input */}
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            type="text"
            placeholder="Search by name or email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Selected Users Badges */}
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap gap-2 p-2 bg-gray-50 rounded-md">
            <span className="text-xs text-gray-500 w-full mb-1">
              Selected ({selectedIds.size}):
            </span>
            {selectedConsultees.map((consultee) => (
              <span
                key={consultee.id}
                className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-sm"
              >
                {consultee.name || consultee.email}
                <button
                  onClick={() => removeSelection(consultee.id)}
                  className="hover:bg-blue-200 rounded-full p-0.5"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Search Results */}
        <div className="max-h-[250px] overflow-y-auto border rounded-md">
          {isSearching ? (
            <div className="flex items-center justify-center py-8">
              <Loader2Icon className="h-6 w-6 animate-spin text-gray-400" />
              <span className="ml-2 text-sm text-gray-500">Searching...</span>
            </div>
          ) : consultees.length === 0 ? (
            <div className="py-8 text-center text-gray-500 text-sm">
              {hasSearched
                ? "No consultees found. Try a different search term."
                : "Type to search for consultees"}
            </div>
          ) : (
            <div className="divide-y">
              {consultees.map((consultee) => {
                const isSelected = selectedIds.has(consultee.id);
                return (
                  <label
                    key={consultee.id}
                    className={`flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-50 ${
                      isSelected ? "bg-blue-50" : ""
                    }`}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelection(consultee.id)}
                    />
                    {/* Avatar */}
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center overflow-hidden flex-shrink-0">
                      {consultee.image ? (
                        <img
                          src={consultee.image}
                          alt={consultee.name || ""}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="text-sm font-medium text-gray-600">
                          {(consultee.name || consultee.email || "?")
                            .charAt(0)
                            .toUpperCase()}
                        </span>
                      )}
                    </div>
                    {/* Name and relationship */}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 truncate">
                        {consultee.name || "Unknown"}
                      </div>
                      <div className="text-xs text-gray-500">
                        {getRelationshipLabel(consultee.relationshipType)}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isAdding}
          >
            Cancel
          </Button>
          <Button
            onClick={handleAddMembers}
            disabled={selectedIds.size === 0 || isAdding}
          >
            {isAdding ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
                Adding...
              </>
            ) : (
              `Add ${selectedIds.size} Member${selectedIds.size !== 1 ? "s" : ""}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
