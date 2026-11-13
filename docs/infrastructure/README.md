---
title: Infrastructure research and scaling
type: reference
---

# Infrastructure research and scaling

This folder holds the scaling roadmap and the research that backs the hosting and job-runtime decisions of 2026-10-31. The pages after the roadmap are research evidence, not decisions. The decisions are in [Ticker through launch, the scale path, the phase 2 queue and the database plan](../decisions/2026-10-31-ticker-scale-path-and-queue.md) and in [the job-runtime evidence and decision record](../decisions/2026-10-31-job-runtime-experiments.md). The measured evidence is in the [experiment reports](../maintenance/experiments/2026-10-31-job-runtime/README.md), and the explanation pages are [page 14](../maintenance/14-background-job-runtime-options.md), [page 15](../maintenance/15-job-runtime-layer-matrix.md) and [page 16](../maintenance/16-job-machinery-and-portability.md).

The files are numbered in reading order, and the numbering is contiguous. The table lists them.

| File                                                                                   | What it covers                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [00-production-scaling-roadmap.md](./00-production-scaling-roadmap.md)                 | The production scaling roadmap and the queue and cache plans it grew from                          |
| [01-scale-path-research.md](./01-scale-path-research.md)                               | The research summary of where jobs and the web tier should run as the product grows                |
| [02-runtime-strategy-review.md](./02-runtime-strategy-review.md)                       | An unbiased review of runtime options, with the scorecard that the owner's option numbers map onto |
| [03-background-jobs-and-cron-options.md](./03-background-jobs-and-cron-options.md)     | The background-jobs and cron options and the cheapest credible path per stage                      |
| [04-mumbai-hosting-comparison.md](./04-mumbai-hosting-comparison.md)                   | A costed comparison of hosting in Mumbai for the web tier and an always-on worker                  |
| [05-mumbai-vm-provider-research.md](./05-mumbai-vm-provider-research.md)               | Mumbai VM provider research: Lightsail recommended, with estimated latency until the probe runs    |
| [06-queue-prototype-owed-refunds.md](./06-queue-prototype-owed-refunds.md)             | A comparison spike of pg-boss against a hand-written Prisma `Job` table on the owed-refund job     |
| [07-job-runtime-system-designs.md](./07-job-runtime-system-designs.md)                 | System-design pictures for each candidate job runtime                                              |
| [08-jobs-runtime-and-cold-start-review.md](./08-jobs-runtime-and-cold-start-review.md) | The 2026-11-13 review: no job engine, the app and database layout, and what a cold instance costs  |

## Deprecated & Superseded Approaches

- The container-in-Mumbai plan in the early research ($100 to $440 a month) was rejected on cost and replaced by the ticker through launch and the later two-test choice recorded in the decision record.
