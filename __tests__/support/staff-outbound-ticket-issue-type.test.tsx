/**
 * @jest-environment jsdom
 */

/**
 * The staff "new outbound support ticket" dialog.
 *
 * The issue-type list and the value the select accepts must be ONE list. When
 * they were two, a newly offered type (GST, TDS, PAN) was rejected by the
 * handler's own enum, the state never moved and the select kept the old
 * value — so nobody could file that kind of ticket at all.
 */

jest.mock("../../components/ui/select", () => {
  const React = jest.requireActual("react");
  const Ctx = React.createContext({ value: "", onValueChange: () => {} });
  const Select = ({ children, value, onValueChange }: never) =>
    React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange } },
      React.createElement(
        "div",
        { "data-testid": "select", "data-value": value },
        children,
      ),
    );
  const SelectTrigger = ({ children, id }: never) =>
    React.createElement("div", { id }, children);
  const SelectValue = () => null;
  const SelectContent = ({ children }: never) =>
    React.createElement("div", null, children);
  const SelectItem = ({ value, children }: never) => {
    const ctx = React.useContext(Ctx);
    return React.createElement(
      "button",
      {
        type: "button",
        "data-testid": `option-${value}`,
        onClick: () => ctx.onValueChange(value),
      },
      children,
    );
  };
  return {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
  };
});

jest.mock("../../components/ui/responsive-modal", () => {
  const React = jest.requireActual("react");
  const passthrough = ({ children }: never) =>
    React.createElement("div", null, children);
  return {
    ResponsiveModal: passthrough,
    ResponsiveModalContent: passthrough,
    ResponsiveModalHeader: passthrough,
    ResponsiveModalTitle: passthrough,
    ResponsiveModalFooter: passthrough,
  };
});

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { StaffSupportComposeDialog } from "../../components/dashboard/backoffice/support/StaffSupportComposeDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <StaffSupportComposeDialog
          open
          onOpenChange={jest.fn()}
          defaultTargetUserId="customer-1"
        />
      </QueryClientProvider>,
    );
  });
}

/** The select that owns the given trigger. */
function selectFor(triggerId: string): HTMLElement {
  const trigger = container.querySelector(`#${triggerId}`);
  const select = trigger?.closest('[data-testid="select"]');
  if (!select) throw new Error(`No select for #${triggerId}`);
  return select as HTMLElement;
}

async function choose(triggerId: string, value: string): Promise<void> {
  const option = container.querySelector(`[data-testid="option-${value}"]`);
  if (!option) throw new Error(`No "${value}" option`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the outbound ticket's issue type", () => {
  it("accepts every issue type it offers", async () => {
    await render();
    const select = selectFor("outbound-issue-type");
    // The three that the hand-written enum was missing.
    for (const value of ["TAX_GST", "TDS_CERTIFICATE", "PAN_CARD_MISMATCH"]) {
      await choose("outbound-issue-type", value);
      expect(select.getAttribute("data-value")).toBe(value);
    }
  });

  it("leaves the value alone for something it does not offer", async () => {
    await render();
    const select = selectFor("outbound-issue-type");
    expect(select.getAttribute("data-value")).toBe("GENERAL_INQUIRY");
  });
});
