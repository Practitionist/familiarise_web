/**
 * In-app copy for the organisation workflows (ADR 23). Categories follow the
 * audience, per docs/enterprise/50-operations/10-novu-console-conditions.md:
 * an operator who wants invoices but not roster churn, and an expert who
 * wants the reverse, are the two cases the split serves.
 */

import { NOVU_WORKFLOWS as W } from "../workflows";
import type { WorkflowTemplate } from "./types";

export const ORG_TEMPLATES: WorkflowTemplate[] = [
  // ── Billing ─────────────────────────────────────────────────────────────
  {
    workflowId: W.ORG_INVOICE_ISSUED,
    name: "Org invoice issued",
    description: "Billing admins, when an invoice is raised.",
    category: "orgBilling",
    inApp: {
      subject: "Invoice issued",
      body: "Invoice {{payload.invoiceNumber}} for {{payload.total}} is due on {{payload.dueDate}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_INVOICE_PAID,
    name: "Org invoice paid",
    description: "Billing admins, when payment settles an invoice.",
    category: "orgBilling",
    inApp: {
      subject: "Invoice paid",
      body: "Invoice {{payload.invoiceNumber}} for {{payload.total}} was paid on {{payload.paidAt}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_INVOICE_OVERDUE,
    name: "Org invoice overdue",
    description: "Billing admins. `reminderStage` counts the dunning notices.",
    category: "orgBilling",
    inApp: {
      subject: "Invoice overdue",
      body: "Invoice {{payload.invoiceNumber}} for {{payload.total}} is {{payload.daysLate}} day{% if payload.daysLate != 1 %}s{% endif %} overdue.{% if payload.reminderStage >= 1 %} This is reminder {{payload.reminderStage}}.{% endif %}",
      redirect: "payUrl",
    },
  },
  {
    workflowId: W.ORG_WALLET_TOPUP_CONFIRMED,
    name: "Org wallet topped up",
    description: "Billing admins, when a top-up is captured.",
    category: "orgBilling",
    inApp: {
      subject: "Wallet topped up",
      body: "{{payload.amount}} was added to {{payload.orgName}}'s wallet. New balance: {{payload.newBalance}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_WALLET_LOW,
    name: "Org wallet low",
    description:
      "Billing admins, when the balance drops below the floor (#777).",
    category: "orgBilling",
    inApp: {
      subject: "Wallet running low",
      body: "{{payload.orgName}}'s wallet is down to {{payload.balance}}, below the {{payload.minimum}} minimum. Top up to keep bookings flowing.",
      redirect: "topUpUrl",
    },
  },
  {
    workflowId: W.ORG_PAYOUT_COMPLETED,
    name: "Org payout sent",
    description:
      "Billing admins, when a payout leaves for the org's bank. `amount` is the received (post-TDS) figure; `withheld` names the TDS slice (#1474).",
    category: "orgBilling",
    inApp: {
      subject: "Payout sent",
      body: "A payout of {{payload.amount}} to {{payload.orgName}} has been sent.{% if payload.withheld %} {{payload.withheld}} was withheld as TDS.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_PAYOUT_FAILED,
    name: "Org payout failed",
    description: "Billing admins. `reason` is the gateway's sentence.",
    category: "orgBilling",
    inApp: {
      subject: "Payout failed",
      body: "A payout of {{payload.amount}} to {{payload.orgName}} failed{% if payload.reason %}: {{payload.reason}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_PAYOUT_REVERSED,
    name: "Org payout reversed",
    description:
      "Billing admins, when the bank returns a payout. `amount` is the cash that went out and came back (post-TDS, #1474).",
    category: "orgBilling",
    inApp: {
      subject: "Payout reversed",
      body: "A payout of {{payload.amount}} to {{payload.orgName}} was reversed{% if payload.reason %}: {{payload.reason}}{% endif %}{% if payload.withheld %} (includes {{payload.withheld}} withheld as TDS, netted on the return){% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_MEMBER_OVERAGE_TIMED_OUT,
    name: "Member overage lapsed",
    description: "The member, when their side-charge window closes (#779).",
    category: "orgBilling",
    inApp: {
      subject: "Payment window closed",
      body: "The payment window for your {{payload.programName}} overage of {{payload.amount}} at {{payload.orgName}} has closed. Contact your programme administrator to continue.",
      redirect: "payUrl",
    },
  },
  {
    workflowId: W.ORG_PROGRAM_OVERAGE_DUE,
    name: "Member overage due",
    description: "The member, when an over-cap booking creates a side-charge.",
    category: "orgBilling",
    inApp: {
      subject: "Payment due",
      body: "Your booking went over the {{payload.programName}} allowance at {{payload.orgName}}. {{payload.amount}} is due from you to keep it.",
      redirect: "payUrl",
    },
  },
  {
    workflowId: W.ORG_CONTRACT_STATUS_CHANGED,
    name: "Enterprise contract updated",
    description:
      "Org owners and operators, when an enterprise contract activates, renews or ends.",
    category: "orgBilling",
    inApp: {
      subject: "Contract status updated",
      body: "{{payload.orgName}}'s enterprise contract is now {{payload.status | downcase | replace: '_', ' '}}{% if payload.effectiveDate %} ({{payload.effectiveDate}}){% endif %}.",
      redirect: "dashboardUrl",
    },
  },

  // ── Membership ──────────────────────────────────────────────────────────
  {
    workflowId: W.ORG_CREATED,
    name: "Organisation created",
    description: "The organisation owner upon workspace creation.",
    category: "orgMembership",
    inApp: {
      subject: "Organisation ready",
      body: "{{payload.orgName}} has been created. Open your workspace settings to invite your team.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_INVITE_SENT,
    name: "Org invite",
    description: "The invitee.",
    category: "orgMembership",
    inApp: {
      subject: "You're invited",
      body: "{{payload.inviterName}} invited you to join {{payload.orgName}} as {{payload.role | downcase | replace: '_', ' '}}. The invitation expires on {{payload.expiresAt}}.",
      redirect: "inviteUrl",
    },
  },
  {
    workflowId: W.ORG_INVITE_ACCEPTED,
    name: "Org invite accepted",
    description: "Org admins, when an invitee joins.",
    category: "orgMembership",
    inApp: {
      subject: "New member",
      body: "{{payload.accepteeName}} ({{payload.accepteeEmail}}) joined {{payload.orgName}} as {{payload.role | downcase | replace: '_', ' '}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_ROLE_CHANGED,
    name: "Member role changed",
    description: "The affected organisation member when their role changes.",
    category: "orgMembership",
    inApp: {
      subject: "Role updated",
      body: "Your role in {{payload.orgName}} was updated{% if payload.newRole %} to {{payload.newRole | downcase | replace: '_', ' '}}{% endif %}{% if payload.changedByName %} by {{payload.changedByName}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_MEMBER_REMOVED,
    name: "Removed from organisation",
    description: "The removed non-expert member of an organisation.",
    category: "orgMembership",
    inApp: {
      subject: "Removed from organisation",
      body: "You are no longer a member of {{payload.orgName}}{% if payload.removedByName %} (removed by {{payload.removedByName}}){% endif %}{% if payload.reason %}: {{payload.reason}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_EXPERT_REMOVED,
    name: "Removed from org",
    description: "The consultant whose EXPERT membership was removed.",
    category: "orgMembership",
    inApp: {
      subject: "Membership ended",
      body: "You were removed from {{payload.orgName}} by {{payload.removedByName}}{% if payload.reason %}: {{payload.reason}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_SSO_PROVIDER_SUBMITTED,
    name: "SSO provider submitted",
    description:
      "Platform admins when an organisation submits an OIDC/SSO provider.",
    category: "orgMembership",
    inApp: {
      subject: "SSO provider submitted",
      body: "{{payload.orgName}} registered SSO provider {{payload.providerId}} for review.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_SSO_PROVIDER_DECIDED,
    name: "SSO provider reviewed",
    description: "Org owners when staff approve or revoke their SSO provider.",
    category: "orgMembership",
    inApp: {
      subject:
        "{% if payload.decision == 'APPROVED' %}SSO provider approved{% else %}SSO provider revoked{% endif %}",
      body: "{% if payload.decision == 'APPROVED' %}SSO provider {{payload.providerId}} for {{payload.orgName}} is approved and ready to use.{% else %}SSO provider {{payload.providerId}} for {{payload.orgName}} was revoked{% if payload.reason %}: {{payload.reason}}{% endif %}.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_SSO_PROVIDER_DELETED,
    name: "SSO provider removed",
    description: "Org admins.",
    category: "orgMembership",
    inApp: {
      subject: "SSO removed",
      body: "{{payload.deletedByName}} removed the SSO provider {{payload.providerId}} from {{payload.orgName}}. Members now sign in with email.",
      redirect: "dashboardUrl",
    },
  },

  // ── Programmes ──────────────────────────────────────────────────────────
  {
    workflowId: W.ORG_SEAT_ASSIGNED,
    name: "Programme seat assigned",
    description: "The member assigned a seat in an enterprise programme.",
    category: "orgProgram",
    inApp: {
      subject: "Programme seat assigned",
      body: "You have been assigned a seat in {{payload.programName}} at {{payload.orgName}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_SEAT_REVOKED,
    name: "Programme seat removed",
    description:
      "The member whose seat in an enterprise programme was removed.",
    category: "orgProgram",
    inApp: {
      subject: "Programme seat removed",
      body: "Your seat in {{payload.programName}} at {{payload.orgName}} has ended{% if payload.reason %}: {{payload.reason}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_PROGRAM_EXHAUSTED,
    name: "Programme cap reached",
    description: "Org admins, when an assignee hits 100% of their cap.",
    category: "orgProgram",
    inApp: {
      subject: "Programme cap reached",
      body: "{{payload.assigneeName}} has used every engagement in {{payload.programName}} at {{payload.orgName}}. Further bookings will be refused until the cap is raised.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_PROGRAM_CAP_NEAR,
    name: "Programme cap near",
    description: "Org admins, on the 80% crossing.",
    category: "orgProgram",
    inApp: {
      subject: "Programme nearly used up",
      body: "{{payload.assigneeName}} has used {{payload.engagementsUsed}} of {{payload.cap}} engagement{% if payload.cap != 1 %}s{% endif %} ({{payload.usedPct}}%) in {{payload.programName}} at {{payload.orgName}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_LICENSE_RENEWAL_UPCOMING,
    name: "Licence renewal upcoming",
    description: "Billing admins, ahead of a licence cycle renewing.",
    category: "orgProgram",
    inApp: {
      subject: "Licence renews soon",
      body: "{{payload.orgName}}'s {{payload.cycle}} licence renews on {{payload.renewalDate}} — {{payload.daysUntilRenewal}} day{% if payload.daysUntilRenewal != 1 %}s{% endif %} away — for about {{payload.expectedTotal}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_DATA_EXPORT_READY,
    name: "Data export ready",
    description: "The admin who requested the export.",
    category: "orgProgram",
    inApp: {
      subject: "Export ready",
      body: "The data export for {{payload.orgName}} is ready to download. The link expires on {{payload.expiresAt}}.",
      redirect: "downloadUrl",
    },
  },
];
