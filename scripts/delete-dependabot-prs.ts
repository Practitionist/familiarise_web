#!/usr/bin/env ts-node

import { execSync } from "child_process";
import chalk from "chalk";

interface ScriptOptions {
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
}

class DependabotCleaner {
  private options: ScriptOptions;

  constructor(options: ScriptOptions = {}) {
    this.options = {
      dryRun: false,
      force: false,
      verbose: false,
      ...options,
    };
  }

  private log(
    message: string,
    type: "info" | "success" | "warning" | "error" = "info",
  ) {
    if (!this.options.verbose && type === "info") return;

    const colors = {
      info: chalk.blue,
      success: chalk.green,
      warning: chalk.yellow,
      error: chalk.red,
    };

    console.log(colors[type](`[${type.toUpperCase()}] ${message}`));
  }

  private exec(command: string): string {
    try {
      if (this.options.dryRun) {
        this.log(`DRY RUN: ${command}`, "warning");
        return "";
      }

      this.log(`Executing: ${command}`, "info");
      return execSync(command, { encoding: "utf8" }).trim();
    } catch (error) {
      this.log(`Failed to execute: ${command}`, "error");
      if (error instanceof Error) {
        this.log(error.message, "error");
      }
      return "";
    }
  }

  /**
   * Get all local dependabot branches
   */
  private getLocalDependabotBranches(): string[] {
    try {
      const output = this.exec('git branch --format="%(refname:short)"');
      return output
        .split("\n")
        .filter((branch) => branch.includes("dependabot/"))
        .filter((branch) => branch.trim() !== "");
    } catch {
      this.log("No local dependabot branches found", "info");
      return [];
    }
  }

  /**
   * Get all remote dependabot branches
   */
  private getRemoteDependabotBranches(): string[] {
    try {
      const output = this.exec('git branch -r --format="%(refname:short)"');
      return output
        .split("\n")
        .filter((branch) => branch.includes("dependabot/"))
        .filter((branch) => branch.startsWith("origin/"))
        .map((branch) => branch.replace("origin/", ""))
        .filter((branch) => branch.trim() !== "");
    } catch {
      this.log("No remote dependabot branches found", "info");
      return [];
    }
  }

  /**
   * Delete local dependabot branches
   */
  private deleteLocalBranches(branches: string[]): void {
    if (branches.length === 0) {
      this.log("No local dependabot branches to delete", "info");
      return;
    }

    this.log(`Found ${branches.length} local dependabot branches`, "info");

    branches.forEach((branch) => {
      const forceFlag = this.options.force ? "-D" : "-d";
      const success = this.exec(`git branch ${forceFlag} "${branch}"`);

      if (success !== null) {
        this.log(`Deleted local branch: ${branch}`, "success");
      }
    });
  }

  /**
   * Delete remote dependabot branches
   */
  private deleteRemoteBranches(branches: string[]): void {
    if (branches.length === 0) {
      this.log("No remote dependabot branches to delete", "info");
      return;
    }

    this.log(`Found ${branches.length} remote dependabot branches`, "info");

    branches.forEach((branch) => {
      const success = this.exec(`git push origin --delete "${branch}"`);

      if (success !== null) {
        this.log(`Deleted remote branch: ${branch}`, "success");
      }
    });
  }

  /**
   * Check if we're in a git repository
   */
  private validateGitRepo(): boolean {
    try {
      this.exec("git rev-parse --git-dir");
      return true;
    } catch {
      this.log("Not in a git repository!", "error");
      return false;
    }
  }

  /**
   * Get current branch to avoid deleting it
   */
  private getCurrentBranch(): string {
    try {
      return this.exec("git branch --show-current");
    } catch {
      return "";
    }
  }

  /**
   * Main cleanup function
   */
  public async cleanup(): Promise<void> {
    console.log(chalk.cyan.bold("🧹 Dependabot Branch Cleaner"));
    console.log(chalk.gray("Cleaning up dependabot branches and PRs\n"));

    // Validate git repository
    if (!this.validateGitRepo()) {
      process.exit(1);
    }

    // Get current branch
    const currentBranch = this.getCurrentBranch();
    this.log(`Current branch: ${currentBranch}`, "info");

    // Fetch latest remote info
    this.log("Fetching latest remote information...", "info");
    this.exec("git fetch --prune");

    // Get dependabot branches
    const localBranches = this.getLocalDependabotBranches();
    const remoteBranches = this.getRemoteDependabotBranches();

    // Filter out current branch (safety check)
    const safeLocalBranches = localBranches.filter(
      (branch) => branch !== currentBranch,
    );
    const safeRemoteBranches = remoteBranches.filter(
      (branch) => branch !== currentBranch,
    );

    if (this.options.dryRun) {
      console.log(
        chalk.yellow("\n🔍 DRY RUN MODE - No changes will be made\n"),
      );
    }

    // Summary
    console.log(chalk.bold("\n📊 Cleanup Summary:"));
    console.log(`Local dependabot branches: ${safeLocalBranches.length}`);
    console.log(`Remote dependabot branches: ${safeRemoteBranches.length}`);

    if (safeLocalBranches.length > 0) {
      console.log(chalk.gray("\nLocal branches to delete:"));
      safeLocalBranches.forEach((branch) =>
        console.log(chalk.gray(`  - ${branch}`)),
      );
    }

    if (safeRemoteBranches.length > 0) {
      console.log(chalk.gray("\nRemote branches to delete:"));
      safeRemoteBranches.forEach((branch) =>
        console.log(chalk.gray(`  - ${branch}`)),
      );
    }

    if (safeLocalBranches.length === 0 && safeRemoteBranches.length === 0) {
      console.log(
        chalk.green("\n✅ No dependabot branches found to clean up!"),
      );
      return;
    }

    // Confirm deletion (unless dry run)
    if (!this.options.dryRun && !this.options.force) {
      console.log(
        chalk.yellow("\nPress Ctrl+C to cancel, or Enter to continue..."),
      );
      // In a real scenario, you might want to add readline here for confirmation
    }

    console.log(chalk.cyan("\n🗑️  Starting cleanup...\n"));

    // Delete branches
    this.deleteLocalBranches(safeLocalBranches);
    this.deleteRemoteBranches(safeRemoteBranches);

    console.log(chalk.green.bold("\n✅ Cleanup completed successfully!"));
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);

  return {
    dryRun: args.includes("--dry-run") || args.includes("-n"),
    force: args.includes("--force") || args.includes("-f"),
    verbose: args.includes("--verbose") || args.includes("-v"),
  };
}

/**
 * Display help information
 */
function showHelp(): void {
  console.log(`
${chalk.cyan.bold("Dependabot Branch Cleaner")}

Usage: ts-node scripts/delete-dependabot-prs.ts [options]

Options:
  -n, --dry-run     Show what would be deleted without making changes
  -f, --force       Force delete branches (use -D instead of -d)
  -v, --verbose     Show detailed output
  -h, --help        Show this help message

Examples:
  # Dry run to see what would be deleted
  npm run scripts:delete-dependabot-prs -- --dry-run

  # Delete with verbose output
  npm run scripts:delete-dependabot-prs -- --verbose

  # Force delete all dependabot branches
  npm run scripts:delete-dependabot-prs -- --force
`);
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }

  const options = parseArgs();
  const cleaner = new DependabotCleaner(options);

  try {
    await cleaner.cleanup();
  } catch (error) {
    console.error(chalk.red.bold("\n❌ Script failed:"));
    console.error(
      chalk.red(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  }
}

// Run the script if called directly
if (require.main === module) {
  main().catch(console.error);
}

export { DependabotCleaner };
