/**
 * @jest-environment node
 */

/**
 * #1517 — `detect-consultant-no-shows` had no HTTP twin, unlike every other
 * cleanup job, so neither the Netlify ticker nor a hand-rolled `CRON_SECRET`
 * probe could drive it. Pins the two things a new twin must get right: the
 * shared `cleanupRoute` 401 gate, and that a real call reaches the same core
 * the GitHub Actions job runs.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class MaintenanceActiveError extends Error {
    httpStatus = 503;
    phase: string;
    constructor(jobName: string, phase: string) {
      super(`Maintenance mode is ${phase} — ${jobName} is unavailable`);
      this.phase = phase;
    }
  },
}));

jest.mock("../../scripts/appointments/detect-consultant-no-shows", () => ({
  detectConsultantNoShows: jest.fn(),
}));

import { POST } from "../../app/api/cleanup/detect-consultant-no-shows/route";
import { detectConsultantNoShows } from "../../scripts/appointments/detect-consultant-no-shows";

const mockDetect = detectConsultantNoShows as jest.Mock;
const SECRET = "test-cron-secret";

function request(auth: string | null = `Bearer ${SECRET}`): Request {
  const headers = new Headers();
  if (auth !== null) headers.set("authorization", auth);
  return new Request(
    "http://localhost/api/cleanup/detect-consultant-no-shows",
    {
      method: "POST",
      headers,
    },
  );
}

describe("POST /api/cleanup/detect-consultant-no-shows", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, CRON_SECRET: SECRET };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("answers 401 without the cron secret and never reaches the detector", async () => {
    const res = await POST(request(null) as never);

    expect(res.status).toBe(401);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it("calls detectConsultantNoShows and reports its result on a valid call", async () => {
    mockDetect.mockResolvedValue({
      success: true,
      detected: 2,
      refunded: 2,
      contradicted: 0,
      bothAbsentTickets: 1,
      errors: [],
      timestamp: "2026-09-13T00:00:00.000Z",
    });

    const res = await POST(request() as never);

    expect(mockDetect).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ detected: 2, refunded: 2 });
  });
});
