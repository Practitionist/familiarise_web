/**
 * @jest-environment node
 */

/**
 * On a closed case the staff composer refuses public replies up front, with a
 * note saying why, and keeps private notes available.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CaseConversation,
  type ComposerMode,
} from "../../components/dashboard/backoffice/support/CaseConversation";

type CaseData = Parameters<typeof CaseConversation>[0]["data"];

function render(status: string, mode: ComposerMode): string {
  const data = {
    key: "t_1",
    ticketId: "1",
    status,
    timeline: [],
    handoffSummary: null,
  } as unknown as CaseData;
  return renderToStaticMarkup(
    <CaseConversation
      data={data}
      mode={mode}
      onModeChange={jest.fn()}
      replyDraft="Thanks for waiting"
      onReplyDraftChange={jest.fn()}
      sending={false}
      onSend={jest.fn()}
      replies={[]}
      suggested={[]}
      helpArticles={[]}
      onInsert={jest.fn()}
    />,
  );
}

describe("CaseConversation on a closed case", () => {
  it("disables the public reply and says private notes still work", () => {
    const html = render("CLOSED", "reply");
    expect(html).toContain("the customer can&#x27;t receive replies");
    expect(html).toMatch(/<textarea[^>]* disabled=""/);
    expect(html).toMatch(
      /<button[^>]* disabled=""[^>]*>(?:(?!<button).)*Send reply/,
    );
  });

  it("leaves the private note composer usable", () => {
    const html = render("CLOSED", "note");
    expect(html).not.toContain("can&#x27;t receive replies");
    expect(html).not.toMatch(/<textarea[^>]* disabled=""/);
  });

  it("leaves an open case untouched", () => {
    expect(render("OPEN", "reply")).not.toMatch(/<textarea[^>]* disabled=""/);
  });
});
