/**
 * A rejected upload is listed apart from the product's files: no order arrows,
 * its friendly reason with the code kept small, and it holds no file slot.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProductFilesManager } from "@/components/offerings/editor/ProductFilesManager";

const asset = (id: string, status: string, rejectReason: string | null) => ({
  id,
  originalName: `${id}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 1024,
  order: 0,
  version: 1,
  status: status as "VERIFIED" | "REJECTED",
  rejectReason,
});

it("lists rejected uploads separately, without order controls", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductFilesManager
        productId="dp_1"
        category="DOCUMENT"
        isPublished={false}
        assets={[
          asset("guide", "VERIFIED", null),
          asset("bad", "REJECTED", "POLYGLOT:/javascript"),
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
  expect(screen.queryByLabelText("Move bad.pdf up")).toBeNull();
  // The one live file is both first and last in the order.
  expect(
    (screen.getByLabelText("Move guide.pdf up") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText("Move guide.pdf down") as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
