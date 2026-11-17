/**
 * Pins the manifest against the ways the live templates went wrong: an event
 * the app triggers with no template behind it (48 of them, silently
 * `workflow_not_found`), a body naming a payload field without its namespace
 * (`{{status}}` rendered empty in every legacy template), and a family count
 * above the plan's 20-workflow cap.
 */

// humanize.ts reaches prisma for recipient timezones; nothing here does.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import {
  EVENT_FAMILY,
  FALLBACK_HREF,
  FAMILIES,
  NOVU_WORKFLOW_TEMPLATES,
  familyOf,
  templatesInFamily,
  toFamilyDto,
  toWire,
} from "@/lib/novu/templates";
import type { NovuWorkflowId } from "@/lib/novu/templates/types";
import { Liquid } from "liquidjs";
import { supportTicketStatusLabel } from "@/lib/novu/humanize";

/** Every identifier a Liquid output or control tag can name. */
const LIQUID_OUTPUT = /\{\{-?\s*([a-zA-Z_][\w.]*)/g;
const LIQUID_TAG = /\{%-?\s*([\s\S]*?)\s*-?%\}/g;
const LIQUID_KEYWORDS = new Set([
  "if",
  "elsif",
  "else",
  "endif",
  "unless",
  "endunless",
  "case",
  "when",
  "endcase",
  "and",
  "or",
  "contains",
  "true",
  "false",
  "nil",
  "null",
  "empty",
  "blank",
]);

/** Identifiers referenced anywhere in a template's Liquid. */
function liquidIdentifiers(text: string): string[] {
  const found: string[] = [];
  for (const [, v] of text.matchAll(LIQUID_OUTPUT)) found.push(v);
  for (const [, tag] of text.matchAll(LIQUID_TAG)) {
    const withoutStrings = tag.replace(/"[^"]*"|'[^']*'/g, " ");
    for (const [token] of withoutStrings.matchAll(/[a-zA-Z_][\w.]*/g)) {
      if (!LIQUID_KEYWORDS.has(token)) found.push(token);
    }
  }
  return found;
}
const NOVU_WORKFLOW_CAP = 20;

describe("Novu workflow templates", () => {
  const ids = Object.values(NOVU_WORKFLOWS);

  it("covers every event the app can trigger, exactly once, in exactly one family", () => {
    expect(NOVU_WORKFLOW_TEMPLATES.map((t) => t.workflowId).sort()).toEqual(
      [...ids].sort(),
    );
    expect(Object.keys(EVENT_FAMILY).sort()).toEqual([...ids].sort());
  });

  it("fits the plan's workflow cap with room to spare", () => {
    expect(FAMILIES.length).toBeLessThanOrEqual(NOVU_WORKFLOW_CAP - 3);
    for (const f of FAMILIES) {
      expect(templatesInFamily(f.id).length).toBeGreaterThan(0);
    }
  });

  it("keeps every event on its family's opt-out switch", () => {
    for (const t of NOVU_WORKFLOW_TEMPLATES) {
      const family = FAMILIES.find((f) => f.id === familyOf(t.workflowId))!;
      expect({ event: t.workflowId, category: t.category }).toEqual({
        event: t.workflowId,
        category: family.category,
      });
    }
  });

  it("references payload and subscriber fields only through their namespace, in output and control tags alike", () => {
    for (const t of NOVU_WORKFLOW_TEMPLATES) {
      const text = [t.inApp.subject, t.inApp.body].filter(Boolean).join("\n");
      for (const variable of liquidIdentifiers(text)) {
        expect({ id: t.workflowId, variable }).toMatchObject({
          variable: expect.stringMatching(/^(payload|subscriber)\./),
        });
      }
      // A redirect names a payload FIELD, never a Liquid expression.
      expect(t.inApp.redirect ?? "dashboardUrl").toMatch(/^[a-zA-Z]\w*$/);
    }
    // The check itself must catch the legacy shapes.
    expect(
      liquidIdentifiers("{% if status %}x{% endif %} {{- amount }}"),
    ).toEqual(["amount", "status"]);
  });

  it("composes a family as one case over payload.event, one branch per member", () => {
    const family = FAMILIES.find((f) => f.id === "support-ticket")!;
    const dto = toFamilyDto(family);
    const step = dto.steps[0] as {
      controlValues: { body: string; redirect: { url: string } };
    };
    for (const t of templatesInFamily("support-ticket")) {
      expect(step.controlValues.body).toContain(`{% when '${t.workflowId}' %}`);
    }
    expect(step.controlValues.body.startsWith("{% case payload.event %}")).toBe(
      true,
    );
    // Novu's IN_APP_REDIRECT_URL_REGEX admits `{{var}}…`, `http(s)://…` or
    // `/…` only — a `case` there is rejected on write and dropped on render.
    const urls = FAMILIES.map(
      (f) =>
        (
          toFamilyDto(f).steps[0] as {
            controlValues: { redirect?: { url: string } };
          }
        ).controlValues.redirect?.url,
    ).filter((u): u is string => u !== undefined);
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(["{{payload.href}}"]));
  });

  it("sends the family as the workflow, the event and its destination in the payload", () => {
    expect(
      toWire("support-ticket-activity", {
        ticketId: "t1",
        dashboardUrl: "/dashboard/admin/support",
      }),
    ).toEqual({
      workflowId: "support-ticket",
      payload: {
        ticketId: "t1",
        dashboardUrl: "/dashboard/admin/support",
        event: "support-ticket-activity",
        href: "/dashboard/admin/support",
      },
    });
    // The destination follows the event's own field, and falls back to the
    // dashboard home when there is none: Novu fails an empty redirect url.
    expect(
      toWire("org-wallet-low", { topUpUrl: "/o/x/wallet" }).payload.href,
    ).toBe("/o/x/wallet");
    expect(toWire("moderation-warning", { reason: "r" }).payload.href).toBe(
      FALLBACK_HREF,
    );
    expect(() => toWire("no-such-event" as never, {})).toThrow(
      /no workflow family/,
    );
  });

  it("gives every event a redirect url Novu accepts, with or without a destination", () => {
    // Novu's IN_APP_REDIRECT_URL_REGEX: a url must start with `/` (not `//`) or http(s)://.
    const accepted = /^(?:\/(?!\/)|https?:\/\/)/;
    for (const event of Object.keys(EVENT_FAMILY) as NovuWorkflowId[]) {
      expect(toWire(event, {}).payload.href).toMatch(accepted);
    }
  });

  it("compiles under Novu's JSON-stringified Liquid pass, and never uses a double-quoted literal inside a tag", () => {
    // Novu's framework client JSON.stringifies the whole controls object and
    // parses THAT as Liquid (packages/framework/src/client.ts, compileControls),
    // so a `"` inside a tag arrives as `\"` and is a TokenizationError. The
    // first production sync failed every family this way on 2026-09-13.
    const engine = new Liquid();
    for (const f of FAMILIES) {
      const step = toFamilyDto(f).steps[0] as {
        controlValues: Record<string, unknown>;
      };
      expect(() =>
        engine.parse(JSON.stringify(step.controlValues)),
      ).not.toThrow();
    }
    for (const t of NOVU_WORKFLOW_TEMPLATES) {
      const text = [t.inApp.subject, t.inApp.body].filter(Boolean).join("\n");
      for (const [, tag] of text.matchAll(LIQUID_TAG)) {
        expect({ id: t.workflowId, tag }).not.toMatchObject({
          tag: expect.stringContaining('"'),
        });
      }
      for (const [output] of text.matchAll(/\{\{[^}]*\}\}/g)) {
        expect({ id: t.workflowId, output }).not.toMatchObject({
          output: expect.stringContaining('"'),
        });
      }
    }
  });

  it("renders a real event through the same round-trip Novu uses", () => {
    const engine = new Liquid();
    const step = toFamilyDto(FAMILIES.find((f) => f.id === "support-ticket")!)
      .steps[0] as { controlValues: Record<string, unknown> };
    const rendered = JSON.parse(
      engine.parseAndRenderSync(JSON.stringify(step.controlValues), {
        payload: toWire("support-ticket-response", {
          reference: "FAM-2026-000004",
          ticketTitle: "Can't access my account settings",
          respondedBy: "Maria Brown",
          message: "Sign out and in once; it is fixed.",
          dashboardUrl: "/dashboard",
        }).payload,
      }),
    ) as { subject: string; body: string; redirect: { url: string } };
    expect(rendered.subject).toBe("Reply from support");
    expect(rendered.body).toBe(
      'Maria Brown replied on FAM-2026-000004 — Can\'t access my account settings: "Sign out and in once; it is fixed."',
    );
    expect(rendered.redirect.url).toBe("/dashboard");
  });

  it.each<[NovuWorkflowId, Record<string, unknown>, string, string]>([
    [
      "class-session-cancelled",
      { forTeam: true, planTitle: "Systems", dateTime: "6 Sep" },
      "A class session was cancelled",
      "The 6 Sep session of Systems was cancelled.",
    ],
    [
      "class-session-cancelled",
      {
        planTitle: "Systems",
        dateTime: "6 Sep",
        consultantName: "Asha",
        makeUpBy: "20 Sep",
      },
      "A class session was cancelled",
      "Your 6 Sep session of Systems was cancelled — Asha has until 20 Sep to schedule a make-up, or that session is refunded automatically.",
    ],
    [
      "collaborator-removed",
      {
        pendingInvite: true,
        ownerName: "Asha",
        planTitle: "Systems",
        planType: "webinar",
      },
      "Invitation withdrawn",
      "Your invitation to Systems (webinar) was withdrawn by Asha.",
    ],
    [
      "collaborator-removed",
      { planTitle: "Systems", planType: "webinar" },
      "Removed from a plan",
      "You are no longer a collaborator on Systems (webinar).",
    ],
    [
      "collaborator-invited",
      {
        planTitle: "Systems",
        planType: "webinar",
        role: "Co-host",
        revenueSharePercentage: 25,
        expiresOn: "21 Nov",
      },
      "Collaboration invite",
      "You are invited to join Systems (webinar) as co-host with a 25% revenue share. Respond by 21 Nov.",
    ],
    [
      "plan-cohost-left",
      { sentence: "Ravi is no longer co-hosting Systems." },
      "A co-host change",
      "Ravi is no longer co-hosting Systems.",
    ],
  ])(
    "%s renders the sentence its reader is owed (%#)",
    (event, payload, subject, body) => {
      const step = toFamilyDto(FAMILIES.find((f) => f.id === familyOf(event))!)
        .steps[0] as { controlValues: Record<string, unknown> };
      const rendered = JSON.parse(
        new Liquid().parseAndRenderSync(JSON.stringify(step.controlValues), {
          payload: toWire(event, { ...payload, dashboardUrl: "/dashboard" })
            .payload,
        }),
      ) as { subject: string; body: string };
      expect(rendered).toMatchObject({ subject, body });
    },
  );

  it("writes every family always-on, read-only and without a step condition", () => {
    for (const f of FAMILIES) {
      const dto = toFamilyDto(f);
      const readOnly = {
        all: { enabled: true, readOnly: true },
        channels: { in_app: { enabled: true } },
      };
      expect(dto.preferences).toEqual({ user: readOnly, workflow: readOnly });
      const step = dto.steps[0] as { controlValues: Record<string, unknown> };
      expect(step.controlValues).not.toHaveProperty("skip");
    }
  });

  it("humanises a ticket status for the owner's bell", () => {
    expect(supportTicketStatusLabel("IN_PROGRESS")).toBe("in progress");
    expect(supportTicketStatusLabel("ON_HOLD")).toBe("on hold");
  });
});
