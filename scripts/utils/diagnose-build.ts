#!/usr/bin/env ts-node

/**
 * Build Diagnostics Tool
 *
 * This script helps diagnose Next.js build failures by:
 * 1. Running the build with verbose logging
 * 2. Checking for common failure patterns
 * 3. Providing actionable recommendations
 *
 * Usage: npx ts-node -P tsconfig.scripts.json scripts/diagnose-build.ts
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

// ANSI color codes for better output formatting
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

interface ErrorPattern {
  pattern: RegExp;
  issue: string;
  solution: string;
}

interface FoundIssue {
  issue: string;
  details: string;
  solution: string;
}

console.log(
  `${colors.bold}${colors.blue}Next.js Build Diagnostics Tool${colors.reset}\n`,
);
console.log(
  `${colors.cyan}Analyzing your project for build issues...${colors.reset}\n`,
);

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Log file paths
const buildLogPath = path.join(logsDir, "build-full.log");
const errorLogPath = path.join(logsDir, "build-errors.log");
const diagnosticsPath = path.join(logsDir, "build-diagnostics.log");

// Run the build with verbose output
try {
  console.log(
    `${colors.cyan}Running Next.js build with verbose logging...${colors.reset}`,
  );

  // Set environment variables for more verbose output
  const env = {
    ...process.env,
    NODE_OPTIONS: "--trace-warnings",
    NEXT_TELEMETRY_DEBUG: "1",
    DEBUG: "*",
  };

  // Run the build and capture output
  execSync("npx prisma generate && npx next build", {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

  console.log(`${colors.green}Build completed successfully!${colors.reset}`);
  process.exit(0);
} catch (error) {
  // Properly type the error object
  const buildError = error as { stderr?: Buffer; stdout?: Buffer };
  // Build failed, capture the output
  const errorOutput = buildError.stderr ? buildError.stderr.toString() : "";
  const stdOutput = buildError.stdout ? buildError.stdout.toString() : "";
  const fullOutput = stdOutput + "\n" + errorOutput;

  // Write full build log
  fs.writeFileSync(buildLogPath, fullOutput);

  // Extract and write only error messages
  const errorLines = fullOutput
    .split("\n")
    .filter(
      (line) =>
        line.includes("Error:") ||
        line.includes("error") ||
        line.includes("ERROR") ||
        line.includes("warning:") ||
        line.includes("Warning:"),
    );
  fs.writeFileSync(errorLogPath, errorLines.join("\n"));

  // Begin diagnostics
  console.log(
    `${colors.red}Build failed. Starting diagnostics...${colors.reset}\n`,
  );

  const diagnosticsReport: string[] = [];
  diagnosticsReport.push("# Next.js Build Failure Diagnostics");
  diagnosticsReport.push(`Generated: ${new Date().toISOString()}\n`);

  // Check for common error patterns
  const errorPatterns: ErrorPattern[] = [
    {
      pattern: /You are using Node\.js (\S+)\. For Next\.js, Node\.js version/,
      issue: "Node.js Version Incompatibility",
      solution:
        "Update your Node.js version to match the requirements for your Next.js version.",
    },
    {
      pattern: /(.*) is defined but never used/,
      issue: "Unused Import/Variable",
      solution:
        'Remove unused imports or variables, or run "npm run fix:imports" to fix automatically.',
    },
    {
      pattern: /Cannot find module '(.*)'/,
      issue: "Missing Module",
      solution:
        "Install the missing dependency or check for typos in import statements.",
    },
    {
      pattern: /Type error:/,
      issue: "TypeScript Type Error",
      solution:
        "Fix the type issues in your code or add proper type definitions.",
    },
    {
      pattern: /Invalid configuration/,
      issue: "Invalid Next.js Configuration",
      solution: "Check your next.config.js file for errors or invalid options.",
    },
    {
      pattern: /Failed to compile/,
      issue: "Compilation Error",
      solution:
        "Check the specific error messages above for details on what failed to compile.",
    },
    {
      pattern: /Out of Memory/,
      issue: "Memory Limit Exceeded",
      solution:
        'Increase Node.js memory limit using NODE_OPTIONS="--max-old-space-size=4096"',
    },
    {
      pattern: /ENOSPC/,
      issue: "File Watching Limit Exceeded",
      solution:
        "Increase system file watching limits (common on Linux systems).",
    },
  ];

  // Check for each error pattern
  const foundIssues: FoundIssue[] = [];
  errorPatterns.forEach(({ pattern, issue, solution }) => {
    const match = fullOutput.match(pattern);
    if (match) {
      const details = match[1] ? match[1] : "";
      foundIssues.push({ issue, details, solution });

      diagnosticsReport.push(`## ${issue}`);
      if (details) diagnosticsReport.push(`Details: ${details}`);
      diagnosticsReport.push(`Solution: ${solution}\n`);
    }
  });

  // Check for ESLint errors specifically
  const eslintErrors = errorLines.filter(
    (line) => line.includes("Error:") && line.match(/\d+:\d+/),
  );
  if (eslintErrors.length > 0) {
    foundIssues.push({
      issue: "ESLint Errors",
      details: `${eslintErrors.length} ESLint errors found`,
      solution:
        'Run "npm run lint:fix" to attempt automatic fixes or modify your ESLint configuration.',
    });

    diagnosticsReport.push("## ESLint Errors");
    diagnosticsReport.push(
      `Found ${eslintErrors.length} ESLint errors that need to be fixed.`,
    );
    diagnosticsReport.push(
      'Solution: Run "npm run lint:fix" or fix the errors manually.\n',
    );
    diagnosticsReport.push("### ESLint Error Details:");
    eslintErrors.slice(0, 10).forEach((line) => {
      diagnosticsReport.push(`- ${line.trim()}`);
    });
    if (eslintErrors.length > 10) {
      diagnosticsReport.push(
        `- ... and ${eslintErrors.length - 10} more errors`,
      );
    }
    diagnosticsReport.push("");
  }

  // If no known issues found, provide general advice
  if (foundIssues.length === 0) {
    diagnosticsReport.push("## Unidentified Issue");
    diagnosticsReport.push("No common error patterns were detected.");
    diagnosticsReport.push("### Recommendations:");
    diagnosticsReport.push(
      "1. Check the full build log for specific error messages",
    );
    diagnosticsReport.push("2. Verify your dependencies are up to date");
    diagnosticsReport.push("3. Try clearing the Next.js cache: `rm -rf .next`");
    diagnosticsReport.push("4. Check for syntax errors in your code");
    diagnosticsReport.push(
      "5. Verify your environment variables are correctly set",
    );
  }

  // Write diagnostics report
  fs.writeFileSync(diagnosticsPath, diagnosticsReport.join("\n"));

  // Display results to the console
  console.log(
    `${colors.bold}${colors.yellow}Diagnostic Results:${colors.reset}\n`,
  );

  if (foundIssues.length > 0) {
    foundIssues.forEach(({ issue, details, solution }) => {
      console.log(`${colors.bold}${colors.red}Issue:${colors.reset} ${issue}`);
      if (details)
        console.log(`${colors.bold}Details:${colors.reset} ${details}`);
      console.log(
        `${colors.bold}${colors.green}Solution:${colors.reset} ${solution}\n`,
      );
    });
  } else {
    console.log(
      `${colors.yellow}No common error patterns detected. Check the full logs for details.${colors.reset}\n`,
    );
  }

  console.log(`${colors.bold}Logs saved to:${colors.reset}`);
  console.log(`- Full build log: ${buildLogPath}`);
  console.log(`- Error summary: ${errorLogPath}`);
  console.log(`- Diagnostics report: ${diagnosticsPath}\n`);

  console.log(
    `${colors.cyan}For more help, review the logs or run with specific debugging flags:${colors.reset}`,
  );
  console.log(`- DEBUG=* npm run build (for Next.js internal debugging)`);
  console.log(
    `- NODE_OPTIONS="--inspect" npm run build (for Node.js debugging)\n`,
  );

  process.exit(1);
}
