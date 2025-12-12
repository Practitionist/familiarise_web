/**
 * TypeScript Type Definitions for Race Condition Test Suite
 */

export interface TestConfig {
  testName: string;
  category: string;
  concurrentUsers: number;
  slotTime: string;
  consultantId: string;
  expectedSuccesses: number;
  expectedConflicts: number;
  expectedErrors?: number;
  timeout?: number;
  verbose?: boolean;
}

export interface BookingResult {
  userId: string;
  status: number;
  duration: number;
  timestamp: string;
  data?: any;
  error?: string;
}

export interface TestReport {
  testName: string;
  category: string;
  passed: boolean;
  duration: number;
  results: BookingResult[];
  summary: {
    totalRequests: number;
    successes: number;
    conflicts: number;
    errors: number;
    averageDuration: number;
    p95Duration?: number;
    p99Duration?: number;
  };
  expectations: {
    expectedSuccesses: number;
    expectedConflicts: number;
    expectedErrors: number;
    actualSuccesses: number;
    actualConflicts: number;
    actualErrors: number;
  };
  timestamp: string;
}

export interface CategoryReport {
  category: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  duration: number;
  tests: TestReport[];
}

export interface SummaryReport {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  totalDuration: number;
  categories: CategoryReport[];
  timestamp: string;
  mode: "sequential" | "parallel";
}

export interface RunnerConfig {
  sequential?: boolean;
  parallel?: boolean;
  categories?: string[];
  tests?: string[];
  verbose?: boolean;
  outputJson?: boolean;
  outputMarkdown?: boolean;
}

export interface TestSlot {
  start: string;
  end: string;
}

export interface TestConsultant {
  id: string;
  name: string;
  profileId: string;
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
}
