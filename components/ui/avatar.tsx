"use client";

import * as React from "react";

import { cn } from "@/utils/tailwind";

interface AvatarContextValue {
  hasImage: boolean;
  setHasImage: React.Dispatch<React.SetStateAction<boolean>>;
}

const AvatarContext = React.createContext<AvatarContextValue | null>(null);

const Avatar = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, children, ...props }, ref) => {
  const hasInitialSrc = React.Children.toArray(children).some(
    (child) =>
      React.isValidElement<{ src?: string | null }>(child) &&
      typeof child.props?.src === "string" &&
      child.props.src.trim().length > 0,
  );

  const [hasImage, setHasImage] = React.useState<boolean>(hasInitialSrc);

  const contextValue = React.useMemo(
    () => ({ hasImage, setHasImage }),
    [hasImage],
  );

  return (
    <AvatarContext.Provider value={contextValue}>
      <span
        ref={ref}
        className={cn(
          "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
          className,
        )}
        {...props}
      >
        {children}
      </span>
    </AvatarContext.Provider>
  );
});
Avatar.displayName = "Avatar";

export interface AvatarImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  onLoadingStatusChange?: (
    status: "idle" | "loading" | "loaded" | "error",
  ) => void;
}

const AvatarImage = React.forwardRef<HTMLImageElement, AvatarImageProps>(
  (
    {
      className,
      src,
      alt = "",
      loading = "lazy",
      decoding = "async",
      onLoad,
      onError,
      onLoadingStatusChange,
      ...props
    },
    ref,
  ) => {
    const context = React.useContext(AvatarContext);
    const hasSrc = typeof src === "string" && src.trim().length > 0;
    const [hasError, setHasError] = React.useState(false);

    React.useEffect(() => {
      setHasError(false);
    }, [src]);

    const visible = hasSrc && !hasError;

    React.useEffect(() => {
      context?.setHasImage(visible);
      if (!hasSrc) {
        onLoadingStatusChange?.("idle");
      }
    }, [context, visible, hasSrc, onLoadingStatusChange]);

    if (!visible) {
      return null;
    }

    return React.createElement("img", {
      ...props,
      ref,
      src,
      alt,
      loading,
      decoding,
      onLoad: (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
        context?.setHasImage(true);
        onLoadingStatusChange?.("loaded");
        onLoad?.(e);
      },
      onError: (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
        setHasError(true);
        context?.setHasImage(false);
        onLoadingStatusChange?.("error");
        onError?.(e);
      },
      className: cn("aspect-square h-full w-full object-cover", className),
    });
  },
);
AvatarImage.displayName = "AvatarImage";

const AvatarFallback = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & { delayMs?: number }
>(({ className, delayMs: _delayMs, ...props }, ref) => {
  const context = React.useContext(AvatarContext);

  if (context?.hasImage) {
    return null;
  }

  return (
    <span
      ref={ref}
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-muted",
        className,
      )}
      {...props}
    />
  );
});
AvatarFallback.displayName = "AvatarFallback";

export { Avatar, AvatarImage, AvatarFallback };
