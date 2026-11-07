/**
 * @jest-environment node
 */

/**
 * `next/og` cannot render under Jest (it loads its WASM through a dynamic
 * import), so the real render is checked outside the suite. This pins what the
 * card is told to draw: size, cache window, and the words on it.
 */

import { isValidElement, type ReactNode } from "react";

const mockImageResponse = jest.fn();
jest.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: unknown, options: unknown) {
      mockImageResponse(element, options);
    }
  },
}));

import { renderEventPlanShareImage } from "@/lib/seo/event-plan-share-image";

/** Every string the element tree would draw. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return "";
}

const drawn = () => {
  const [element, options] = mockImageResponse.mock.calls.at(-1) ?? [];
  return { text: textOf(element as ReactNode), options };
};

beforeEach(() => mockImageResponse.mockClear());

describe("renderEventPlanShareImage", () => {
  it("draws a 1200x630 card with a short cache window", () => {
    renderEventPlanShareImage({ kind: "webinar", title: "LLD", host: "Arun" });
    const { options } = drawn();
    expect(options).toMatchObject({ width: 1200, height: 630 });
    expect(options.headers["Cache-Control"]).toContain("s-maxage=300");
  });

  it("names the plan, its host and the kind of event", () => {
    renderEventPlanShareImage({
      kind: "class",
      title: "5-Day LLD Bootcamp",
      host: "Arun",
    });
    const { text } = drawn();
    expect(text).toContain("LIVE CLASS");
    expect(text).toContain("5-Day LLD Bootcamp");
    expect(text).toContain("with Arun");
  });

  it("draws the generic card, with no host, when the plan is hidden", () => {
    renderEventPlanShareImage({ kind: "webinar", title: null, host: "Arun" });
    const { text } = drawn();
    expect(text).toContain("LIVE WEBINAR");
    expect(text).not.toContain("Arun");
  });

  it("clips a very long title", () => {
    renderEventPlanShareImage({
      kind: "webinar",
      title: "x".repeat(300),
      host: null,
    });
    expect(drawn().text).toContain("…");
    expect(drawn().text.length).toBeLessThan(200);
  });
});
