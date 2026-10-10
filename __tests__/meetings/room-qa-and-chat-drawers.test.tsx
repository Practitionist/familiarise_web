/** @jest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StageChatDrawer } from "../../app/meetings/[id]/components/StageChatDrawer";
import { StageQaDrawer } from "../../app/meetings/[id]/components/StageQaDrawer";
import {
  useRoomQaAndChat,
  type SideDrawerTab,
} from "../../app/meetings/[id]/components/useRoomQaAndChat";
import {
  STAGE_QA_EVENT_TYPES,
  type StageChatMessage,
  type StageQuestion,
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

  it("sorts Q&A questions by upvote count, filters Open vs Answered, and preserves draft when answer save fails", async () => {
    const onToggleUpvote = jest.fn().mockResolvedValue(undefined);
    const onAnswerQuestion = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    act(() => {
      root.render(
        <StageQaDrawer
          questions={sampleQuestions}
          activeBanner={null}
          isHost={true}
          currentUserId="u_bob"
          onAskQuestion={jest.fn().mockResolvedValue(true)}
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

    // First attempt returns false: editor remains open and draft text is preserved
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
    expect(
      (
        host.querySelector(
          'input[placeholder="Write a concise reply..."]',
        ) as HTMLInputElement
      )?.value,
    ).toBe("Keyset seek on (createdAt, id).");

    // Second attempt succeeds: editor closes cleanly
    await act(async () => {
      input
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(
      host.querySelector('input[placeholder="Write a concise reply..."]'),
    ).toBeNull();
  });

  it("renders clickable links and toggles quick emoji reactions in StageChatDrawer", async () => {
    const onToggleReaction = jest.fn().mockResolvedValue(undefined);
    const onSendMessage = jest.fn().mockResolvedValue(true);
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

  it("hydrates room state via GET, handles live custom events, and exercises all action handlers", async () => {
    let customHandler:
      ((event: { custom?: Record<string, unknown> }) => void) | null = null;
    const unsubscribe = jest.fn();
    const mockCall = {
      id: "call_live_1",
      on: jest.fn(
        (
          _eventName: string,
          handler: (event: { custom?: Record<string, unknown> }) => void,
        ) => {
          customHandler = handler;
          return unsubscribe;
        },
      ),
    } as never;

    const initialQuestion: StageQuestion = {
      id: "qa_init",
      text: "Initial hydrated question",
      authorId: "u_1",
      authorName: "Priya",
      authorRole: "participant",
      createdAt: "2026-10-10T10:00:00.000Z",
      upvoterIds: [],
      status: "open",
      answerText: null,
      answeredByName: null,
      answeredAt: null,
    };

    const initialMsg: StageChatMessage = {
      id: "chat_init",
      text: "Hello everyone",
      authorId: "u_1",
      authorName: "Priya",
      authorRole: "participant",
      createdAt: "2026-10-10T10:00:00.000Z",
      reactions: {},
      streamMessageId: null,
    };

    const fetchMock = jest
      .fn()
      .mockImplementation(async (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === "GET") {
          return {
            ok: true,
            json: async () => ({
              questions: [initialQuestion],
              messages: [initialMsg],
            }),
          };
        }
        const parsedBody = JSON.parse(String(init.body));
        if (parsedBody.text === "FAIL_ME") {
          return {
            ok: false,
            json: async () => ({ error: "Rate limited" }),
          };
        }
        if (parsedBody.action === "send_chat") {
          return {
            ok: true,
            json: async () => ({
              message: {
                ...initialMsg,
                id: "chat_new",
                text: parsedBody.text,
              },
            }),
          };
        }
        if (parsedBody.action === "toggle_reaction") {
          return {
            ok: true,
            json: async () => ({
              message: {
                ...initialMsg,
                reactions: { [parsedBody.emoji]: ["u_host"] },
              },
            }),
          };
        }
        if (parsedBody.action === "pin") {
          return {
            ok: true,
            json: async () => ({
              banner: {
                questionId: parsedBody.questionId,
                text: initialQuestion.text,
                authorId: initialQuestion.authorId,
                authorName: initialQuestion.authorName,
                authorRole: initialQuestion.authorRole,
                pinnedByUserId: "u_host",
                pinnedAt: "2026-10-10T10:05:00.000Z",
              },
            }),
          };
        }
        if (parsedBody.action === "unpin") {
          return { ok: true, json: async () => ({ banner: null }) };
        }
        return {
          ok: true,
          json: async () => ({
            question: {
              ...initialQuestion,
              id: parsedBody.questionId ?? "qa_asked",
              text: parsedBody.text ?? initialQuestion.text,
              upvoterIds:
                parsedBody.action === "toggle_upvote" ? ["u_host"] : [],
              status: parsedBody.action === "answer" ? "answered" : "open",
            },
          }),
        };
      });
    const origFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    let latestState!: ReturnType<typeof useRoomQaAndChat>;
    const Harness = ({ tab }: { tab: SideDrawerTab }) => {
      latestState = useRoomQaAndChat({
        call: mockCall,
        callCustomData: undefined,
        inCallChatAllowed: true,
        isHost: true,
        activeSideTab: tab,
      });
      return null;
    };

    try {
      await act(async () => {
        root.render(<Harness tab="qa" />);
      });

      expect(latestState.questions).toHaveLength(1);
      expect(latestState.chatMessages).toHaveLength(1);

      // Exercise real-time custom events while on "qa" tab -> unreadChatCount increments
      act(() => {
        customHandler?.({
          custom: {
            type: STAGE_QA_EVENT_TYPES.CHAT_MESSAGE_SENT,
            message: { ...initialMsg, id: "chat_live_2" },
          },
        });
        customHandler?.({
          custom: {
            type: STAGE_QA_EVENT_TYPES.CHAT_MESSAGE_UPDATED,
            message: {
              ...initialMsg,
              id: "chat_live_2",
              reactions: { "👍": ["u_1"] },
            },
          },
        });
        customHandler?.({
          custom: {
            type: STAGE_QA_EVENT_TYPES.QUESTION_ASKED,
            question: { ...initialQuestion, id: "qa_live_2" },
          },
        });
        customHandler?.({
          custom: {
            type: STAGE_QA_EVENT_TYPES.BANNER_PINNED,
            banner: {
              questionId: "qa_init",
              text: initialQuestion.text,
              authorId: "u_1",
              authorName: "Priya",
              authorRole: "participant",
              pinnedByUserId: "u_host",
              pinnedAt: "2026-10-10T10:06:00.000Z",
            },
          },
        });
        customHandler?.({
          custom: { type: STAGE_QA_EVENT_TYPES.BANNER_UNPINNED },
        });
      });

      expect(latestState.unreadChatCount).toBe(1);

      // Switching tab to "chat" resets unreadChatCount to 0
      act(() => {
        root.render(<Harness tab="chat" />);
      });
      expect(latestState.unreadChatCount).toBe(0);

      // Exercise all 8 action handlers + error path
      await act(async () => {
        expect(await latestState.handleSendChatMessage("FAIL_ME")).toBe(false);
        expect(await latestState.handleSendChatMessage("Hello!")).toBe(true);
        await latestState.handleToggleChatReaction("chat_init", "🎉");
        expect(await latestState.handleAskQuestion("New question?")).toBe(true);
        await latestState.handleToggleUpvote("qa_init");
        expect(
          await latestState.handleAnswerQuestion("qa_init", "Great question!"),
        ).toBe(true);
        await latestState.handleReopenQuestion("qa_init");
        await latestState.handlePinQuestion(initialQuestion);
        await latestState.handleUnpinQuestion();
      });

      expect(latestState.activeBanner).toBeNull();
    } finally {
      global.fetch = origFetch;
    }
  });
});
