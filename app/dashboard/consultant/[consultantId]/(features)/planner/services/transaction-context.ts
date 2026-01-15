/**
 * TransactionContext provides instance-scoped state for planner operations.
 * This replaces the static class properties that caused race conditions
 * when multiple consultants saved events simultaneously.
 */
export class TransactionContext {
  /** IDs of topics created during this transaction (for rollback) */
  createdTopicIds: string[] = [];

  /** ID of event created during this transaction (for rollback) */
  createdEventId: string | null = null;

  /** Type of event created during this transaction (for rollback) */
  createdEventType: "webinar" | "class" | null = null;

  /**
   * Track a newly created topic ID for potential rollback
   */
  trackTopic(topicId: string): void {
    this.createdTopicIds.push(topicId);
  }

  /**
   * Track multiple topic IDs for potential rollback
   */
  trackTopics(topicIds: string[]): void {
    this.createdTopicIds.push(...topicIds);
  }

  /**
   * Track a newly created event for potential rollback
   */
  trackEvent(eventId: string, eventType: "webinar" | "class"): void {
    this.createdEventId = eventId;
    this.createdEventType = eventType;
  }

  /**
   * Check if there are topics to rollback
   */
  hasTopicsToRollback(): boolean {
    return this.createdTopicIds.length > 0;
  }

  /**
   * Check if there is an event to rollback
   */
  hasEventToRollback(): boolean {
    return this.createdEventId !== null && this.createdEventType !== null;
  }

  /**
   * Clear all tracked resources (call after successful transaction)
   */
  clear(): void {
    this.createdTopicIds = [];
    this.createdEventId = null;
    this.createdEventType = null;
  }

  /**
   * Rollback newly created topics
   */
  async rollbackTopics(): Promise<void> {
    if (!this.hasTopicsToRollback()) {
      return;
    }

    try {
      const response = await fetch("/api/user/content/topics", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: this.createdTopicIds }),
      });

      if (!response.ok) {
        console.error(
          "[TransactionContext] Failed to rollback topics, status:",
          response.status,
        );
      }
    } catch (error) {
      console.error("[TransactionContext] Error during topic rollback:", error);
    } finally {
      this.createdTopicIds = [];
    }
  }

  /**
   * Rollback newly created event
   */
  async rollbackEvent(): Promise<void> {
    if (!this.hasEventToRollback()) {
      return;
    }

    try {
      const endpoint =
        this.createdEventType === "webinar"
          ? "/api/events/webinars"
          : "/api/events/classes";

      const response = await fetch(`${endpoint}/${this.createdEventId}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        console.error(
          `[TransactionContext] Failed to rollback ${this.createdEventType}, status:`,
          response.status,
        );
      }
    } catch (error) {
      console.error(
        `[TransactionContext] Error during ${this.createdEventType} rollback:`,
        error,
      );
    } finally {
      this.createdEventId = null;
      this.createdEventType = null;
    }
  }

  /**
   * Rollback all created resources in reverse order (event first, then topics)
   */
  async rollbackAll(): Promise<void> {
    await this.rollbackEvent();
    await this.rollbackTopics();
  }
}
