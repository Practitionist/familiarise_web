/**
 * RazorpayX Payouts Integration
 * Handles fund transfers to consultants via RazorpayX Payouts API
 *
 * API Documentation: https://razorpay.com/docs/api/x/payouts/
 */

import * as Sentry from "@sentry/nextjs";
import crypto from "crypto";

// ============================================
// Types
// ============================================

export interface RazorpayXConfig {
  keyId: string;
  keySecret: string;
  accountNumber: string; // RazorpayX account number
  webhookSecret?: string;
}

export interface CreateContactRequest {
  name: string;
  email: string;
  contact?: string;
  type: "vendor" | "customer" | "employee" | "self";
  referenceId?: string;
  notes?: Record<string, string>;
}

export interface Contact {
  id: string;
  entity: string;
  name: string;
  email: string;
  contact: string;
  type: string;
  referenceId?: string;
  batchId?: string;
  active: boolean;
  createdAt: number;
}

export interface CreateFundAccountRequest {
  contactId: string;
  accountType: "bank_account" | "vpa";
  bankAccount?: {
    name: string;
    ifsc: string;
    accountNumber: string;
  };
  vpa?: {
    address: string; // UPI ID
  };
}

export interface FundAccount {
  id: string;
  entity: string;
  contactId: string;
  accountType: string;
  bankAccount?: {
    ifsc: string;
    bankName: string;
    name: string;
    notes: string[];
    accountNumber: string;
  };
  vpa?: {
    username: string;
    handle: string;
    address: string;
  };
  active: boolean;
  createdAt: number;
}

export interface CreatePayoutRequest {
  fundAccountId: string;
  amount: number; // in paise
  currency: string;
  mode: "NEFT" | "RTGS" | "IMPS" | "UPI";
  purpose:
    | "refund"
    | "cashback"
    | "payout"
    | "salary"
    | "utility_bill"
    | "vendor_bill";
  queueIfLowBalance?: boolean;
  referenceId?: string;
  narration?: string;
  notes?: Record<string, string>;
  idempotencyKey: string; // Required from March 2025
}

export interface RazorpayPayout {
  id: string;
  entity: string;
  fundAccountId: string;
  amount: number;
  currency: string;
  mode: string;
  purpose: string;
  fees: number;
  tax: number;
  status: RazorpayPayoutStatus;
  utr?: string; // Unique Transaction Reference
  referenceId?: string;
  narration?: string;
  batchId?: string;
  failureReason?: string;
  createdAt: number;
}

export type RazorpayPayoutStatus =
  | "queued"
  | "pending"
  | "processing"
  | "processed"
  | "reversed"
  | "cancelled"
  | "rejected";

export interface PayoutWebhookEvent {
  entity: string;
  accountId: string;
  event: string;
  containsArray: boolean;
  payload: {
    payout: {
      entity: RazorpayPayout;
    };
  };
  createdAt: number;
}

// ============================================
// RazorpayX Payouts Service
// ============================================

export class RazorpayPayoutsService {
  private config: RazorpayXConfig;
  private baseUrl = "https://api.razorpay.com/v1";

  constructor(config: RazorpayXConfig) {
    this.config = config;

    if (!config.keyId || !config.keySecret || !config.accountNumber) {
      throw new Error(
        "RazorpayX credentials not configured. Required: keyId, keySecret, accountNumber",
      );
    }
  }

  /**
   * Check if RazorpayX is configured
   */
  isConfigured(): boolean {
    return !!(
      this.config.keyId &&
      this.config.keySecret &&
      this.config.accountNumber
    );
  }

  /**
   * Make authenticated API request to RazorpayX
   */
  private async apiRequest<T>(
    method: "GET" | "POST" | "PATCH",
    endpoint: string,
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T> {
    const auth = Buffer.from(
      `${this.config.keyId}:${this.config.keySecret}`,
    ).toString("base64");

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        `RazorpayX API error: ${error.error?.description || response.statusText}`,
      );
    }

    return response.json();
  }

  // ============================================
  // Contacts API
  // ============================================

  /**
   * Create a contact (consultant) in RazorpayX
   */
  async createContact(request: CreateContactRequest): Promise<Contact> {
    return this.apiRequest<Contact>("POST", "/contacts", {
      name: request.name,
      email: request.email,
      contact: request.contact,
      type: request.type,
      reference_id: request.referenceId,
      notes: request.notes,
    });
  }

  /**
   * Fetch a contact by ID
   */
  async fetchContact(contactId: string): Promise<Contact> {
    return this.apiRequest<Contact>("GET", `/contacts/${contactId}`);
  }

  /**
   * Update a contact
   */
  async updateContact(
    contactId: string,
    updates: Partial<CreateContactRequest>,
  ): Promise<Contact> {
    return this.apiRequest<Contact>("PATCH", `/contacts/${contactId}`, {
      name: updates.name,
      email: updates.email,
      contact: updates.contact,
      type: updates.type,
      reference_id: updates.referenceId,
      notes: updates.notes,
    });
  }

  // ============================================
  // Fund Accounts API
  // ============================================

  /**
   * Create a fund account (bank account or UPI) for a contact
   */
  async createFundAccount(
    request: CreateFundAccountRequest,
  ): Promise<FundAccount> {
    const payload: Record<string, unknown> = {
      contact_id: request.contactId,
      account_type: request.accountType,
    };

    if (request.accountType === "bank_account" && request.bankAccount) {
      payload.bank_account = {
        name: request.bankAccount.name,
        ifsc: request.bankAccount.ifsc,
        account_number: request.bankAccount.accountNumber,
      };
    } else if (request.accountType === "vpa" && request.vpa) {
      payload.vpa = {
        address: request.vpa.address,
      };
    }

    return this.apiRequest<FundAccount>("POST", "/fund_accounts", payload);
  }

  /**
   * Fetch a fund account by ID
   */
  async fetchFundAccount(fundAccountId: string): Promise<FundAccount> {
    return this.apiRequest<FundAccount>(
      "GET",
      `/fund_accounts/${fundAccountId}`,
    );
  }

  /**
   * Validate a bank account via penny testing
   * Note: This creates a ₹1 transfer that is reversed
   */
  async validateBankAccount(fundAccountId: string): Promise<{
    id: string;
    status: "created" | "completed" | "failed";
    accountStatus: "valid" | "invalid" | "unknown";
  }> {
    return this.apiRequest("POST", "/fund_accounts/validations", {
      fund_account: {
        id: fundAccountId,
      },
      account_number: this.config.accountNumber,
      amount: 100, // ₹1 in paise
      currency: "INR",
      notes: {
        purpose: "bank_account_validation",
      },
    });
  }

  /**
   * #863 — current RazorpayX account balance in paise, or null when the
   * response shape isn't what we expect. Used ONLY by the pre-batch balance
   * preflight; a null is treated as "unknown" (fail-open) by the caller, so a
   * shape mismatch or transient error never blocks payouts. The exact endpoint
   * must be re-verified against the sandbox before ENABLE_LIVE_PAYOUTS flips.
   */
  async getAccountBalance(): Promise<number | null> {
    try {
      const res = await this.apiRequest<{
        balance?: number;
        balances?: Array<{ balance?: number }>;
      }>("GET", `/accounts/${encodeURIComponent(this.config.accountNumber)}`);
      if (typeof res.balance === "number") return res.balance;
      const first = res.balances?.[0]?.balance;
      return typeof first === "number" ? first : null;
    } catch {
      return null;
    }
  }

  // ============================================
  // Payouts API
  // ============================================

  /**
   * Create a payout to a fund account
   * Note: Idempotency key is REQUIRED from March 2025
   */
  async createPayout(request: CreatePayoutRequest): Promise<RazorpayPayout> {
    return this.apiRequest<RazorpayPayout>(
      "POST",
      "/payouts",
      {
        account_number: this.config.accountNumber,
        fund_account_id: request.fundAccountId,
        amount: request.amount,
        currency: request.currency,
        mode: request.mode,
        purpose: request.purpose,
        queue_if_low_balance: request.queueIfLowBalance ?? true,
        reference_id: request.referenceId,
        narration: request.narration,
        notes: request.notes,
      },
      {
        "X-Payout-Idempotency": request.idempotencyKey,
      },
    );
  }

  /**
   * Fetch a payout by ID
   */
  async fetchPayout(payoutId: string): Promise<RazorpayPayout> {
    return this.apiRequest<RazorpayPayout>("GET", `/payouts/${payoutId}`);
  }

  /**
   * Cancel a queued payout
   */
  async cancelPayout(payoutId: string): Promise<RazorpayPayout> {
    return this.apiRequest<RazorpayPayout>(
      "POST",
      `/payouts/${payoutId}/cancel`,
    );
  }

  /**
   * List payouts with filters
   */
  async listPayouts(params?: {
    fundAccountId?: string;
    mode?: string;
    status?: RazorpayPayoutStatus;
    from?: number;
    to?: number;
    count?: number;
    skip?: number;
  }): Promise<{
    entity: string;
    count: number;
    items: RazorpayPayout[];
  }> {
    const queryParams = new URLSearchParams();
    queryParams.set("account_number", this.config.accountNumber);

    if (params?.fundAccountId)
      queryParams.set("fund_account_id", params.fundAccountId);
    if (params?.mode) queryParams.set("mode", params.mode);
    if (params?.status) queryParams.set("status", params.status);
    if (params?.from) queryParams.set("from", params.from.toString());
    if (params?.to) queryParams.set("to", params.to.toString());
    if (params?.count) queryParams.set("count", params.count.toString());
    if (params?.skip) queryParams.set("skip", params.skip.toString());

    return this.apiRequest("GET", `/payouts?${queryParams.toString()}`);
  }

  // ============================================
  // Webhook Handling
  // ============================================

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!this.config.webhookSecret) {
      Sentry.logger.warn("RazorpayX webhook secret not configured");
      return false;
    }

    const expectedSignature = crypto
      .createHmac("sha256", this.config.webhookSecret)
      .update(payload)
      .digest("hex");

    // timingSafeEqual THROWS on a length mismatch, so an attacker-controlled
    // header could turn signature rejection into an unhandled exception.
    // Compare lengths first, exactly as app/api/webhooks/utils.ts does.
    if (signature.length !== expectedSignature.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  }

  /**
   * Parse and validate webhook event
   */
  parseWebhookEvent(payload: string): PayoutWebhookEvent {
    return JSON.parse(payload);
  }

  /**
   * Map RazorpayX payout status to our internal status
   */
  mapPayoutStatus(
    status: RazorpayPayoutStatus,
  ): "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED" {
    switch (status) {
      case "queued":
      case "pending":
        return "PENDING";
      case "processing":
        return "PROCESSING";
      case "processed":
        return "COMPLETED";
      case "reversed":
      case "rejected":
        return "FAILED";
      case "cancelled":
        return "CANCELLED";
      default:
        return "PENDING";
    }
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Generate idempotency key for payout
   */
  // M4 FIX: Deterministic key so retries hit the same RazorpayX idempotency slot
  generateIdempotencyKey(payoutId: string): string {
    return `payout_${payoutId}`;
  }

  /**
   * Determine payout mode based on amount
   * - IMPS: Instant, up to ₹5L per transaction
   * - NEFT: Settled in batches, no limit
   * - RTGS: For amounts > ₹2L, real-time
   * - UPI: For VPA fund accounts
   */
  determinePayoutMode(
    amount: number,
    accountType: "bank_account" | "vpa",
  ): "IMPS" | "NEFT" | "UPI" {
    if (accountType === "vpa") {
      return "UPI";
    }

    // Amount in paise
    const amountInRupees = amount / 100;

    if (amountInRupees <= 500000) {
      // ₹5L limit for IMPS
      return "IMPS";
    }

    return "NEFT";
  }
}

// ============================================
// Factory
// ============================================

let razorpayPayoutsInstance: RazorpayPayoutsService | null = null;

export function getRazorpayPayoutsService(): RazorpayPayoutsService {
  if (!razorpayPayoutsInstance) {
    razorpayPayoutsInstance = new RazorpayPayoutsService({
      keyId: process.env.RAZORPAYX_KEY_ID || process.env.RAZORPAY_KEY_ID || "",
      keySecret:
        process.env.RAZORPAYX_KEY_SECRET || process.env.RAZORPAY_SECRET || "",
      accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || "",
      webhookSecret: process.env.RAZORPAYX_WEBHOOK_SECRET,
    });
  }
  return razorpayPayoutsInstance;
}

/**
 * Check if RazorpayX Payouts is configured
 */
export function isRazorpayPayoutsConfigured(): boolean {
  try {
    const service = getRazorpayPayoutsService();
    return service.isConfigured();
  } catch {
    return false;
  }
}
