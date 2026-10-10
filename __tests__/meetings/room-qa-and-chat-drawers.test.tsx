/** @jest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StageChatDrawer } from "../../app/meetings/[id]/components/StageChatDrawer";
import { StageQaDrawer } from "../../app/meetings/[id]/components/StageQaDrawer";
import type {
  StageChatMessage,
  StageQuestion,
} from "../../lib/meetings/stage-qa";

describe("StageQaDrawer & StageChatDrawer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  const sampleQuestions: StageQuestion[] = [
    {
      id: "qa_1",
      text: "How does cursor pagination scale?",
      authorId: "u_alice",
      authorName: "Alice",
      authorRole: "participant",
      createdAt: "2026-10-10T10:00:00.000Z",
      upvoterIds: ["u_bob"],
      status: "open",
      answerText: null,
      answeredByName: null,
      answeredAt: null,
    },
    {
      id: "qa_2",
      text: "Where are slides uploaded?",
      authorId: "u_bob",
      authorName: "Bob",
      authorRole: "participant",
      createdAt: "2026-10-10T10:01:00.000Z",
      upvoterIds: ["u_alice", "u_bob", "u_carol"],
      status: "answered",
      answerText: "Under Session Artifacts in your dashboard.",
      answeredByName: "Host",
      answeredAt: "2026-10-10T10:02:00.000Z",
    },
  ];

  it("sorts Q&A questions by upvote count, filters Open vs Answered, and triggers upvote & reply callbacks", async () => {
    const onToggleUpvote = jest.fn().mockResolvedValue(undefined);
    const onAnswerQuestion = jest.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        <StageQaDrawer
          questions={sampleQuestions}
          activeBanner={null}
          isHost={true}
          currentUserId="u_bob"
          onAskQuestion={jest.fn()}
          onToggleUpvote={onToggleUpvote}
          onAnswerQuestion={onAnswerQuestion}
          onReopenQuestion={jest.fn()}
          onPinQuestion={jest.fn()}
          onUnpinQuestion={jest.fn()}
          isSubmitting={false}
        />,
      );
    });

    expect(host.textContent).toContain(
      "Under Session Artifacts in your dashboard.",
    );

    const upvoteBtn = host.querySelector(
      '[aria-label="Upvote question (1)"]',
    ) as HTMLButtonElement;
    act(() => {
      upvoteBtn.click();
    });
    expect(onToggleUpvote).toHaveBeenCalledWith("qa_1");

    const openTab = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Open (1)"),
    )!;
    act(() => {
      openTab.click();
    });
    expect(host.textContent).not.toContain("Where are slides uploaded?");
    expect(host.textContent).toContain("How does cursor pagination scale?");

    const replyBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Reply",
    )!;
    act(() => {
      replyBtn.click();
    });

    const input = host.querySelector(
      'input[placeholder="Write a concise reply..."]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "Keyset seek on (createdAt, id).");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });

    expect(onAnswerQuestion).toHaveBeenCalledWith(
      "qa_1",
      "Keyset seek on (createdAt, id).",
    );
  });

  it("renders clickable links and toggles quick emoji reactions in StageChatDrawer", async () => {
    const onToggleReaction = jest.fn().mockResolvedValue(undefined);
    const onSendMessage = jest.fn().mockResolvedValue(undefined);
    const messages: StageChatMessage[] = [
      {
        id: "chat_1",
        text: "Check https://familiarise.com/handout for exercises",
        authorId: "u_host",
        authorName: "Dr. Rao",
        authorRole: "host",
        createdAt: "2026-10-10T10:05:00.000Z",
        reactions: { "👍": ["u_alice"] },
        streamMessageId: "sm_1",
      },
    ];

    act(() => {
      root.render(
        <StageChatDrawer
          messages={messages}
          currentUserId="u_alice"
          onSendMessage={onSendMessage}
          onToggleReaction={onToggleReaction}
          isSubmitting={false}
        />,
      );
    });

    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://familiarise.com/handout");

    const reactTrigger = host.querySelector(
      '[aria-label="React to message"]',
    ) as HTMLButtonElement;
    act(() => {
      reactTrigger.click();
    });

    const heartBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "❤️",
    )!;
    await act(async () => {
      heartBtn.click();
    });

    expect(onToggleReaction).toHaveBeenCalledWith("chat_1", "❤️");
  });
});
