"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

export interface SocialShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  postText: string;
  shareUrl: string;
  textareaAriaLabel: string;
  copyLabel?: string;
  copiedLabel?: string;
}

export function SocialShareDialog({
  open,
  onOpenChange,
  title,
  description,
  postText,
  shareUrl,
  textareaAriaLabel,
  copyLabel = "Copy post & link",
  copiedLabel = "Copied",
}: Readonly<SocialShareDialogProps>) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const copyPostText = async () => {
    try {
      await navigator.clipboard.writeText(postText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      setCopied(false);
      return false;
    }
  };

  const shareOnLinkedIn = async () => {
    const didCopy = await copyPostText();
    if (didCopy) {
      toast({
        title: "Post text copied — paste it into LinkedIn",
        description:
          "LinkedIn loads your profile link preview; paste the copied text into your post.",
      });
    }
    const targetUrl =
      shareUrl || (typeof window !== "undefined" ? window.location.origin : "");
    window.open(
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(targetUrl)}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea
            readOnly
            value={postText}
            rows={4}
            aria-label={textareaAriaLabel}
            className="text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void copyPostText()}>
              {copied ? (
                <Check className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Copy className="mr-1.5 h-3.5 w-3.5" />
              )}
              {copied ? copiedLabel : copyLabel}
            </Button>
            <Button type="button" size="sm" variant="outline" asChild>
              <a
                href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(postText)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Share on X
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void shareOnLinkedIn()}
            >
              Share on LinkedIn
              <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
