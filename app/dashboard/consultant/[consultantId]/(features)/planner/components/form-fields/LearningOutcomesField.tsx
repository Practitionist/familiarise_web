"use client";

import { useState } from "react";
import { Control, useController } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { Plus, Trash2, GripVertical } from "lucide-react";
import { cn } from "@/utils/tailwind";

interface LearningOutcomesFieldProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>;
  name: string;
  label?: string;
  placeholder?: string;
  description?: string;
  maxItems?: number;
  className?: string;
}

export function LearningOutcomesField({
  control,
  name,
  label = "Learning Outcomes",
  placeholder = "e.g., Understand React hooks lifecycle",
  description = "What participants will be able to do after completion",
  maxItems = 10,
  className,
}: Readonly<LearningOutcomesFieldProps>) {
  const [newOutcome, setNewOutcome] = useState("");
  const [error, setError] = useState<string | null>(null);

  const {
    field,
    fieldState: { error: fieldError },
  } = useController({
    name,
    control,
    defaultValue: [],
  });

  const outcomes = (field.value as string[]) || [];

  const addOutcome = () => {
    if (!newOutcome.trim()) return;

    // Check for duplicates (case-insensitive)
    const isDuplicate = outcomes.some(
      (outcome) =>
        outcome.trim().toLowerCase() === newOutcome.trim().toLowerCase(),
    );

    if (isDuplicate) {
      setError("This learning outcome already exists");
      return;
    }

    if (outcomes.length >= maxItems) {
      setError(`Maximum ${maxItems} learning outcomes allowed`);
      return;
    }

    setError(null);
    field.onChange([...outcomes, newOutcome.trim()]);
    setNewOutcome("");
  };

  const removeOutcome = (index: number) => {
    const updated = outcomes.filter((_, i) => i !== index);
    field.onChange(updated);
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addOutcome();
    }
  };

  return (
    <FormItem className={className}>
      <FormLabel>{label}</FormLabel>
      {description && <FormDescription>{description}</FormDescription>}

      {/* Input row */}
      <div className="flex gap-2">
        <Input
          placeholder={placeholder}
          value={newOutcome}
          onChange={(e) => {
            setNewOutcome(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          className="flex-1"
        />
        <Button
          type="button"
          onClick={addOutcome}
          variant="secondary"
          size="icon"
          className="shrink-0"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Error message */}
      {error && <p className="text-sm text-destructive mt-1">{error}</p>}

      {/* Outcomes list */}
      {outcomes.length > 0 && (
        <div className="space-y-2 mt-3">
          {outcomes.map((outcome, index) => (
            <div
              key={`outcome-${index}-${outcome.slice(0, 10)}`}
              className={cn(
                "flex items-center gap-2 p-3 rounded-md",
                "bg-background border border-border/60",
                "hover:border-border hover:bg-muted/30 transition-colors",
                "group",
              )}
            >
              <GripVertical className="h-4 w-4 text-muted-foreground/50 shrink-0" />
              <span className="flex-1 text-sm">{outcome}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                onClick={() => removeOutcome(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {outcomes.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md mt-2">
          No learning outcomes added yet
        </div>
      )}

      {/* Counter */}
      <div className="flex justify-between items-center mt-2">
        <span className="text-xs text-muted-foreground">
          {outcomes.length} / {maxItems} outcomes
        </span>
      </div>

      {/* Form validation error */}
      {fieldError && <FormMessage>{fieldError.message}</FormMessage>}
    </FormItem>
  );
}
