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
import { ThreadCard } from "@/components/documents/workspace/ThreadCard";
import type { AuthorizedFile } from "@/lib/documents/file-access";
import { buildThreadViews } from "@/lib/documents/thread-view";

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
  viewerRole: "consultee",
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
      "Ask your expert to upload it again.",
    );
  });
});

describe("Open is a plain new-tab link to the viewer", () => {
  it("links every version to /files/documents/:id in a new tab, without fetching", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const at = new Date("2026-10-01T00:00:00Z");
    const base = {
      originalName: "cv.pdf",
      mimeType: "application/pdf",
      fileSize: 1000,
      description: null,
      reviewNotes: null,
      reviewedAt: null,
      uploadedAt: at,
      isStorageMissing: false,
      removalRequestedAt: null,
    };
    const [thread] = buildThreadViews(
      [
        {
          ...base,
          id: "doc-1",
          rootDocumentId: null,
          versionNo: 1,
          uploadedByRole: "CONSULTEE",
          reviewStatus: "NEEDS_REVISION",
        },
        {
          ...base,
          id: "doc-2",
          rootDocumentId: "doc-1",
          versionNo: 2,
          uploadedByRole: "CONSULTANT",
          reviewStatus: "APPROVED",
        },
      ],
      { viewerRole: "learner", writable: true },
    );

    await render(
      <QueryClientProvider client={new QueryClient()}>
        <ThreadCard
          appointmentId="apt-1"
          thread={thread!}
          names={{
            viewerRole: "learner",
            learnerName: "Rahul",
            expertName: "Angela",
            organizationName: null,
          }}
          day={() => "1 Oct 2026"}
          focused={false}
          onChanged={() => undefined}
        />
      </QueryClientProvider>,
    );

    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/files/documents/doc-2",
      "/files/documents/doc-1",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Expert reply");
    expect(container.textContent).toContain(
      "Your turn: Angela asked for changes",
    );
  });
});
