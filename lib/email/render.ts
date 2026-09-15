import type { ReactElement } from "react";
import { render } from "react-email";

// #1298 — every sender ships a text part too: FailedEmail.textBody already
// exists and a multipart message scores better with spam filters.
export async function renderEmail(
  element: ReactElement,
): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { html, text };
}
