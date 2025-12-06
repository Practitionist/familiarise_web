# Familiarise Design System

> A comprehensive design system for building a premium, modern SaaS experience.

---

## Table of Contents

1. [Color System](#color-system)
2. [Typography](#typography)
3. [Spacing](#spacing)
4. [Components](#components)
5. [Motion](#motion)
6. [Icons](#icons)
7. [Accessibility](#accessibility)

---

## Color System

### Brand Colors

```css
/* Primary - Deep Purple/Indigo */
--brand-primary: #6366F1;
--brand-primary-hover: #4F46E5;
--brand-primary-active: #4338CA;
--brand-primary-light: #E0E7FF;

/* Secondary - Teal/Cyan */
--brand-secondary: #14B8A6;
--brand-secondary-hover: #0D9488;
--brand-secondary-active: #0F766E;
--brand-secondary-light: #CCFBF1;
```

### Semantic Colors

```css
/* Success */
--success-50: #F0FDF4;
--success-100: #DCFCE7;
--success-500: #22C55E;
--success-600: #16A34A;
--success-700: #15803D;

/* Warning */
--warning-50: #FFFBEB;
--warning-100: #FEF3C7;
--warning-500: #F59E0B;
--warning-600: #D97706;
--warning-700: #B45309;

/* Error / Destructive */
--error-50: #FEF2F2;
--error-100: #FEE2E2;
--error-500: #EF4444;
--error-600: #DC2626;
--error-700: #B91C1C;

/* Info */
--info-50: #EFF6FF;
--info-100: #DBEAFE;
--info-500: #3B82F6;
--info-600: #2563EB;
--info-700: #1D4ED8;
```

### Neutral Scale

```css
/* Gray Scale - Zinc based */
--gray-50: #FAFAFA;
--gray-100: #F4F4F5;
--gray-200: #E4E4E7;
--gray-300: #D4D4D8;
--gray-400: #A1A1AA;
--gray-500: #71717A;
--gray-600: #52525B;
--gray-700: #3F3F46;
--gray-800: #27272A;
--gray-900: #18181B;
--gray-950: #09090B;
```

### Background & Surface

```css
/* Light Mode */
--background: #FFFFFF;
--background-subtle: #FAFAFA;
--surface: #FFFFFF;
--surface-elevated: #FFFFFF;
--border: #E4E4E7;
--border-strong: #D4D4D8;

/* Dark Mode */
--background-dark: #09090B;
--background-subtle-dark: #18181B;
--surface-dark: #18181B;
--surface-elevated-dark: #27272A;
--border-dark: #27272A;
--border-strong-dark: #3F3F46;
```

### CSS Variables Implementation

```css
:root {
  /* Core Colors */
  --primary: 238 84% 67%;
  --primary-foreground: 0 0% 100%;
  --secondary: 168 76% 42%;
  --secondary-foreground: 0 0% 100%;

  /* Surfaces */
  --background: 0 0% 100%;
  --foreground: 240 10% 4%;
  --card: 0 0% 100%;
  --card-foreground: 240 10% 4%;
  --popover: 0 0% 100%;
  --popover-foreground: 240 10% 4%;

  /* States */
  --muted: 240 5% 96%;
  --muted-foreground: 240 4% 46%;
  --accent: 240 5% 96%;
  --accent-foreground: 240 6% 10%;

  /* Feedback */
  --destructive: 0 84% 60%;
  --destructive-foreground: 0 0% 98%;
  --success: 142 71% 45%;
  --warning: 38 92% 50%;

  /* Borders & Rings */
  --border: 240 6% 90%;
  --input: 240 6% 90%;
  --ring: 238 84% 67%;

  /* Radius */
  --radius: 0.5rem;
}
```

---

## Typography

### Font Stack

```css
/* Primary Font - Inter */
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;

/* Monospace - For code/data */
--font-mono: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
```

### Type Scale

```css
/* Font Sizes - Based on 1.25 ratio */
--text-xs: 0.75rem;      /* 12px */
--text-sm: 0.875rem;     /* 14px */
--text-base: 1rem;       /* 16px */
--text-lg: 1.125rem;     /* 18px */
--text-xl: 1.25rem;      /* 20px */
--text-2xl: 1.5rem;      /* 24px */
--text-3xl: 1.875rem;    /* 30px */
--text-4xl: 2.25rem;     /* 36px */
--text-5xl: 3rem;        /* 48px */
--text-6xl: 3.75rem;     /* 60px */
--text-7xl: 4.5rem;      /* 72px */

/* Line Heights */
--leading-none: 1;
--leading-tight: 1.25;
--leading-snug: 1.375;
--leading-normal: 1.5;
--leading-relaxed: 1.625;
--leading-loose: 2;

/* Font Weights */
--font-normal: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;
--font-extrabold: 800;

/* Letter Spacing */
--tracking-tighter: -0.05em;
--tracking-tight: -0.025em;
--tracking-normal: 0;
--tracking-wide: 0.025em;
```

### Typography Components

```
DISPLAY HEADINGS (Hero sections)
─────────────────────────────────────────
Display 1: 60px / 72px • Extrabold • -0.02em
Display 2: 48px / 56px • Bold • -0.02em

PAGE HEADINGS
─────────────────────────────────────────
H1: 36px / 44px • Bold • -0.02em
H2: 30px / 38px • Semibold • -0.01em
H3: 24px / 32px • Semibold • 0
H4: 20px / 28px • Semibold • 0
H5: 18px / 26px • Medium • 0
H6: 16px / 24px • Medium • 0

BODY TEXT
─────────────────────────────────────────
Body Large: 18px / 28px • Normal
Body: 16px / 24px • Normal
Body Small: 14px / 20px • Normal

UTILITY
─────────────────────────────────────────
Caption: 12px / 16px • Medium
Overline: 12px / 16px • Semibold • 0.05em uppercase
Label: 14px / 20px • Medium
```

---

## Spacing

### Base Scale (4px grid)

```css
--space-0: 0;
--space-0.5: 0.125rem;   /* 2px */
--space-1: 0.25rem;      /* 4px */
--space-1.5: 0.375rem;   /* 6px */
--space-2: 0.5rem;       /* 8px */
--space-2.5: 0.625rem;   /* 10px */
--space-3: 0.75rem;      /* 12px */
--space-3.5: 0.875rem;   /* 14px */
--space-4: 1rem;         /* 16px */
--space-5: 1.25rem;      /* 20px */
--space-6: 1.5rem;       /* 24px */
--space-7: 1.75rem;      /* 28px */
--space-8: 2rem;         /* 32px */
--space-9: 2.25rem;      /* 36px */
--space-10: 2.5rem;      /* 40px */
--space-11: 2.75rem;     /* 44px */
--space-12: 3rem;        /* 48px */
--space-14: 3.5rem;      /* 56px */
--space-16: 4rem;        /* 64px */
--space-20: 5rem;        /* 80px */
--space-24: 6rem;        /* 96px */
--space-28: 7rem;        /* 112px */
--space-32: 8rem;        /* 128px */
```

### Layout Spacing

```
Container Widths
─────────────────────────────────────────
sm: 640px
md: 768px
lg: 1024px
xl: 1280px
2xl: 1440px

Container Padding
─────────────────────────────────────────
Mobile: 16px (space-4)
Tablet: 24px (space-6)
Desktop: 32px (space-8)
Wide: 40px (space-10)

Section Spacing
─────────────────────────────────────────
Compact: 48px (space-12)
Normal: 80px (space-20)
Large: 96px (space-24)
XLarge: 128px (space-32)

Component Spacing
─────────────────────────────────────────
Inline (between icons/text): 8px
Stack Tight: 12px
Stack Normal: 16px
Stack Loose: 24px
Card Padding: 24px
Modal Padding: 32px
```

---

## Components

### Button Variants

```
PRIMARY (Main CTAs)
┌───────────────────────────────────────┐
│  Background: brand-primary            │
│  Text: white                          │
│  Hover: brand-primary-hover          │
│  Active: brand-primary-active        │
│  Focus: ring-2 ring-primary/50       │
└───────────────────────────────────────┘

SECONDARY (Secondary actions)
┌───────────────────────────────────────┐
│  Background: gray-100                 │
│  Text: gray-900                       │
│  Border: gray-200                     │
│  Hover: gray-200                     │
└───────────────────────────────────────┘

OUTLINE (Tertiary actions)
┌───────────────────────────────────────┐
│  Background: transparent              │
│  Text: gray-900                       │
│  Border: gray-300                     │
│  Hover: gray-50                      │
└───────────────────────────────────────┘

GHOST (Inline actions)
┌───────────────────────────────────────┐
│  Background: transparent              │
│  Text: gray-600                       │
│  Hover: gray-100                     │
└───────────────────────────────────────┘

DESTRUCTIVE (Delete/Remove)
┌───────────────────────────────────────┐
│  Background: error-600               │
│  Text: white                          │
│  Hover: error-700                    │
└───────────────────────────────────────┘
```

### Button Sizes

```
Size     Height    Padding (x)    Font Size    Icon Size
────────────────────────────────────────────────────────
xs       28px      12px           12px         14px
sm       32px      14px           13px         16px
md       40px      16px           14px         18px
lg       48px      20px           16px         20px
xl       56px      24px           18px         22px
```

### Card Variants

```
DEFAULT
┌───────────────────────────────────────┐
│  Background: surface                  │
│  Border: 1px solid border            │
│  Border Radius: 12px                 │
│  Shadow: none                         │
│  Padding: 24px                        │
└───────────────────────────────────────┘

ELEVATED
┌───────────────────────────────────────┐
│  Background: surface                  │
│  Border: none                         │
│  Border Radius: 12px                 │
│  Shadow: shadow-md                   │
│  Hover: shadow-lg + translateY(-2px) │
└───────────────────────────────────────┘

INTERACTIVE
┌───────────────────────────────────────┐
│  All elevated properties +            │
│  Cursor: pointer                      │
│  Transition: all 150ms               │
│  Hover: border-primary               │
└───────────────────────────────────────┘
```

### Input Fields

```
DEFAULT STATE
┌───────────────────────────────────────┐
│  Background: white                    │
│  Border: 1px solid gray-300          │
│  Border Radius: 8px                  │
│  Height: 40px (md)                   │
│  Padding: 12px 14px                  │
│  Font: 14px                          │
└───────────────────────────────────────┘

FOCUS STATE
┌───────────────────────────────────────┐
│  Border: 2px solid primary           │
│  Shadow: 0 0 0 3px primary/20        │
└───────────────────────────────────────┘

ERROR STATE
┌───────────────────────────────────────┐
│  Border: 2px solid error-500         │
│  Background: error-50                │
└───────────────────────────────────────┘
```

---

## Motion

### Duration Tokens

```css
--duration-instant: 50ms;    /* Immediate feedback */
--duration-fast: 100ms;      /* Quick interactions */
--duration-normal: 150ms;    /* Standard transitions */
--duration-moderate: 200ms;  /* Larger transitions */
--duration-slow: 300ms;      /* Page transitions */
--duration-slower: 400ms;    /* Complex animations */
```

### Easing Functions

```css
/* Standard easings */
--ease-linear: linear;
--ease-in: cubic-bezier(0.4, 0, 1, 1);
--ease-out: cubic-bezier(0, 0, 0.2, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

/* Expressive easings */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
--ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);
--ease-smooth: cubic-bezier(0.16, 1, 0.3, 1);
```

### Animation Presets

```css
/* Fade In */
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* Slide Up */
@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Scale In */
@keyframes scaleIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* Pulse */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

/* Skeleton shimmer */
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
```

### Interaction Guidelines

```
HOVER STATES
─────────────────────────────────────────
Buttons: Background change, 100ms
Cards: Shadow + translateY(-2px), 150ms
Links: Color change + underline, 100ms

CLICK/ACTIVE STATES
─────────────────────────────────────────
Buttons: scale(0.98), 50ms
Cards: scale(0.99), 50ms

FOCUS STATES
─────────────────────────────────────────
All interactive: ring-2, offset-2, 150ms

PAGE TRANSITIONS
─────────────────────────────────────────
Content fade: 200ms ease-out
Slide: 300ms ease-smooth
```

---

## Icons

### Icon Library
- **Primary**: Lucide React (consistent, MIT licensed)
- **Size variants**: 16px, 20px, 24px, 32px

### Icon Usage

```
SIZE GUIDELINES
─────────────────────────────────────────
16px: Inline with small text, badges
20px: Buttons, form elements, navigation
24px: Cards, section headers, features
32px: Empty states, hero sections

COLOR GUIDELINES
─────────────────────────────────────────
Default: currentColor (inherits text)
Muted: gray-400
Interactive: primary on hover
Success/Error: semantic colors
```

---

## Accessibility

### Color Contrast

```
MINIMUM REQUIREMENTS (WCAG 2.1 AA)
─────────────────────────────────────────
Normal text: 4.5:1 contrast ratio
Large text (18px+): 3:1 contrast ratio
UI components: 3:1 contrast ratio

OUR TARGETS
─────────────────────────────────────────
Body text on white: 7:1 (gray-900)
Secondary text: 4.5:1 (gray-600)
Placeholder text: 4.5:1 (gray-500)
```

### Focus States

```css
/* Visible focus ring for all interactive elements */
:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
  border-radius: var(--radius);
}

/* Remove outline for mouse users */
:focus:not(:focus-visible) {
  outline: none;
}
```

### Touch Targets

```
MINIMUM SIZES
─────────────────────────────────────────
Touch target: 44x44px minimum
Spacing between targets: 8px minimum
Mobile buttons: 48px height recommended
```

### Screen Reader Support

```tsx
// Use semantic HTML and ARIA when needed
<button aria-label="Close dialog">
  <X className="h-5 w-5" aria-hidden="true" />
</button>

// Announce dynamic content
<div role="status" aria-live="polite">
  {loading ? 'Loading...' : `${count} results found`}
</div>

// Skip links for keyboard navigation
<a href="#main-content" className="sr-only focus:not-sr-only">
  Skip to main content
</a>
```

---

## Quick Reference

### Tailwind Config

```js
// tailwind.config.ts additions
module.exports = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', ...defaultTheme.fontFamily.sans],
        mono: ['JetBrains Mono', ...defaultTheme.fontFamily.mono],
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease-out',
        'slide-up': 'slideUp 300ms ease-smooth',
        'scale-in': 'scaleIn 200ms ease-out',
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      transitionTimingFunction: {
        'smooth': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
}
```

---

## Usage Examples

### Component Composition

```tsx
// Example: Premium Expert Card
<Card className="group hover:shadow-lg transition-all duration-150 hover:-translate-y-0.5">
  <CardHeader className="space-y-3">
    <Avatar className="h-16 w-16 ring-2 ring-white shadow-md">
      <AvatarImage src={expert.image} />
      <AvatarFallback className="bg-primary text-primary-foreground">
        {expert.initials}
      </AvatarFallback>
    </Avatar>
    <div className="space-y-1">
      <h3 className="font-semibold text-lg tracking-tight">
        {expert.name}
      </h3>
      <p className="text-sm text-muted-foreground">
        {expert.title} @ {expert.company}
      </p>
    </div>
  </CardHeader>
  <CardContent>
    <div className="flex items-center gap-2">
      <Badge variant="secondary">{expert.category}</Badge>
      <span className="text-sm text-muted-foreground">
        ★ {expert.rating} ({expert.reviews})
      </span>
    </div>
    <p className="mt-3 text-sm text-muted-foreground line-clamp-2">
      {expert.bio}
    </p>
    <div className="mt-4 flex items-center justify-between">
      <span className="font-semibold">From ${expert.rate}/hr</span>
      <Button size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity">
        View Profile
      </Button>
    </div>
  </CardContent>
</Card>
```
