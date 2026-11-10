# 13-e · Accessibility, viewports and page states

**Needs:** the booking pages in each state (DB-01's ledger). A grid with picks (G-SUB from 02), an unsold class (pattern scheduler), a sold webinar (re-time), a sold class (series move), a class session (make-up), a cancellable booking.
**Personas:** H1, H2, B1, B2.
**Docs under test:** `docs/calendar/allocate-heatmap-ux.md` (keyboard model), `components/scheduling/SingleSessionPicker.tsx` (two `radiogroup`s: "Day" and "Start time"; each start's name "<time>, <state>"), `components/scheduling/ClassPatternScheduler.tsx` (row controls labelled "Day 1", "Time 1", "Remove day 1"), `components/ui/toast.tsx` (Radix toast), WCAG 2.2 AA.

**Tools:** `press_key` for every keyboard step (Tab, Shift+Tab, arrows, Home/End, PageUp/PageDown, Enter, Space, Escape); `take_snapshot` for the accessibility tree (names, roles, states); `resize_page` for viewports; `get_css_styles` or a screenshot for focus rings and contrast. No screen-reader software runs here: judge names, roles, states and live regions from the tree.

**Colour:** a separate colour-scheme pass is planned. Record contrast numbers and colour-only signals; don't propose palettes.

**Viewports:** desktop 1440×900, laptop 1280×720, tablet 1024×768, phone 390×844.

## UX-88 — Heat-map grid: what HM-48 doesn't cover

**Steps:** HM-48 owns roving focus, arrows, Home/End, PageUp/PageDown, Enter/Space and the "x of y times picked" live region. Here, keyboard only on the allocate page:

1. Tab from the page top to the grid. Count the tab stops before it (toolbar, zone switch, week navigation, Open hours / Full day, context chips).
2. From the grid, Tab into the tray: each pick's remove button, Auto-schedule, Save, Cancel.
3. Open the partial dialog (SU-45) by keyboard, answer it, and note where focus lands after it closes.
4. Trigger a refusal toast by keyboard (pick a busy cell). Read the toast's role in the tree.

**Expect:** a logical order; every control reachable and named; the tray's remove buttons name the session ("Remove session 2, Tue 18 Nov 6:00 pm", not "Remove"); focus returns to the cell or Save after the dialog; toasts are in a live region (Radix `role="status"`).

**Probe further:** context chips: are they buttons or text? A chip that looks clickable but isn't, or the reverse. The zone switch's "Use my device's time zone" button: `aria-pressed` set (code: yes); is the change announced?

## UX-89 — `SingleSessionPicker` by keyboard and in the tree

**Steps:** as H2, in the webinar editor's picker, the re-time dialog and the make-up dialog:

1. Tab into the day strip. Use Left/Right, Home/End. Tab to the start list. Use Up/Down.
2. Try to select a "Busy" and a "Too soon" start with Space and Enter.
3. Read the tree: radiogroup names, each radio's name and `aria-checked`, `aria-disabled`.
4. Use "Earlier days" / "Later days".

**Expect:** each group is one tab stop with arrow keys moving inside it (ARIA radio pattern); disabled starts are skipped or announced as unavailable and can't be chosen; each start is named "<time>, <Free | Outside your hours | Busy | Too soon>".

**Probe further:** if Tab visits every radio (no roving), report **A11Y** (P2). Does the selected day/time stay announced when the list re-renders after a day change? The loading line ("Loading your …") in a live region?

## UX-90 — Pattern scheduler by keyboard

**Steps:** as H2, open Manage timings on an unsold class. Keyboard only: add a row, set its day and time, add a duplicate (error), remove a row, reach the preview list and the **Schedule N sessions** button; switch to "Use the calendar view instead" and back.

**Expect:** every control reachable; errors ("Two rows have the same day and time.", "A class meets at most twice on one day.") announced and tied to the row (`aria-describedby`); the preview's per-session states readable as text.

**Probe further:** row controls are named "Day 1", "Time 1", "Remove day 1". A screen-reader user hears "Day 1, combobox, Monday"? Names that omit the value or say "day" for a whole row are **A11Y** (P3). Is a disabled **Schedule** button explained ("N clash with your calendar")?

## UX-91 — Dialogs: focus in, focus trapped, focus back

**Steps:** for each dialog: consultation cancel, subscription cancel, seat leave, trial cancel, expert cancel, re-time, series move, session cancel, make-up, partial allocation, convert weekly hours, booking dialog on the expert page:

1. Open it by keyboard. Note the first focused element.
2. Tab past the last control (trap?). Shift+Tab past the first.
3. Escape. Note where focus lands.
4. Read the tree: `role="dialog"`, `aria-modal`, an accessible name from the title, a description.

**Expect:** focus moves into the dialog (to the title or the first safe control, never straight to a destructive confirm); trapped; Escape closes and returns focus to the opener.

**Probe further:** a destructive confirm that is the first focused element is **A11Y** (P2) and a money risk. After a successful cancel the opener is gone: where does focus go? (It should land on something meaningful, such as the page heading or the status.)

## UX-92 — Checkout by keyboard

**Steps:** keyboard only through `/checkout/plans/consultation/[planId]` and the subscription checkout: the org payer selector, discount field, terms, pay button, mock pay (local).

**Expect:** every control reachable with a visible focus ring; errors announced and linked to fields; the pay button's name includes the amount or the amount is read just before it.

**Probe further:** the Razorpay frame (when it opens on a preview) traps focus? Out of scope to fix, but record whether focus returns after it closes.

## UX-93 — Toasts are announced and stay long enough

**Steps:** trigger one success and one destructive toast on: allocate, reschedule, cancel, inbox approve, checkout refusal. Read each toast's role in the tree. Time how long each stays. Try to reach its action or close button by keyboard.

**Expect:** a live region (status for success, alert or assertive for errors); long enough to read (WCAG 2.2.1: adjustable, or no time limit for content that matters); actions reachable before it disappears.

**Probe further:** a refusal whose only explanation is a toast that vanishes is **A11Y** (P2): the sentence should also live on the page. `TOAST_REMOVE_DELAY` is long, but the Radix duration decides when it hides; record the observed seconds.

## UX-94 — Grid states: colour as the only signal

**Steps:** on the allocate grid and the consultee reschedule grid, with each painted state present (HM-19's legend), take a screenshot in greyscale (CSS `filter: grayscale(1)` via `evaluate_script`) and read whether each state is still distinguishable. Read each cell's name in the tree.

**Expect:** each state differs by more than hue (pattern, icon, text, border), and each cell's accessible name includes its state.

**Probe further:** list the states that are indistinguishable in greyscale. Measure text and border contrast for Free vs Busy vs Limit reached cells and the tray's warning text (4.5:1 text, 3:1 non-text). Record numbers only.

## UX-95 — Badges, tones and status pills

**Steps:** collect every status badge and tone (`BOOKING_LABEL` tones: caution, warning, neutral, success, info, critical) on Appointments, the inbox and money lines. Measure contrast; check each badge has text, not just colour.

**Expect:** AA contrast; text on every badge.

**Probe further:** "Declined" (critical) and "Cancelled" (neutral): does the colour imply blame or severity that the text doesn't? Note for the colour pass.

## UX-96 — Four viewports, every booking page

**Steps:** at each viewport, open: expert page and dialog, each checkout, allocate, Manage timings (grid and pattern), both reschedule pages, cancel dialogs, re-time and series move dialogs, appointment detail (both sides), inbox, consultee Home and Payments, org appointments.

**Expect:** no horizontal scroll except intended strips (day strip, week grid); sticky actions visible; dialogs fit (scroll inside, never off-screen); tray docks right at ≥ 1280 px and under the grid below; phone allocate shows the desktop notice and "Auto-schedule this week"; phone reschedule shows the day list (HM-43).

**Probe further:** HM-49 owns grid readability. Here look for clipped buttons, overlapping toasts and sticky bars, text over 80 characters wide at 1440, and touch targets under 24×24 px at 390 (WCAG 2.5.8). Screenshot each failure.

## UX-97 — Zoom and text spacing

**Steps:** at 1280×720, zoom to 200 % (or `resize_page` to 640×360) on the allocate page, a cancel dialog and checkout. Apply WCAG 1.4.12 text spacing via `evaluate_script` (line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em).

**Expect:** nothing lost or overlapped; content reflows to one column without horizontal scroll (except the grid).

**Probe further:** the grid's 11–12 px labels at 200 %: readable or clipped?

## UX-98 — Loading, empty and error states

**Steps:** for each booking page: hard reload (skeleton), block the main data request (`emulate` offline after load, or wait for a slow request), and open with an empty data set (DB-17).

**Expect:** skeletons match the final layout (HM-30 owns the grid); an error state names what failed and offers retry; empty states say what will appear (DB-17).

**Probe further:** with the network offline, click Save on allocate and Confirm on cancel: what does the user see? A spinner that never ends, or a 30-s silent wait, is **ERROR-HANDLING** (P2). The grid's freshness label on a failed refresh (HM-40).

## UX-99 — Focus and headings after navigation

**Steps:** navigate between dashboard pages with the keyboard (nav links), then from a bell entry, then after a successful action that redirects (allocate Save, cancel confirm).

**Expect:** focus lands at the page's top or main heading after a route change; each page has one `h1` naming it; landmarks (`main`, `nav`) present.

**Probe further:** pages where focus stays on a link that no longer exists (body focus) or the heading order skips levels. **A11Y** (P3).

## UX-100 — Reduced motion and the now-line

**Steps:** emulate `prefers-reduced-motion: reduce`. Open the grid (now-line, ghost preview), toasts (slide-in), dialogs (fade/zoom).

**Expect:** motion reduced or removed; nothing that matters depends on animation.

**Probe further:** toasts slide in from the top on mobile and from the bottom on desktop (Radix classes): under reduced motion, still sliding? Record.
