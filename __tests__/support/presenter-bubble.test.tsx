/** @jest-environment node */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SupportBubble } from "../../components/support/SupportBubble";
import { supportHandoffIndex } from "../../components/support/useSupportThread";

describe("presenter-authored replies", () => {
  it("labels the bubble as the presenter, not Familiarise support", () => {
    const html = renderToStaticMarkup(
      <SupportBubble
        perspective="user"
        author="AGENT"
        authorName="Dr Rao"
        body="See you in the session."
        actorKind="PRESENTER"
      />,
    );
    expect(html).toContain("Dr Rao · Presenter");
    expect(html).toContain("Presenter said");
    expect(html).not.toContain("Support said");
  });

  it("keeps the support label for staff replies", () => {
    const html = renderToStaticMarkup(
      <SupportBubble
        perspective="user"
        author="AGENT"
        authorName="Support"
        body="We are on it."
      />,
    );
    expect(html).toContain("Support said");
    expect(html).not.toContain("Presenter said");
  });

  it("puts the hand-off before the first staff reply, skipping presenter replies", () => {
    expect(
      supportHandoffIndex(
        [
          { sender: "USER" },
          { sender: "AGENT", actorKind: "PRESENTER" },
          { sender: "AGENT" },
        ],
        true,
      ),
    ).toBe(2);
  });

  it("puts the hand-off at the end when only a presenter has replied", () => {
    expect(
      supportHandoffIndex(
        [{ sender: "USER" }, { sender: "AGENT", actorKind: "PRESENTER" }],
        true,
      ),
    ).toBe(2);
    expect(supportHandoffIndex([{ sender: "USER" }], true)).toBe(1);
    expect(supportHandoffIndex([{ sender: "USER" }], false)).toBe(-1);
  });
});
