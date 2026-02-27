"use client";

import { Control, useController } from "react-hook-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import iso6391 from "iso-639-1";
import { cn } from "@/utils/tailwind";

const DEFAULT_LEVEL_OPTIONS = [
  "Beginner",
  "Intermediate",
  "Advanced",
  "Expert",
];

interface LanguageLevelFieldsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>;
  languageName?: string;
  levelName?: string;
  levelOptions?: string[];
  className?: string;
  gridCols?: 1 | 2;
}

export function LanguageLevelFields({
  control,
  languageName = "language",
  levelName = "level",
  levelOptions = DEFAULT_LEVEL_OPTIONS,
  className,
  gridCols = 2,
}: Readonly<LanguageLevelFieldsProps>) {
  const {
    field: languageField,
    fieldState: { error: languageError },
  } = useController({
    name: languageName,
    control,
    defaultValue: "English",
  });

  const {
    field: levelField,
    fieldState: { error: levelError },
  } = useController({
    name: levelName,
    control,
    defaultValue: "Beginner",
  });

  const languageNames = iso6391.getAllNames();

  return (
    <div
      className={cn(
        "grid gap-4",
        gridCols === 2 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1",
        className,
      )}
    >
      {/* Language Select */}
      <FormItem>
        <FormLabel>Language</FormLabel>
        <Select
          value={languageField.value}
          onValueChange={languageField.onChange}
        >
          <SelectTrigger className={cn(languageError && "border-destructive")}>
            <SelectValue placeholder="Select language" />
          </SelectTrigger>
          <SelectContent className="max-h-[200px]">
            {languageNames.map((langName) => (
              <SelectItem key={langName} value={langName}>
                {langName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {languageError && <FormMessage>{languageError.message}</FormMessage>}
      </FormItem>

      {/* Level Select */}
      <FormItem>
        <FormLabel>Level</FormLabel>
        <Select value={levelField.value} onValueChange={levelField.onChange}>
          <SelectTrigger className={cn(levelError && "border-destructive")}>
            <SelectValue placeholder="Select level" />
          </SelectTrigger>
          <SelectContent>
            {levelOptions.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {levelError && <FormMessage>{levelError.message}</FormMessage>}
      </FormItem>
    </div>
  );
}
