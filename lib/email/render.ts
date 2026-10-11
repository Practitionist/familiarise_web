import * as Sentry from "@sentry/nextjs";
import type { ReactElement } from "react";
import { render, toPlainText } from "react-email";

// #1298 — every sender ships a text part too: FailedEmail.textBody already
// exists and a multipart message scores better with spam filters.
// Render the React tree once and derive plain text from the rendered HTML.
export async function renderEmail(
  element: ReactElement,
): Promise<{ html: string; text: string }> {
  const run = async () => {
    const html = await render(element);
    const text = toPlainText(html);
    return { html, text };
  };
  if (typeof Sentry.startSpan === "function") {
    return Sentry.startSpan({ name: "email.render", op: "serialize" }, run);
  }
  return run();
}
