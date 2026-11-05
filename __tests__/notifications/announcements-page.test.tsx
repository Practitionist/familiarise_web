/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnnouncementsPage } from "@/components/dashboard/shared/AnnouncementsPage";
const mockToast = jest.fn();
const mockFetch = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("../../hooks/use-media-query", () => ({ useMediaQuery: () => true }));
const oldFetch = globalThis.fetch;
const oldResizeObserver = globalThis.ResizeObserver;
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
  };
});
const announcement = {
  id: "one",
  title: "Scheduled notice",
  content: "Details",
  isActive: true,
  startDate: new Date(Date.now() + 86400000).toISOString(),
  endDate: null,
  backgroundColor: "#000000",
  textColor: "#FFFFFF",
  linkUrl: "https://example.com/news",
  linkText: "Read more",
  createdAt: new Date().toISOString(),
};
beforeEach(() => {
  mockToast.mockClear();
  mockFetch.mockReset();
  globalThis.fetch = mockFetch;
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: [announcement] }),
  });
});
afterAll(() => {
  globalThis.fetch = oldFetch;
  globalThis.ResizeObserver = oldResizeObserver;
});
function show() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <AnnouncementsPage />
    </QueryClientProvider>,
  );
}
it("uses the protected management feed and shows scheduled state", async () => {
  show();
  await screen.findByText("Scheduled notice");
  expect(mockFetch).toHaveBeenCalledWith("/api/announcements?view=manage");
  expect(screen.getByText("Scheduled", { exact: true })).toBeInTheDocument();
});
it("shows a loading failure rather than claiming the admin list is empty", async () => {
  mockFetch.mockResolvedValue({
    ok: false,
    json: async () => ({ success: false }),
  });
  show();
  await screen.findByText("Announcements could not be loaded. Try again.");
  expect(screen.queryByText("No announcements yet")).not.toBeInTheDocument();
});
it("keeps the create dialog open and reports API rejection as failure", async () => {
  show();
  await screen.findByText("Scheduled notice");
  fireEvent.click(screen.getByRole("button", { name: "New Announcement" }));
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "New notice" },
  });
  fireEvent.change(screen.getByLabelText("Content"), {
    target: { value: "Some news" },
  });
  mockFetch.mockResolvedValue({
    ok: false,
    json: async () => ({ success: false, error: "Rejected" }),
  });
  const form = screen.getByRole("button", { name: "Create" }).closest("form");
  if (!form) throw new Error("Create form missing");
  fireEvent.submit(form);
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to create announcement",
        variant: "destructive",
      }),
    ),
  );
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(mockToast).not.toHaveBeenCalledWith(
    expect.objectContaining({ title: "Announcement created" }),
  );
});
it("preserves link fields and converts scheduled local input back to an instant when editing", async () => {
  show();
  await screen.findByText("Scheduled notice");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Link URL (optional)")).toHaveValue(
    announcement.linkUrl,
  );
  fireEvent.change(screen.getByLabelText("Start (local time)"), {
    target: { value: "2027-01-05T15:30" },
  });
  mockFetch.mockImplementation(async (_url, options) =>
    options?.method === "PATCH"
      ? { ok: false, json: async () => ({ success: false, error: "Rejected" }) }
      : {
          ok: true,
          json: async () => ({ success: true, data: [announcement] }),
        },
  );
  const form = screen.getByRole("button", { name: "Save" }).closest("form");
  if (!form) throw new Error("Edit form missing");
  fireEvent.submit(form);
  await waitFor(() =>
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/announcements/one",
      expect.objectContaining({ method: "PATCH" }),
    ),
  );
  const call = mockFetch.mock.calls.find(
    (entry) => entry[1]?.method === "PATCH",
  );
  expect(JSON.parse(call?.[1].body)).toMatchObject({
    linkUrl: announcement.linkUrl,
    linkText: announcement.linkText,
    startDate: new Date("2027-01-05T15:30").toISOString(),
  });
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to update announcement" }),
    ),
  );
});
