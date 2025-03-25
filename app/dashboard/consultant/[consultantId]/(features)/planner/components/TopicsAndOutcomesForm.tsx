"use client"

import { useState, useEffect, useRef } from "react"
import { Check, ChevronsUpDown, PlusCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { PlannerService } from "../services/planner"

interface TopicsAndOutcomesFormProps {
  selectedTopics: string[]
  onTopicsChange: (topics: string[]) => void
  learningOutcomes: string[]
  onOutcomesChange: (outcomes: string[]) => void
  className?: string
}

// List of common profanity words to filter out
const PROFANITY_LIST = ['badword1', 'badword2']; // Add actual words

// Function to clean and format topic text
function preprocessTopicText(text: string): string {
  // Remove extra whitespace and trim
  let processed = text.trim().replace(/\s+/g, ' ');
  
  // Convert to sentence case (first letter uppercase, rest lowercase)
  processed = processed.toLowerCase();
  processed = processed.charAt(0).toUpperCase() + processed.slice(1);
  
  // Remove any special characters except spaces and alphanumeric
  processed = processed.replace(/[^a-zA-Z0-9\s]/g, '');
  
  return processed;
}

// Function to check if text contains profanity
function containsProfanity(text: string): boolean {
  const lowerText = text.toLowerCase();
  return PROFANITY_LIST.some(word => lowerText.includes(word.toLowerCase()));
}

export function TopicsAndOutcomesForm({
  selectedTopics,
  onTopicsChange,
  learningOutcomes,
  onOutcomesChange,
  className
}: Readonly<TopicsAndOutcomesFormProps>) {
  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const [topics, setTopics] = useState<string[]>([])
  const [filteredTopics, setFilteredTopics] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [learningOutcomesText, setLearningOutcomesText] = useState(learningOutcomes.join("\n"))
  const [error, setError] = useState<string>("")

  // Debounce timer reference
  const debounceTimer = useRef<NodeJS.Timeout | null>(null)

  // Fetch topics on component mount and when input changes
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
    }

    debounceTimer.current = setTimeout(async () => {
      try {
        setIsLoading(true)
        const fetchedTopics = await PlannerService.getTopics(inputValue)
        const topicNames = fetchedTopics.map(topic => topic.name)
        setTopics(topicNames)
        setFilteredTopics(topicNames.filter(topic => !selectedTopics.includes(topic)))
      } catch (error) {
        console.error("Failed to fetch topics:", error)
      } finally {
        setIsLoading(false)
      }
    }, 300)

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
    }
  }, [inputValue, selectedTopics])

  // Add a topic (existing or new)
  const addTopic = (topic: string) => {
    if (!topic) return

    // Process the topic text if it's a new topic
    const processedTopic = preprocessTopicText(topic);

    // Validate the processed topic
    if (processedTopic.length < 2) {
      setError("Topic must be at least 2 characters long");
      return;
    }

    if (containsProfanity(processedTopic)) {
      setError("Inappropriate language is not allowed");
      return;
    }

    // Check if topic already exists in selected topics
    if (selectedTopics.includes(processedTopic)) {
      setError("This topic has already been selected");
      return;
    }

    setError("");
    onTopicsChange([...selectedTopics, processedTopic])
    setInputValue("")
    setOpen(false)
  }

  // Remove a topic from selection
  const removeTopic = (topic: string) => {
    onTopicsChange(selectedTopics.filter((t) => t !== topic))
  }

  // Handle learning outcomes changes
  const handleOutcomesChange = (text: string) => {
    setLearningOutcomesText(text)
    const outcomes = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.trim())
    onOutcomesChange(outcomes)
  }

  return (
    <div className={cn("space-y-8", className)}>
      <div className="space-y-4">
        <Label htmlFor="topic" className="text-base font-medium">
          Topics
        </Label>

        <div className="space-y-4">
          {/* Selected topics display */}
          {selectedTopics.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selectedTopics.map((topic) => (
                <div key={topic} className="flex items-center gap-1 bg-primary/10 text-primary rounded-full px-3 py-1">
                  <span>{topic}</span>
                  <button
                    type="button"
                    onClick={() => removeTopic(topic)}
                    className="text-primary hover:text-primary/80"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Autocomplete combobox */}
          <div className="flex gap-2">
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" aria-expanded={open} className="justify-between w-full">
                  {inputValue || "Select or add topics..."}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[calc(100vw-2rem)] sm:w-[400px] p-0">
                <Command>
                  <CommandInput placeholder="Search topics..." value={inputValue} onValueChange={setInputValue} />
                  {isLoading ? (
                    <div className="py-6 text-center text-sm">Loading topics...</div>
                  ) : (
                    <CommandList>
                      <CommandEmpty>
                        <div className="py-3 px-4 text-sm">
                          <p>No topic found.</p>
                          <Button
                            variant="ghost"
                            className="mt-2 w-full justify-start text-left"
                            onClick={() => addTopic(inputValue)}
                          >
                            <PlusCircle className="mr-2 h-4 w-4" />
                            Add "{inputValue}"
                          </Button>
                        </div>
                      </CommandEmpty>
                      <CommandGroup>
                        {filteredTopics.map((topic) => (
                          <CommandItem key={topic} value={topic} onSelect={() => addTopic(topic)}>
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedTopics.includes(topic) ? "opacity-100" : "opacity-0",
                              )}
                            />
                            {topic}
                          </CommandItem>
                        ))}
                        {inputValue && !filteredTopics.some((t) => t.toLowerCase() === inputValue.toLowerCase()) && (
                          <CommandItem onSelect={() => addTopic(inputValue)}>
                            <PlusCircle className="mr-2 h-4 w-4" />
                            Add "{inputValue}"
                          </CommandItem>
                        )}
                      </CommandGroup>
                    </CommandList>
                  )}
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <Label htmlFor="learning-outcomes" className="text-base font-medium">
          Learning Outcomes
        </Label>
        <Textarea
          id="learning-outcomes"
          value={learningOutcomesText}
          onChange={(e) => handleOutcomesChange(e.target.value)}
          placeholder="Enter learning outcomes (one per line)"
          className="min-h-[150px]"
        />
        <p className="text-sm text-muted-foreground">Enter each learning outcome on a new line</p>
      </div>
    </div>
  )
} 