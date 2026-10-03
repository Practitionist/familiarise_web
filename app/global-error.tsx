"use client";

import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect, useState } from "react";

import { sora } from "@/lib/fonts";

import "./globals.css";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  const [eventId, setEventId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const id = Sentry.captureException(error, {
      tags: {
        subsystem: "client",
        boundary: "global-error",
        ...(error.digest ? { digest: error.digest } : {}),
      },
    });
    if (typeof id === "string" && id) {
      setEventId(id);
    }
  }, [error]);

  const referenceId = error.digest ?? eventId;

  return (
    // global-error legitimately replaces the root layout, so it owns the only
    // <html>/<body> on this render — hence the font class here rather than
    // inherited. Without it this surface fell back to the UA default font.
    <html lang="en" className={sora.variable}>
      <body className={`${sora.className} antialiased`}>
        {/* `NextError` is the default Next.js error page component. Its type
        definition requires a `statusCode` prop. However, since the App Router
        does not expose status codes for errors, we simply pass 0 to render a
        generic error message. */}
        <NextError statusCode={0} />
        {referenceId && (
          <p className="fixed bottom-4 left-1/2 -translate-x-1/2 font-mono text-xs text-muted-foreground">
            Error ID: {referenceId}
          </p>
        )}
      </body>
    </html>
  );
}
