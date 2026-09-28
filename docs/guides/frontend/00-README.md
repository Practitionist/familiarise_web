# Frontend Guide

How to write UI in this codebase. These are the rules that are easy to get wrong
under time pressure, written down so you don't have to rediscover them.

There was no frontend guide before this. `docs/dashboard/` held IA notes and perf
logs, `docs/performance/` held navigation and allocation measurements, and nothing
covered how a component is supposed to be written here. If a rule below is new,
that is a gap this file should close.

## Reading order

1. [01-server-data-and-validation.md](./01-server-data-and-validation.md) —
   **read this first.** The write path is the only boundary that counts.
2. [02-theming-and-css-scope.md](./02-theming-and-css-scope.md) — dark tokens,
   `:has()` scoping, and why we never mutate `<html>` from a route.
3. [03-forms.md](./03-forms.md) — validation timing, wizard transitions, the
   double-advance bug class.
4. [04-server-actions-vs-routes.md](./04-server-actions-vs-routes.md) — thin
   index; the substance already lives in
   [`docs/education/server-actions-vs-api-routes.md`](../../education/server-actions-vs-api-routes.md).

## When a rule graduates to a skill

A rule belongs in a **guide** while it is a convention someone might reasonably
disagree with. It graduates to a `.claude/skills/` entry only once it is an
_invariant_ — something a careful engineer would still get wrong under deadline
pressure, and where being wrong has a real cost.

`.claude/skills/` currently holds domain skills: booking, finance, enterprise,
stream, deployment, maintenance, schema, workflow. All of them encode hard-won
system invariants. None of them is a style guide, and that is deliberate.

- _"Use server actions for mutations"_ → guide. A preference.
- _"Never trust `file.type`; sniff the bytes"_ → skill. A security invariant.
- _"Never mutate `documentElement` for a route theme"_ → skill. Breaks hydration
  and already cost us one regression.

## The source-contract test

`__tests__/dashboards/shell-overflow-contract.test.ts` and
`__tests__/onboarding/onboarding-shell-contract.test.ts` read source files as
**text** and assert on their content. That is deliberate: they lock in
structural invariants (which chrome a page opts into, that no route mutates
`<html>`) that would otherwise be invisible to behavioural tests.

**This has one sharp edge you must know about.** `extractCssRule` does
`css.indexOf(selector)` to find where a rule starts, then slices to the next `{`
and reads the following block. A _comment_ that names a selector earlier in the
file therefore wins the `indexOf`, so the extraction **starts in the wrong
place**: the text the test compares against becomes the comment's fragment
plus whatever block happens to follow it, not the real rule's selector and body.

This actually happened: a comment in `app/globals.css` named the flush-bottom
selector in prose, and the test failed on `dev` with a diff that quoted my own
comment back at me.

So: when you write a comment near a rule that a contract test scans for, **do not
spell the selector out**. Describe it instead. If a contract test breaks right
after a comment-only change, this is why — and the failure diff quoting your
comment is the tell.
