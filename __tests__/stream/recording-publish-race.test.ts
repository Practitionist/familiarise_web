/** @jest-environment node */

import { NextRequest } from "next/server";
import {
  Prisma,
  RecordingListingStatus,
  RecordingStatus,
} from "@prisma/client";

type RecordingState = {
  id: string;
  status: RecordingStatus;
  storageType: "PLATFORM";
  storagePath: string | null;
  listingStatus: RecordingListingStatus;
  previewClipUrl: string | null;
  previewTranscript: string | null;
  slug: string | null;
  publishedAt: Date | null;
};
type PublishWrite = {
  where: Partial<RecordingState>;
  data: Pick<RecordingState, "listingStatus" | "slug" | "publishedAt">;
};

let mockRow: RecordingState;
let mockBeforeWrite: () => void;
let mockWriteError: Error | null;
const mockRevalidatePath = jest.fn();
const mockGetSession = jest.fn();
function publishedFields() {
  return {
    id: mockRow.id,
    slug: mockRow.slug,
    listingStatus: mockRow.listingStatus,
    publishedAt: mockRow.publishedAt,
  };
}
const mockRecordingUpdate = jest.fn(async ({ data }: PublishWrite) => {
  if (mockWriteError) throw mockWriteError;
  Object.assign(mockRow, data);
  return publishedFields();
});
const mockRecordingUpdateManyAndReturn = jest.fn(
  async ({ where, data }: PublishWrite) => {
    if (mockWriteError) throw mockWriteError;
    const matches = Object.entries(where).every(
      ([key, value]) => Reflect.get(mockRow, key) === value,
    );
    if (!matches) return [];
    Object.assign(mockRow, data);
    return [publishedFields()];
  },
);
const mockRecordingFindUnique = jest.fn(
  async ({ where }: { where: { id?: string; slug?: string } }) => {
    if (where.slug) {
      mockBeforeWrite();
      return mockRow.slug === where.slug ? { id: mockRow.id } : null;
    }
    return {
      ...mockRow,
      listPricePaise: 100,
      meeting: {
        occurrence: {
          appointment: {
            webinar: {
              webinarPlan: {
                id: "plan-1",
                consultantProfileId: "profile-1",
                organizationId: null,
                visibility: "PUBLIC",
                archivedAt: null,
              },
            },
            class: null,
          },
        },
      },
    };
  },
);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recording: {
      findUnique: (args: { where: { id?: string; slug?: string } }) =>
        mockRecordingFindUnique(args),
      update: (args: PublishWrite) => mockRecordingUpdate(args),
      updateManyAndReturn: (args: PublishWrite) =>
        mockRecordingUpdateManyAndReturn(args),
    },
  },
}));
jest.mock("../../lib/auth-server", () => ({
  getSession: () => mockGetSession(),
}));
jest.mock("next/cache", () => ({
  revalidatePath: (path: string) => mockRevalidatePath(path),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/storage/r2-client", () => ({}));
jest.mock("../../lib/supabase-storage-core", () => ({}));

import { POST } from "../../app/api/stream/recordings/[recordingId]/publish/route";

function publish(overrides: Record<string, unknown> = {}) {
  return POST(
    new NextRequest(
      "https://example.test/api/stream/recordings/rec-1/publish",
      {
        method: "POST",
        body: JSON.stringify({
          listingTitle: "Recorded session",
          listPricePaise: 100,
          consentAttested: true,
          slug: "recorded-session",
          ...overrides,
        }),
      },
    ),
    { params: Promise.resolve({ recordingId: "rec-1" }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({
    user: { id: "host-1", consultantProfileId: "profile-1" },
  });
  mockRow = {
    id: "rec-1",
    status: "AVAILABLE",
    storageType: "PLATFORM",
    storagePath: "recordings/rec-1/attempt-1.mp4",
    listingStatus: "DRAFT",
    previewClipUrl: null,
    previewTranscript: null,
    slug: null,
    publishedAt: null,
  };
  mockBeforeWrite = () => undefined;
  mockWriteError = null;
});

describe("recording publication ownership", () => {
  it.each(["DRAFT", "UNPUBLISHED", "PUBLISHED"] as const)(
    "publishes or re-publishes an unchanged %s recording",
    async (listingStatus) => {
      mockRow.listingStatus = listingStatus;
      mockRow.slug = "recorded-session";
      const response = await publish();
      expect(response.status).toBe(201);
      expect(mockRow).toMatchObject({
        status: "AVAILABLE",
        listingStatus: "PUBLISHED",
        slug: "recorded-session",
      });
      expect(mockRevalidatePath).toHaveBeenCalledWith("/explore/recordings");
    },
  );

  it("refuses publication when retention expires the loaded recording before the write", async () => {
    mockBeforeWrite = () => {
      mockRow.status = "EXPIRED";
    };
    const response = await publish();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "RECORDING_CHANGED" });
    expect(mockRow).toMatchObject({
      status: "EXPIRED",
      listingStatus: "DRAFT",
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("refuses to publish a different object than the one validated", async () => {
    mockBeforeWrite = () => {
      mockRow.storagePath = "recordings/rec-1/attempt-2.mp4";
    };
    const response = await publish();
    expect(response.status).toBe(409);
    expect(mockRow.listingStatus).toBe("DRAFT");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("preserves an unpublish that wins before a re-publish writes", async () => {
    mockRow.listingStatus = "PUBLISHED";
    mockBeforeWrite = () => {
      mockRow.listingStatus = "UNPUBLISHED";
    };
    const response = await publish();
    expect(response.status).toBe(409);
    expect(mockRow.listingStatus).toBe("UNPUBLISHED");
  });

  it("refuses a newly added preview clip that the transcript gate did not examine", async () => {
    mockBeforeWrite = () => {
      mockRow.previewClipUrl = "https://example.test/new-clip.mp4";
    };
    const response = await publish();
    expect(response.status).toBe(409);
    expect(mockRow.listingStatus).toBe("DRAFT");
  });

  it("preserves a stored transcript change after preview validation", async () => {
    mockRow.previewClipUrl = "https://example.test/clip.mp4";
    mockRow.previewTranscript = "Original transcript";
    mockBeforeWrite = () => {
      mockRow.previewTranscript = "Corrected transcript";
    };
    const response = await publish();
    expect(response.status).toBe(409);
    expect(mockRow.previewTranscript).toBe("Corrected transcript");
    expect(mockRow.listingStatus).toBe("DRAFT");
  });

  it("requires explicit consent attestation before any publication write", async () => {
    const response = await publish({ consentAttested: false });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(mockRecordingUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it.each([0, -1, 99])(
    "refuses a %i paise list price before any publication write",
    async (listPricePaise) => {
      const response = await publish({ listPricePaise });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
      expect(mockRecordingUpdateManyAndReturn).not.toHaveBeenCalled();
      expect(mockRecordingUpdate).not.toHaveBeenCalled();
    },
  );

  it("requires the durable object pointer before attempting to publish", async () => {
    mockRow.storagePath = null;
    const response = await publish();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "STORAGE_POLICY" });
    expect(mockRecordingUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it("preserves the concurrent slug-conflict response", async () => {
    mockWriteError = new Prisma.PrismaClientKnownRequestError(
      "Unique slug conflict",
      {
        code: "P2002",
        clientVersion: "7.10.0",
      },
    );
    const response = await publish();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SLUG_TAKEN" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
