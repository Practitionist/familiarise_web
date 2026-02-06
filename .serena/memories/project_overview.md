# Familiarise Web - Project Overview

## Purpose

SaaS platform for consultants and consultees. Supports consultations, subscriptions, webinars, classes, payments (Stripe/Razorpay), video calls (Stream), chat (Stream), notifications (Novu).

## Tech Stack

- Next.js 15 (App Router, "use client" pages)
- TypeScript, Prisma ORM, PostgreSQL
- Tailwind CSS, shadcn/ui components
- Stream Chat/Video, Novu notifications
- Stripe + Razorpay payments
- Jest for testing

## Key Commands

- `npm run dev` — Start dev server
- `npm run test` — Run Jest tests
- `npx tsc --noEmit` — TypeScript type check
- `npx prisma generate` — Generate Prisma client

## Key Directories

- `app/` — Next.js App Router pages and API routes
- `types/` — Shared TypeScript types
- `schemas/` — Zod validation schemas
- `actions/` — Server actions
- `lib/` — Shared utilities
- `components/` — UI components
- `prisma/` — Schema and seed files
- `utils/` — Utility functions
