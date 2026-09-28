/**
 * @jest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { pendingToast, useToast } from "@/components/ui/use-toast";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The outcome must replace the progress toast, not stack under it
// ("Signing in..." + "Sign In Successful" on screen together).
it("settles a pending toast in place", async () => {
  let titles: React.ReactNode[] = [];
  function Probe() {
    titles = useToast()
      .toasts.filter((t) => t.open)
      .map((t) => t.title);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  await act(async () => {
    const settle = pendingToast({ title: "Signing in..." });
    settle({ title: "Sign In Successful", description: "Redirecting" });
  });
  expect(titles).toEqual(["Sign In Successful"]);
  act(() => root.unmount());
});
