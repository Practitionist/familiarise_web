/**
 * @jest-environment node
 */

/**
 * #1517 — `detect-consultant-no-shows` had no HTTP twin, unlike every other
 * cleanup job, so neither the Netlify ticker nor a hand-rolled `CRON_SECRET`
 * probe could drive it. Pins the things a new twin must get right: the shared
 * `cleanupRoute` 401 gate, that a real call reaches the same core the GitHub
 * Actions job runs, and that the ticker's `?limit=` reaches it as
 * `maxCandidates` (#1775 made the twin read it).
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

import type { NextRequest } from "next/server";

import { POST } from "../../app/api/cleanup/[job]/route";
import { detectConsultantNoShows } from "../../scripts/appointments/detect-consultant-no-shows";

const mockDetect = detectConsultantNoShows as jest.Mock;
const SECRET = "test-cron-secret";

/**
 * The shape `cleanupRoute` promises its `run` callback: `NextRequest`, which
 * carries `nextUrl`. This twin now READS `?limit=` (#1775 — the cohort read had
 * no `take` at all, so the ticker's `limit=10` used to be appended to this URL
 * and discarded), and the parser reads the query off `nextUrl`. A bare `Request`
 * has no `nextUrl`, so `run` throws before the detector is ever called, the
 * factory's catch answers 500, and the failure surfaces as a 0-call assertion
 * rather than as the missing `nextUrl` it is. Same construction the
 * overage-charge twin's test uses.
 */
function request(
  auth: string | null = `Bearer ${SECRET}`,
  query = "",
): NextRequest {
  const headers = new Headers();
  if (auth !== null) headers.set("authorization", auth);
  return {
    headers,
    nextUrl: new URL(
      `http://localhost/api/cleanup/detect-consultant-no-shows${query}`,
    ),
  } as unknown as NextRequest;
}

function post(req: NextRequest) {
  return POST(req, {
    params: Promise.resolve({ job: "detect-consultant-no-shows" }),
  });
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
    const res = await post(request(null));

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

    const res = await post(request());

    // Without `?limit=` the registry's floor still bounds the run.
    expect(mockDetect).toHaveBeenCalledTimes(1);
    expect(mockDetect).toHaveBeenCalledWith({ maxCandidates: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ detected: 2, refunded: 2 });
  });

  // A sweep is allowed to move ZERO rows, so the report is the counters and
  // nothing else — the point pinned here is that the bit reaches the core at
  // all, and that an empty run is still a 200 rather than a failure the ticker
  // would page on.
  it("forwards the ticker's bite and reports an empty run as a clean 200", async () => {
    mockDetect.mockResolvedValue({
      success: true,
      detected: 0,
      refunded: 0,
      contradicted: 0,
      bothAbsentTickets: 0,
      errors: [],
      timestamp: "2026-09-13T00:00:00.000Z",
    });

    const res = await post(request(`Bearer ${SECRET}`, "?limit=4"));

    expect(mockDetect).toHaveBeenCalledWith({ maxCandidates: 4 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ detected: 0, refunded: 0 });
  });
});
