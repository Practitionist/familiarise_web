/**
 * The unsent composer text is kept per channel in sessionStorage, so the chat layout unmounting
 * after a long socket outage does not lose it; an emptied composer (a send) clears it.
 */
import { render } from "@testing-library/react";
import { StateStore } from "stream-chat";

type FakeComposer = ReturnType<typeof makeComposer>;

function makeComposer(cid: string, userID: string | undefined = "user-a") {
  const state = new StateStore({ text: "" });
  const textComposer = {
    state,
    get text() {
      return state.getLatestValue().text;
    },
    setText: (text: string) => state.partialNext({ text }),
  };
  return {
    channel: { cid, getClient: () => ({ userID }) },
    editedMessage: null as { id: string } | null,
    textComposer,
  };
}

let composer: FakeComposer;
jest.mock("stream-chat-react", () => ({
  useMessageComposerController: () => composer,
}));

import { ComposerDraftPersistence } from "@/components/chat/ComposerDraftPersistence";
import { disconnectStreamClients } from "@/lib/stream/disconnect";

beforeEach(() => {
  window.sessionStorage.clear();
  composer = makeComposer("messaging:dm-1");
});

describe("ComposerDraftPersistence", () => {
  it("restores the typed text into a fresh composer after an unmount", () => {
    const first = render(<ComposerDraftPersistence />);
    composer.textComposer.setText("half-typed reply");
    first.unmount();
    // The SDK clears the composer when the layout unmounts.
    composer.textComposer.setText("");

    composer = makeComposer("messaging:dm-1");
    render(<ComposerDraftPersistence />);

    expect(composer.textComposer.text).toBe("half-typed reply");
  });

  it("keeps drafts apart per channel", () => {
    const first = render(<ComposerDraftPersistence />);
    composer.textComposer.setText("for dm-1");
    first.unmount();

    composer = makeComposer("messaging:dm-2");
    render(<ComposerDraftPersistence />);

    expect(composer.textComposer.text).toBe("");
  });

  it("never restores another user's draft on the same channel", () => {
    const first = render(<ComposerDraftPersistence />);
    composer.textComposer.setText("user-a private draft");
    first.unmount();

    composer = makeComposer("messaging:dm-1", "user-b");
    render(<ComposerDraftPersistence />);

    expect(composer.textComposer.text).toBe("");
  });

  it("removes every draft on sign-out and keeps unrelated keys", async () => {
    const first = render(<ComposerDraftPersistence />);
    composer.textComposer.setText("unsent");
    first.unmount();
    window.sessionStorage.setItem("unrelated", "kept");

    await disconnectStreamClients();

    expect(window.sessionStorage.getItem("unrelated")).toBe("kept");
    expect(window.sessionStorage.length).toBe(1);
  });

  it("drops the draft once the composer is emptied by a send", () => {
    const first = render(<ComposerDraftPersistence />);
    composer.textComposer.setText("sent message");
    composer.textComposer.setText("");
    first.unmount();

    composer = makeComposer("messaging:dm-1");
    render(<ComposerDraftPersistence />);

    expect(composer.textComposer.text).toBe("");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("does not persist the text of a message being edited", () => {
    composer.editedMessage = { id: "m1" };
    render(<ComposerDraftPersistence />);
    composer.textComposer.setText("existing message body");

    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps working when sessionStorage throws", () => {
    const getItem = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });

    render(<ComposerDraftPersistence />);
    expect(() => composer.textComposer.setText("typed")).not.toThrow();
    expect(composer.textComposer.text).toBe("typed");

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
