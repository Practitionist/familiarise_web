/**
 * A rejected upload is listed apart from the product's files: no order arrows,
 * its friendly reason with the code kept small, the file it tried to replace,
 * and it holds no file slot. Files read as history, removing one names who
 * loses it, and a batch of rejections is one toast.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ProductFilesManager,
  verdictToast,
} from "@/components/offerings/editor/ProductFilesManager";

const asset = (
  id: string,
  status: string,
  rejectReason: string | null,
  version = 1,
) => ({
  id,
  lineageId: "lin_guide",
  originalName: `${id}.pdf`,
  displayName: "guide.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  order: 0,
  version,
  status: status as "VERIFIED" | "REJECTED",
  rejectReason,
  verifiedAt: status === "VERIFIED" ? "2026-11-02T06:00:00Z" : null,
  createdAt: "2026-11-02T06:00:00Z",
});

it("lists rejected uploads separately, shows history and names who loses a removed file", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductFilesManager
        productId="dp_1"
        category="DOCUMENT"
        isPublished={false}
        buyerCount={2}
        assets={[
          asset("guide-v3", "VERIFIED", null, 3),
          asset("bad", "REJECTED", "POLYGLOT:/javascript", 4),
        ]}
        onChanged={async () => undefined}
      />
    </QueryClientProvider>,
  );
  const rejected = screen.getByRole("region", { name: "Rejected uploads" });
  expect(
    within(rejected).getByText(/contains scripts or web code/),
  ).toBeTruthy();
  expect(within(rejected).getByText("POLYGLOT · /javascript")).toBeTruthy();
  expect(within(rejected).getByText("Replacement for guide.pdf")).toBeTruthy();
  expect(screen.queryByLabelText("Move bad.pdf up")).toBeNull();
  expect(screen.getByText("Updated 2 Nov")).toBeTruthy();
  expect(screen.getByText("Buyers see it as guide.pdf")).toBeTruthy();
  expect(screen.queryByText(/Version \d/)).toBeNull();
  // The one live file is both first and last in the order.
  expect(
    (screen.getByLabelText("Move guide-v3.pdf up") as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  fireEvent.click(screen.getByLabelText("Remove guide-v3.pdf"));
  expect(
    screen.getByText(/^2 buyers will lose access to this file\./),
  ).toBeTruthy();
});

it("sums a batch of rejections into one toast", () => {
  const rejected = { status: "REJECTED" as const, reason: "POLYGLOT" };
  const verified = { status: "VERIFIED" as const, reason: null };
  expect(
    verdictToast(
      ["a.pdf", "b.pdf", "c.pdf", "d.pdf"],
      [rejected, rejected, verified, rejected],
    ),
  ).toEqual({
    title: "3 files were rejected",
    description: "1 verified. See Rejected uploads in Files for why.",
    variant: "destructive",
  });
  expect(verdictToast(["a.pdf"], [rejected]).title).toBe("a.pdf was rejected");
});
