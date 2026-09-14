# The dead white over-scroll under the dashboard, and why `<main>` is now `relative`

**Date:** 2026-09-13 · **Branch:** `hotfix/dashboard-dead-overscroll` · **Scope:** every role shell under `/dashboard/*`, the app-wide Radix bubble-input sweep in `app/globals.css`, and the contract test that pins both.

This entry records one reported symptom, the single mechanism behind every instance of it, the structural fix that closes the whole class, and the residuals that were deliberately left alone. It exists so that the next person who sees white space under a dashboard does not re-derive the containing-block argument from the CSS specification.

## The reported symptom

On the consultant settings page in production, the dashboard slid up out of the window and left dead white space under it. The sidebar's top entries were gone, the "Enhanced Profile" heading sat at the very top of the viewport, and the shell's bottom edge, with the user chip and the sign-out link, ended about two thirds of the way down. The window itself had scrolled by roughly 395 pixels. The same thing had been seen on other pages without anyone being able to say which ones.

The scroll architecture documented at `app/globals.css` under "Dashboard scroll architecture" makes this impossible by arithmetic: each role shell is exactly one dynamic viewport tall (`.h-screen-maintenance`, which is `100dvh` minus the maintenance banner) and clips itself, and the only scrollport is its `<main>`. The document is never supposed to be taller than the window on a dashboard route. When it is, the window scrolls, and the visible result is exactly the screenshot above. The comment on the Radix Select sweep in the same file had already named the effect "the dead white over-scroll" and measured it once at 1282 pixels of document against a 662-pixel viewport.

## The mechanism

An absolutely positioned box takes as its containing block the padding box of the nearest ancestor whose `position` is not `static`, and falls back to the initial containing block, which is the viewport, when there is none. A scroll container clips its descendants except for those whose containing block is the viewport or one of the scroller's own ancestors. Those two rules together mean that an absolutely positioned element inside an unpositioned `overflow-y: auto` scroller is neither scrolled nor clipped by it. It is placed at its static position in document coordinates, which is where it would have been if the scroller had never scrolled, and it contributes its border box to the document's scrollable overflow.

None of the five role shells positioned its `<main>` scroller, and nothing between the root layout's `<body>` and that `<main>` was positioned either, so every such element resolved against the viewport.

Radix is the source of those elements. Inside a `<form>`, Checkbox, Switch and RadioGroup each render a hidden native "bubble" `<input aria-hidden>` beside the visible control so that native form submission and autofill still work. Its inline style is `position: absolute; pointer-events: none; opacity: 0` at the control's real size, with a `translateX(-100%)` to pull it back over the control, and no `top` or `left`. Unlike the Select bubble, which reuses Radix's visually-hidden styles and is clipped to a single pixel, these carry no `clip` at all, so they always count towards scrollable overflow. On a long settings form a checkbox that is 1,500 pixels down the content therefore pinned a 16-pixel box 1,500 pixels down the document, and the document grew to match.

The condition under which the bubble input renders is `control ? !!form || !!control.closest("form") : true` in all three packages (`@radix-ui/react-checkbox` 1.3.3, `react-switch` 1.2.6, `react-radio-group` 1.3.8 as installed). Outside a form the bubble exists only for the first render, before the ref resolves, and is removed on the re-render, which is why the staff, consultee and admin settings pages, which have no `<form>` element, never showed the symptom. Upgrading does not help: the latest published versions on 2026-09-13 (checkbox 1.3.11, switch 1.3.7, radio-group 1.4.7, select 2.3.7) ship the same styles, the upstream fix for Select (radix-ui/primitives#3876) was closed unmerged, and the older reports for Checkbox and Switch (#2402, #3588) were closed without a code change.

## Where it was live

The sweep found five sources, all Radix bubble inputs inside a `<form>` and outside a `FormItem` (which is already `relative`).

| Page                                   | Control                                  | Where                                                                                          |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Consultant settings, Profile tab       | three "Session Types" checkboxes         | `app/dashboard/consultant/[consultantId]/(features)/settings/sections/ProfileSection.tsx`      |
| Consultant settings, Notifications tab | five switches across seven stacked cards | `components/notifications/NotificationPreferencesPanel.tsx` under the same form                |
| Consultant settings, Availability tab  | two radio items                          | `app/dashboard/consultant/[consultantId]/(features)/settings/sections/AvailabilitySection.tsx` |
| Organisation settings, SSO tab         | one switch                               | `app/dashboard/organization/[orgId]/settings/SsoPanel.tsx`                                     |
| Organisation create wizard, step one   | two checkboxes                           | `components/organization/create-wizard/OrgInfoStep.tsx`                                        |

Everything else that could have grown the document was checked and found contained: every hand-written `absolute` under the dashboard tree has a `relative` parent, the recharts tooltip sits inside recharts' own `relative` wrapper, every dialog, sheet, popover and dropdown is portaled and `fixed`, Stream's file input is `display: none`, and the toaster, maintenance banner, announcement bar, cookie banner and verification overlay are all `fixed` and outside the shell.

## The fix

Three layers, in decreasing order of importance.

1. Every role shell's `<main>` scroller now carries `relative`: `components/dashboard/PersonalDashboardShell.tsx`, `components/dashboard/OperatorDashboardShell.tsx`, `app/dashboard/organization/[orgId]/OrgDashboardShell.tsx`, `app/dashboard/org-workspace/[orgWorkspaceId]/OrgWorkspaceShell.tsx` and `app/dashboard/organization/(switcher)/layout.tsx`, plus the loading skeleton's `<main>` in `components/dashboard/CollapsibleSidebar.tsx` for uniformity. With `<main>` as the containing block, any absolutely positioned descendant that has no closer positioned ancestor scrolls with the content, is clipped by `overflow-y: auto`, and contributes only to `<main>`'s own scrollable overflow, which is the intended scrollport. This closes the entire class rather than the five instances, including anything a future dependency renders the same way.
2. The unlayered sweep rule in `app/globals.css` now matches `input[aria-hidden="true"]` as well as `select[aria-hidden="true"]`, pinning the bubble to its containing block's origin with `top: 0; left: 0`. On a visible static control the two declarations are no-ops, since offsets only apply to positioned boxes, so the wider selector cannot misplace anything. No `Checkbox`, `Switch` or `RadioGroupItem` in the repository carries `required`, so there is no native validation bubble whose anchor could move.
3. `FormItem` in `components/ui/form.tsx` was already `relative` and is unchanged.

The counter-cases were checked before choosing `relative` rather than a per-page patch. Sticky chrome (the offering editor's tab strip and save bar, the wizard header, the multi-select dropdown) resolves against the nearest scrollport, which is still `<main>`, so it is unaffected. `relative` without a `z-index` creates no stacking context, so the sticky context bar and the non-portaled `z-10` and `z-50` dropdowns keep their paint order. No `transform` or `filter` was added, so `fixed` descendants keep the viewport as their containing block. The `DashboardViewportFill` and messages fills use in-flow negative margins and are not positioned.

## What pins it

`__tests__/dashboards/shell-overflow-contract.test.ts` now asserts that the single scroll `<main>` in every shell source carries `relative`, and that the sweep rule in `app/globals.css` names `input[aria-hidden="true"]`. Removing either fails the suite; the assertion was confirmed to fail with `relative` removed from one shell before the change was committed.

## Residuals left alone

`components/organization/create-wizard/Wizard.tsx` wraps its content in `min-h-screen`. Inside a shell whose `<main>` is shorter than the viewport that produces an internal scrollbar on a short form, not document growth, and the same component is also rendered on the public `/form/onboarding` page where a viewport-height floor is the intended layout, so it was not changed here.

The `loading.tsx` files at `consultant/[consultantId]/`, `consultee/[consulteeId]/` and `staff/[staffId]/` render a second full shell inside a layout that already renders one, which `CollapsibleSidebar.tsx` says not to do. During loading that nests one viewport inside another and shows an internal scrollbar for a moment. It does not grow the document and is out of scope for this hotfix.
