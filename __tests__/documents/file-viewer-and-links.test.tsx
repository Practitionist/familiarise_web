/**
 * @jest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockCreateSignedStorageUrl = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/auth-helpers", () => ({ requireOrgAccess: jest.fn() }));
jest.mock("../../lib/documents/storage-verify", () => ({
  createSignedStorageUrl: (...args: unknown[]) =>
    mockCreateSignedStorageUrl(...args),
}));
jest.mock("../../components/recordings/RecordingPlayerModal", () => ({
  RecordingPlayerModal: () => null,
}));

import { FileViewer, FileViewerError } from "@/components/documents/FileViewer";
import { AppointmentDocumentsList } from "@/components/appointments/detail/AppointmentDocumentsList";
import {
  EventResourceCard,
  type EventResource,
} from "@/components/dashboard/consultee/resources/EventResourceCard";
import type { AuthorizedFile } from "@/lib/documents/file-access";

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
  jest.clearAllMocks();
});

async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
}

const pdf: AuthorizedFile = {
  storagePath: "appointments/apt-1/cv.pdf",
  originalName: "cv.pdf",
  mimeType: "application/pdf",
  previewable: true,
  viewerIsUploader: false,
  appointmentId: "apt-1",
};

describe("file viewer route", () => {
  it("signs a fresh link on every load, so a reload never shows an expired one", async () => {
    let n = 0;
    mockCreateSignedStorageUrl.mockImplementation(async () => ({
      ok: true,
      signedUrl: `https://storage.example.com/cv.pdf?token=${++n}`,
    }));
    const access = { ok: true as const, file: pdf };

    await render(
      await FileViewer({ access, callbackPath: "/files/documents/doc-1" }),
    );
    const firstEmbed = container.querySelector("iframe")?.getAttribute("src");
    await render(
      await FileViewer({ access, callbackPath: "/files/documents/doc-1" }),
    );
    const secondEmbed = container.querySelector("iframe")?.getAttribute("src");

    expect(firstEmbed).toMatch(/token=\d$/);
    expect(secondEmbed).not.toBe(firstEmbed);
    expect(mockCreateSignedStorageUrl).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "inline", expiresInSeconds: 300 }),
    );
  });

  it("renders a friendly page with a return-here sign-in link, never JSON", async () => {
    await render(
      <FileViewerError
        code="UNAUTHORIZED"
        callbackPath="/files/documents/doc-1"
      />,
    );
    expect(container.textContent).toContain(
      "You were signed out. Sign in again to open this file.",
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/auth/signin?callbackUrl=%2Ffiles%2Fdocuments%2Fdoc-1",
    );
  });

  it("shows the friendly missing-file page when storage has lost the object", async () => {
    mockCreateSignedStorageUrl.mockResolvedValue({
      ok: false,
      code: "STORAGE_MISSING",
    });
    await render(
      await FileViewer({
        access: { ok: true, file: pdf },
        callbackPath: "/files/documents/doc-1",
      }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain(
      "Ask the person who shared it to upload it again.",
    );
  });
});

describe("Open is a plain new-tab link to the viewer", () => {
  it("links each document to /files/documents/:id in a new tab, without fetching", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "doc-1",
            fileName: "cv.pdf",
            originalName: "cv.pdf",
            fileUrl: "",
            uploadedByRole: "CONSULTEE",
            reviewStatus: "PENDING",
          },
          {
            id: "doc-2",
            fileName: "reply.pdf",
            originalName: "reply.pdf",
            fileUrl: "",
            uploadedByRole: "CONSULTANT",
            reviewStatus: "APPROVED",
          },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new QueryClient();

    await render(
      <QueryClientProvider client={client}>
        <AppointmentDocumentsList appointmentId="apt-1" />
      </QueryClientProvider>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/files/documents/doc-1",
      "/files/documents/doc-2",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      expect(link.textContent).toContain("(opens in a new tab)");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Approved");
  });
});

describe("EventResourceCard header", () => {
  const event: EventResource = {
    id: "cl-1",
    appointmentId: "apt-own",
    planTitle: "Python batch",
    consultantName: "Angela",
    consultantImage: null,
    status: "COMPLETED",
    date: "2026-10-01T10:00:00.000Z",
    classId: "cl-1",
    materials: [],
    recordings: [],
  };

  it("keeps the session link outside the toggle button", async () => {
    await render(<EventResourceCard consulteeId="ce-1" event={event} />);
    const link = container.querySelector(
      'a[href="/dashboard/consultee/ce-1/appointments/apt-own"]',
    );
    expect(link).not.toBeNull();
    expect(link?.closest("button")).toBeNull();
    expect(container.querySelector("button a")).toBeNull();
  });

  it("labels another batch's recordings without linking to a booking the viewer is not on", async () => {
    await render(
      <EventResourceCard
        consulteeId="ce-1"
        event={{ ...event, appointmentId: null, fromOtherRun: true }}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("From another batch");
  });
});
