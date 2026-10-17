import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlanBrochureDownload } from "@/components/plans/PlanBrochureDownload";
import { PlanDetailBody } from "@/app/explore/programs/plans/components/PlanDetailBody";

let root: Root;
let container: HTMLDivElement;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = jest.fn();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

it("shows the PDF action alongside, not instead of, an authored roadmap", async () => {
  await act(async () =>
    root.render(
      <PlanDetailBody
        aboutHeading="About"
        curriculum={[
          { title: "Your direction", description: "Set your goals", order: 1 },
        ]}
        brochure={{ planId: "plan", planType: "subscriptions" }}
      />,
    ),
  );
  expect(container.textContent).toContain("Your direction");
  expect(container.textContent).toContain("Download curriculum (PDF)");
  expect(container.textContent).toContain("Save the curriculum for later");
  expect(container.textContent).not.toContain("Generated from this plan");
  await act(async () =>
    root.render(
      <PlanDetailBody
        aboutHeading="About"
        curriculum={[]}
        brochure={{ planId: "plan", planType: "subscriptions" }}
      />,
    ),
  );
  expect(container.textContent).not.toContain("Download curriculum (PDF)");
});

it("keeps a failed PDF download retryable with an accessible error", async () => {
  const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status: 500,
    headers: { get: () => null },
  } as unknown as Response);
  await act(async () =>
    root.render(<PlanBrochureDownload planId="plan" planType="classes" />),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(fetchMock).toHaveBeenCalledWith("/api/plans/classes/plan/brochure");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Please try again",
  );
  expect(container.querySelector("button")!.disabled).toBe(false);
});

it("disables duplicate requests while preparing the PDF", async () => {
  let resolve!: (value: Response) => void;
  jest.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await act(async () =>
    root.render(
      <PlanBrochureDownload planId="plan" planType="subscriptions" />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("button")!.disabled).toBe(true);
  expect(container.textContent).toContain("Preparing PDF…");
  await act(async () =>
    resolve({
      ok: false,
      status: 429,
      headers: { get: () => null },
    } as unknown as Response),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Too many downloads",
  );
  expect(container.querySelector("button")!.disabled).toBe(false);
});

it("downloads a PDF with the supplied safe filename and releases its object URL", async () => {
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:curriculum");
  URL.revokeObjectURL = jest.fn();
  jest.useFakeTimers();
  try {
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.href).toBe("blob:curriculum");
        expect(this.download).toBe("design-curriculum.pdf");
        expect(this.isConnected).toBe(true);
      });
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name === "Content-Type"
            ? "application/pdf"
            : 'attachment; filename="design-curriculum.pdf"',
      },
      blob: async () => new Blob(["%PDF-fixture"]),
    } as unknown as Response);
    await act(async () =>
      root.render(<PlanBrochureDownload planId="plan" planType="classes" />),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(click).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('a[download="design-curriculum.pdf"]'),
    ).toBeNull();
    expect(container.querySelector("button")!.disabled).toBe(false);
    act(() => jest.advanceTimersByTime(1000));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:curriculum");
  } finally {
    jest.useRealTimers();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
});
