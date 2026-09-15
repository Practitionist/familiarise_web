// #1124 — the idle-lag probe both perf routes run. Imports Node built-ins only,
// so the bare route's import graph stays empty of application code.
import { randomUUID } from "node:crypto";

// A fresh id per module evaluation — the only instance identity the platform
// exposes, since the function log carries no Init Duration line (#1124).
const instanceId = randomUUID();

const IDLE_ITERATIONS = 8;
const IDLE_SLEEP_MS = 50;
const STALL_GAP_MS = 1_000;

export interface IdleProbe {
  iterations: number;
  maxGapMs: number;
  totalMs: number;
  gapsOver1s: number[];
}

export interface ProbeReport {
  uptimeAtEntryMs: number;
  moduleAgeMs: number;
  idleProbe: IdleProbe;
  region: string;
  memoryMb: number;
  instanceId: string;
}

// 400 ms of pure idle awaiting, sampled every 50 ms, as in #1123. A timer that
// wakes more than a second late is the event-loop stall, not the probe.
async function runIdleProbe(): Promise<IdleProbe> {
  const started = performance.now();
  let maxGapMs = 0;
  const gapsOver1s: number[] = [];
  for (let i = 0; i < IDLE_ITERATIONS; i++) {
    const armed = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, IDLE_SLEEP_MS));
    const gap = Math.round(performance.now() - armed - IDLE_SLEEP_MS);
    if (gap > maxGapMs) maxGapMs = gap;
    if (gap > STALL_GAP_MS) gapsOver1s.push(gap);
  }
  return {
    iterations: IDLE_ITERATIONS,
    maxGapMs,
    totalMs: Math.round(performance.now() - started),
    gapsOver1s,
  };
}

export async function runProbe(moduleLoadedAt: number): Promise<ProbeReport> {
  const uptimeAtEntryMs = Math.round(process.uptime() * 1000);
  const moduleAgeMs = Date.now() - moduleLoadedAt;
  const idleProbe = await runIdleProbe();
  return {
    uptimeAtEntryMs,
    moduleAgeMs,
    idleProbe,
    region: process.env.AWS_REGION ?? "unknown",
    memoryMb: Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE) || 0,
    instanceId,
  };
}
