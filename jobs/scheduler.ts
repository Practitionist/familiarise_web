import { PaymentCleanupService } from "./payment-cleanup";
import { ErrorLogger } from "@/utils/errorHandling";

// Payment cleanup scheduler
class PaymentCleanupScheduler {
  private static instance: PaymentCleanupScheduler;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): PaymentCleanupScheduler {
    if (!PaymentCleanupScheduler.instance) {
      PaymentCleanupScheduler.instance = new PaymentCleanupScheduler();
    }
    return PaymentCleanupScheduler.instance;
  }

  // Start automatic cleanup scheduler
  start(intervalMinutes: number = 15): void {
    if (this.cleanupInterval) {
      ErrorLogger.warn("Payment cleanup scheduler is already running");
      return;
    }

    const intervalMs = intervalMinutes * 60 * 1000;

    ErrorLogger.info(`Starting payment cleanup scheduler`, {
      intervalMinutes,
      intervalMs,
    });

    // Run immediately on start
    this.runCleanup();

    // Then run periodically
    this.cleanupInterval = setInterval(() => {
      this.runCleanup();
    }, intervalMs);
  }

  // Stop the scheduler
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      ErrorLogger.info("Payment cleanup scheduler stopped");
    }
  }

  // Manual cleanup trigger
  async runCleanup(): Promise<void> {
    if (this.isRunning) {
      ErrorLogger.warn("Payment cleanup already in progress, skipping");
      return;
    }

    this.isRunning = true;

    try {
      const results = await PaymentCleanupService.runComprehensiveCleanup();
      
      // Only log if there was meaningful cleanup
      if (
        results.expiredPayments > 0 ||
        results.orphanedSlots > 0 ||
        results.resolvedConflicts > 0
      ) {
        ErrorLogger.info("Scheduled payment cleanup completed", results);
      }
    } catch (error) {
      ErrorLogger.error("Scheduled payment cleanup failed", error);
    } finally {
      this.isRunning = false;
    }
  }

  // Get scheduler status
  getStatus(): {
    isScheduled: boolean;
    isRunning: boolean;
    lastRun?: Date;
  } {
    return {
      isScheduled: this.cleanupInterval !== null,
      isRunning: this.isRunning,
    };
  }
}

// Global scheduler instance
export const paymentCleanupScheduler = PaymentCleanupScheduler.getInstance();

// Auto-start scheduler in production (only if not in Vercel edge runtime)
if (
  process.env.NODE_ENV === "production" &&
  typeof window === "undefined" &&
  !process.env.VERCEL_ENV // Don't run in Vercel serverless environment
) {
  // Start with 15-minute intervals
  paymentCleanupScheduler.start(15);
  
  ErrorLogger.info("Payment cleanup scheduler auto-started in production");
}

// Graceful shutdown
process.on("SIGTERM", () => {
  ErrorLogger.info("Received SIGTERM, stopping payment cleanup scheduler");
  paymentCleanupScheduler.stop();
});

process.on("SIGINT", () => {
  ErrorLogger.info("Received SIGINT, stopping payment cleanup scheduler");
  paymentCleanupScheduler.stop();
});

export default paymentCleanupScheduler;