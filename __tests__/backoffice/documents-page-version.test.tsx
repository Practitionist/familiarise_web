import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/dashboard/staff/verification",
  useSearchParams: () => new URLSearchParams(),
}));

import { DocumentsPage } from "../../components/dashboard/shared/DocumentsPage";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

it("names a document row by its version, not an uploader file name", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      items: [
        {
          id: "doc-1",
          versionNo: 2,
          reviewStatus: "APPROVED",
          reviewNotes: null,
          reviewedAt: null,
          uploadedByRole: "CONSULTANT",
          uploadedAt: "2026-11-16T09:00:00.000Z",
          isStorageMissing: false,
          responseToDocumentId: null,
          appointment: null,
        },
      ],
      total: 1,
      page: 1,
      perPage: 20,
    }),
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DocumentsPage />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Version 2")).toBeInTheDocument();
});
