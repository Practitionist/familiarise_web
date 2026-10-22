import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import {
  prependedScrollTop,
  useThreadScroll,
} from "../../components/support/useThreadScroll";
import {
  attachmentProblem,
  formatFileSize,
} from "../../components/support/CaseAttachments";
import { SUPPORT_ATTACHMENT_ACCEPT } from "../../lib/support/attachment-policy";

describe("prependedScrollTop", () => {
  it("keeps the same rows in view when older rows are added above", () => {
    expect(
      prependedScrollTop({ scrollHeight: 1000, scrollTop: 40 }, 1600),
    ).toBe(640);
  });
});

/** A fake scroll box whose height grows by 100px per message. */
function Thread({
  count,
  onReady,
}: Readonly<{
  count: number;
  onReady: (api: ReturnType<typeof useThreadScroll<HTMLDivElement>>) => void;
}>) {
  const api = useThreadScroll<HTMLDivElement>("case_1", count);
  const { container } = api;
  const setRef = (el: HTMLDivElement | null) => {
    container.current = el;
    if (!el || "fake" in el.dataset) return;
    el.dataset.fake = "";
    let top = 0;
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => Number(el.dataset.count) * 100,
    });
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
  };
  React.useEffect(() => onReady(api));
  return (
    <div
      ref={setRef}
      data-count={count}
      data-testid="thread"
      onScroll={api.onScroll}
    />
  );
}

describe("useThreadScroll", () => {
  let api: ReturnType<typeof useThreadScroll<HTMLDivElement>>;
  const ready = (next: typeof api) => {
    api = next;
  };
  beforeEach(() => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true });
  });

  it("starts at the bottom, preserves position on load older, and doesn't yank a reader", async () => {
    const { getByTestId, rerender } = render(
      <Thread count={10} onReady={ready} />,
    );
    const el = getByTestId("thread");
    expect(el.scrollTop).toBe(1000);

    el.scrollTop = 0;
    fireEvent.scroll(el);
    await act(async () => {
      await api.loadOlderAnchored(async () => {
        rerender(<Thread count={16} onReady={ready} />);
        return true;
      });
    });
    expect(el.scrollTop).toBe(600);

    el.scrollTop = 200;
    fireEvent.scroll(el);
    rerender(<Thread count={17} onReady={ready} />);
    expect(el.scrollTop).toBe(200);
  });

  it("drops the prepend anchor when loading older messages fails", async () => {
    const { getByTestId, rerender } = render(
      <Thread count={10} onReady={ready} />,
    );
    const el = getByTestId("thread");
    el.scrollTop = 0;
    fireEvent.scroll(el);
    await act(async () => {
      await api
        .loadOlderAnchored(async () => {
          throw new Error("offline");
        })
        .catch(() => undefined);
    });
    rerender(<Thread count={11} onReady={ready} />);
    expect(el.scrollTop).toBe(0);
  });

  it("follows new messages when the reader is at the bottom", () => {
    const { getByTestId, rerender } = render(
      <Thread count={5} onReady={ready} />,
    );
    const el = getByTestId("thread");
    fireEvent.scroll(el);
    rerender(<Thread count={6} onReady={ready} />);
    expect(el.scrollTop).toBe(600);
  });
});

describe("attachment checks", () => {
  it("rejects types and sizes the upload route refuses", () => {
    expect(
      attachmentProblem({
        name: "clip.mov",
        type: "video/quicktime",
        size: 10,
      }),
    ).toMatch(/PDF/);
    expect(
      attachmentProblem({
        name: "scan.pdf",
        type: "application/pdf",
        size: 21 * 1024 * 1024,
      }),
    ).toMatch(/20 MB/);
    expect(
      attachmentProblem({ name: "letter.docx", type: "", size: 2048 }),
    ).toBeNull();
    expect(formatFileSize(1536)).toBe("2 KB");
  });

  it("accepts every extension the file picker offers, even with no browser type", () => {
    const extensions = SUPPORT_ATTACHMENT_ACCEPT.split(",").filter((entry) =>
      entry.startsWith("."),
    );
    expect(extensions.length).toBeGreaterThan(0);
    for (const extension of extensions)
      expect(
        attachmentProblem({ name: `file${extension}`, type: "", size: 10 }),
      ).toBeNull();
  });
});
