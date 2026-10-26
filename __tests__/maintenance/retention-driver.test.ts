/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

type PruneResult = {
  pruned: number;
  stranded: number;
  failedEmailsBodyScrubbed: number;
  failedEmailBatchesScrubbed: number;
  failedEmailsPruned: number;
  failedEmailBatchesPruned: number;
  notificationOutboxPruned: number;
  emailEventsPruned: number;
  hasMore: boolean;
};

const emptyResult = (overrides: Partial<PruneResult> = {}): PruneResult => ({
  pruned: 0,
  stranded: 0,
  failedEmailsBodyScrubbed: 0,
  failedEmailBatchesScrubbed: 0,
  failedEmailsPruned: 0,
  failedEmailBatchesPruned: 0,
  notificationOutboxPruned: 0,
  emailEventsPruned: 0,
  hasMore: false,
  ...overrides,
});

function loadDriver(dependencies: {
  prune: jest.Mock;
  disconnect: jest.Mock;
  abortMaintenance: jest.Mock;
}) {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "jobs",
    "cleanup",
    "prune-system-job-executions.ts",
  );
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });

  let run: (() => Promise<unknown>) | undefined;
  const runJob = jest.fn((_name: string, callback: () => Promise<unknown>) => {
    run = callback;
  });
  const module: { exports: Record<string, unknown> } = { exports: {} };
  const requireStub = Object.assign(
    (specifier: string) => {
      if (specifier === "dotenv/config") return {};
      if (specifier === "../../scripts/cleanup/prune-system-job-executions") {
        return {
          pruneSystemJobExecutions: dependencies.prune,
          disconnectDatabase: dependencies.disconnect,
        };
      }
      if (specifier === "../../lib/maintenance-cron") {
        return { abortIfMaintenance: dependencies.abortMaintenance };
      }
      if (specifier === "../../lib/observability/job-sentry") return { runJob };
      throw new Error(`Unexpected driver import: ${specifier}`);
    },
    { main: module },
  );

  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: requireStub,
    process: { env: {}, exitCode: 0 },
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    Date,
  });
  if (!run) throw new Error("The Actions driver did not register with runJob");
  return { run, runJob };
}

describe("system-job retention Actions driver", () => {
  const BASE_TIME = new Date("2026-10-26T03:26:00.000Z");

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("passes one original start time to every progressing slice", async () => {
    const prune = jest
      .fn()
      .mockImplementationOnce(async () => {
        jest.advanceTimersByTime(4_000);
        return emptyResult({ pruned: 1, hasMore: true });
      })
      .mockImplementationOnce(async () => {
        jest.advanceTimersByTime(4_000);
        return emptyResult({ emailEventsPruned: 2, hasMore: true });
      })
      .mockResolvedValueOnce(emptyResult());
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const abortMaintenance = jest.fn().mockResolvedValue(undefined);
    const { run, runJob } = loadDriver({ prune, disconnect, abortMaintenance });

    await run();

    expect(runJob).toHaveBeenCalledWith(
      "prune-system-job-executions",
      expect.any(Function),
    );
    expect(abortMaintenance).toHaveBeenCalledWith(
      "prune-system-job-executions",
    );
    expect(prune).toHaveBeenCalledTimes(3);
    expect(prune.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [
        { limit: 500, startedAt: BASE_TIME.getTime() },
      ]),
    );
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("stops when a slice reports no progress, even if work remains", async () => {
    const prune = jest.fn().mockResolvedValue(emptyResult({ hasMore: true }));
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const { run } = loadDriver({
      prune,
      disconnect,
      abortMaintenance: jest.fn().mockResolvedValue(undefined),
    });

    await run();

    expect(prune).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not start another slice after the shared 16-second deadline", async () => {
    const prune = jest.fn().mockImplementation(async () => {
      jest.advanceTimersByTime(16_000);
      return emptyResult({ pruned: 1, hasMore: true });
    });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const { run } = loadDriver({
      prune,
      disconnect,
      abortMaintenance: jest.fn().mockResolvedValue(undefined),
    });

    await run();

    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith({
      limit: 500,
      startedAt: BASE_TIME.getTime(),
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("caps the drain at forty slices", async () => {
    const prune = jest.fn().mockImplementation(async () => {
      jest.advanceTimersByTime(100);
      return emptyResult({ pruned: 1, hasMore: true });
    });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const { run } = loadDriver({
      prune,
      disconnect,
      abortMaintenance: jest.fn().mockResolvedValue(undefined),
    });

    await run();

    expect(prune).toHaveBeenCalledTimes(40);
    expect(
      prune.mock.calls.every(
        ([opts]) => opts.startedAt === BASE_TIME.getTime(),
      ),
    ).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects after a slice rejects", async () => {
    const prune = jest
      .fn()
      .mockRejectedValue(new Error("database unavailable"));
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const { run } = loadDriver({
      prune,
      disconnect,
      abortMaintenance: jest.fn().mockResolvedValue(undefined),
    });

    await expect(run()).rejects.toThrow("database unavailable");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
