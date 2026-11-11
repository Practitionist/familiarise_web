---
title: Observability index
type: reference
band: observability
audience: sde2
status: live
last-reviewed: 2026-10-27
---

# Observability

> **Status (pre-launch).** The scheduled job fleet is paused: the Upstash key `ops:active_cron_platform` is set to `paused-prelaunch`, so every tick of `netlify/functions/cron-tick.mts` returns before running a job, and the monitors that watch the fleet are paused or disabled with it (see [the pause decision](../decisions/2026-11-06-pause-scheduled-jobs-prelaunch.md)). Read the live-monitor descriptions below as the design that applies once the fleet is resumed; the resume step is the first item of the [go-live skill](../../.claude/skills/go-live/SKILL.md). Jobs can still be run by hand from the System Jobs page.

This folder explains how the platform learns that something went wrong and how a person finds out why. Start with the system design, which sets out the three questions an operator asks and which tool answers each one. The Sentry set then covers the error-tracking layer in depth.

## Start here

| Document                                     | Type        | Read it when                                                                                                       |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| [00-system-design.md](./00-system-design.md) | explanation | You need the whole picture: signal sources and sinks, the three layers, quota rules and ticker failure escalation. |
| [three-layers.md](./three-layers.md)         | explanation | You need to trace one payment or booking, or read the per-job run metrics.                                         |

## Ownership and research

| Document                                                                                     | Type        | Read it when                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [01-ownership-sentry-betterstack.md](./01-ownership-sentry-betterstack.md)                   | explanation | You need to know which tool answers which question, where per-item history lives today, and every option that was considered. |
| [02-research-per-item-history-and-vendors.md](./02-research-per-item-history-and-vendors.md) | reference   | You need the vendor comparison, the warehouse triggers or the log-table inventory behind those decisions.                     |

## The Sentry set

| Document                                                                                           | Type        | Read it when                                                                                              |
| -------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| [sentry/01-setup-and-configuration.md](./sentry/01-setup-and-configuration.md)                     | reference   | You are changing configuration, or need to know the project, the DSN variables and what is instrumented.  |
| [sentry/02-conventions.md](./sentry/02-conventions.md)                                             | reference   | You are adding a `throw`, a report call or a tag, or deciding whether something is an error or a warning. |
| [sentry/03-actions-failure-sink.md](./sentry/03-actions-failure-sink.md)                           | explanation | A GitHub Actions job failed and you want to know how that reaches Sentry.                                 |
| [sentry/04-triage-runbook.md](./sentry/04-triage-runbook.md)                                       | how-to      | You are clearing the Sentry issue queue.                                                                  |
| [sentry/05-identity-and-triage.md](./sentry/05-identity-and-triage.md)                             | explanation | You are changing what identifies a user on an event, or looking up the errors one user hit.               |
| [sentry/06-ingest-canary.md](./sentry/06-ingest-canary.md)                                         | explanation | Sentry looks empty or broken and you need to know whether it is quiet or has stopped accepting errors.    |
| [sentry/07-verifying-end-to-end.md](./sentry/07-verifying-end-to-end.md)                           | how-to      | You are about to claim an observability change works.                                                     |
| [sentry/08-error-telemetry-privacy-reference.md](./sentry/08-error-telemetry-privacy-reference.md) | reference   | You need the privacy and data-protection reasoning behind sending error data to a hosted vendor.          |

## Related documents elsewhere

| Document                                                                                                             | Why it belongs next to this folder                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Job machinery catalog](../maintenance/11-job-machinery-catalog.md)                                                  | What every scheduled job records and reports, the observability gaps, and the specification for the operations console.                |
| [Better Stack setup and the ticker missed-run drill](../maintenance/00-betterstack-setup.md)                         | How the "did it run" monitors are configured and proven.                                                                               |
| [2026-10-26 launch sweep decisions](../decisions/2026-10-26-launch-sweep-observability-and-money-holds.md)           | ADR-06 (three layers), ADR-08 (ticker escalation), ADR-09 (Sentry quota posture) and ADR-13 (the operations console).                  |
| [2026-11-01 observability gaps and launch posture](../decisions/2026-11-01-observability-gaps-and-launch-posture.md) | Ingest rejections on the run row, fixed-field events, the freshness alert, the gauges and the Stuck work page, and the launch posture. |

The agent-facing rules for this subsystem are in `.claude/skills/observability/SKILL.md`.
