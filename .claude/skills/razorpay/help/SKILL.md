---
description: List all Razorpay skills and when to use each one. Use when the user is new to this plugin or says "what can /razorpay do", "show me all razorpay commands", or "help me pick the right razorpay command".
---

# Razorpay Help Menu

You are helping the user understand **which Razorpay command to use** for their situation.

Speak clearly, in simple language, and assume they may be new to Razorpay **and** to this plugin.

Your job is to:
- Show all available `/razorpay:*` commands
- Explain what each one does in 1 to 2 sentences
- Suggest which 1 or 2 commands they should run next based on their message

---

## Step 1: Print the help table

First, show a concise table of all skills.

Say:

```text
Here are the Razorpay commands you can use:

| Area | Command | When to use it |
|------|---------|----------------|
| Getting started | /razorpay:setup | First time Razorpay setup - SDK, env vars, DB schema, plan config. Start here in a new app. |
| Subscriptions | /razorpay:subscription | Build a recurring subscription checkout flow for your SaaS product. |
| Webhooks | /razorpay:webhook | Create a robust webhook handler for subscriptions, payments, refunds and invoices. |
| Plan changes | /razorpay:plan-change | Let users upgrade or downgrade plans without downtime. |
| One-time payments | /razorpay:one-time-payment | Charge for one-off products like day passes, add-ons or credits. |
| Refunds | /razorpay:refund | Issue full or partial refunds and track their status. |
| Customer portal | /razorpay:customer-portal | Add a self-service billing page for cancellations, plan changes and invoices. |
| Admin tools | /razorpay:admin | Look up payments, subscriptions, invoices and refunds directly via API. |
| Metrics | /razorpay:metrics | See MRR, churn, ARPU and plan breakdown from your Razorpay data. |
| Dunning | /razorpay:dunning | Recover failed payments with emails, grace periods and retries. |
| Local testing | /razorpay:local-testing | Set up test keys, ngrok, webhook registration and test cards for local dev. |
| Go live checklist | /razorpay:go-live | Run a production checklist before enabling live payments. |
| Stripe migration | /razorpay:stripe-migration | Migrate from Stripe Billing to Razorpay step by step. |
| Debugging | /razorpay:debug | Fix common issues like webhook failures, signature problems and SDK quirks. |
```

Do not assume the user already knows these commands. Treat this as their first time seeing them.

---

## Step 2: Understand what the user wants

Read the user's latest message and decide which area they are asking about.

Use this mapping:

- If they say "set up razorpay", "add payments", "first time", "new project"  
  - Suggest: `/razorpay:setup`

- If they say "subscriptions", "recurring", "plans", "monthly", "yearly"  
  - Suggest: `/razorpay:subscription`

- If they say "webhook", "signature failing", "events not coming", "retry"  
  - Suggest: `/razorpay:webhook` and maybe `/razorpay:debug`

- If they say "change plan", "upgrade", "downgrade", "switch from monthly to yearly"  
  - Suggest: `/razorpay:plan-change`

- If they say "one time payment", "day pass", "credits", "top up"  
  - Suggest: `/razorpay:one-time-payment`

- If they say "refund", "issue refund", "money back"  
  - Suggest: `/razorpay:refund`

- If they say "billing portal", "manage subscription", "download invoices", "customer self service"  
  - Suggest: `/razorpay:customer-portal`

- If they say "admin", "search payments", "find subscription", "what happened with pay_xxx"  
  - Suggest: `/razorpay:admin`

- If they say "MRR", "churn", "ARPU", "metrics", "dashboard"  
  - Suggest: `/razorpay:metrics`

- If they say "failed payments", "retry", "card declined", "recovery"  
  - Suggest: `/razorpay:dunning` and maybe `/razorpay:debug`

- If they say "test locally", "ngrok", "try webhooks on localhost"  
  - Suggest: `/razorpay:local-testing`

- If they say "go live", "production", "launch", "is this ready"  
  - Suggest: `/razorpay:go-live`

- If they say "migrate from Stripe", "move off Stripe", "Stripe Billing"  
  - Suggest: `/razorpay:stripe-migration`

- If they say "broken", "not working", "error", "debug", "help me fix"  
  - Suggest: `/razorpay:debug` and, if relevant, one more specific command.

If the message is very general, ask one or two simple clarifying questions in plain language.

---

## Step 3: Suggest the next commands

End your response by clearly suggesting one or two specific commands.

Use a format like:

```text
Based on what you said, I recommend:

1. Run /razorpay:setup to connect your app to Razorpay and create the basic billing pieces.
2. After that, run /razorpay:subscription to build your subscription checkout flow.
```

Keep the tone friendly and beginner friendly. Avoid jargon when possible.

---

## Gotchas

- **Run `/razorpay:setup` first.** Most other skills (subscription, webhook, plan-change, etc.) assume the project already has the Razorpay SDK, env vars, DB schema, and plan config. If the user has not run setup, suggest they run `/razorpay:setup` before building checkout or webhooks so the generated code works.
- **Help does not change code.** This skill only lists commands and suggests what to run next. It does not install packages, create files, or modify the user's project.

