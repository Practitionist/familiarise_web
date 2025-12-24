"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";

import { cn } from "@/utils/tailwind";

/**
 * Optimizes GitHub avatar URLs by appending size parameter.
 * GitHub avatars support ?s=SIZE to request appropriately sized images.
 * Default size 80 provides 2x resolution for 40px display (retina).
 */
function optimizeAvatarUrl(
  src: string | undefined,
  size: number = 80,
): string | undefined {
  if (!src) return src;
  if (src.includes("avatars.githubusercontent.com") && !src.includes("?s=")) {
    return `${src}?s=${size}`;
  }
  return src;
}

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
      className,
    )}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

interface AvatarImageProps
  extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image> {
  /** Size in pixels for GitHub avatar optimization (default: 80 for 2x retina) */
  optimizedSize?: number;
}

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  AvatarImageProps
>(({ className, src, optimizedSize = 80, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    src={optimizeAvatarUrl(src, optimizedSize)}
    className={cn("aspect-square h-full w-full", className)}
    {...props}
  />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-muted",
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
