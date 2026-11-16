/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { ReportConcernButton } from "@/components/events/ReportConcernButton";
it("opens the tab inside the click, before the link arrives", async () => {
  const tab = {
    location: { href: "" },
    opener: {} as unknown,
    close: jest.fn(),
  };
  const open = jest
    .spyOn(window, "open")
    .mockReturnValue(tab as unknown as Window);
  type Answer = { ok: boolean; json: () => Promise<unknown> };
  let answer: (value: Answer) => void = () => undefined;
  globalThis.fetch = jest.fn(
    () => new Promise<Answer>((resolve) => (answer = resolve)),
  ) as unknown as typeof fetch;
  render(<ReportConcernButton endpoint="/api/meetings/call-1/support" />);
  fireEvent.click(screen.getByRole("button", { name: /Report a concern/ }));
  expect(open).toHaveBeenCalledTimes(1);
  answer({ ok: true, json: async () => ({ href: "/dashboard/x" }) });
  await waitFor(() => expect(tab.location.href).toBe("/dashboard/x"));
  expect(tab.opener).toBeNull();
});
