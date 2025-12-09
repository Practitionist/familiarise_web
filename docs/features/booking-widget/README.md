# Embeddable Booking Widget

## Overview

A lightweight, customizable booking widget that consultants can embed on their personal websites, blogs, or portfolios. Enables direct booking without visitors leaving the consultant's site.

### Value Proposition

- **Distribution**: Consultants book clients from their own traffic
- **Branding**: Widget matches consultant's website design
- **Conversion**: Reduce friction with inline booking
- **SEO Benefit**: Consultants drive traffic to their domain

---

## User Stories

### Consultants

- As a consultant, I want to embed a booking widget on my website
- As a consultant, I want to customize the widget colors to match my brand
- As a consultant, I want to choose which services appear in the widget
- As a consultant, I want to track bookings from my widget

### Consultees

- As a visitor, I want to book directly from the consultant's website
- As a visitor, I want a smooth experience without multiple redirects
- As a visitor, I want to see availability without leaving the page

---

## Technical Architecture

### Database Schema

**No new models required.** Widget configuration stored in ConsultantProfile:

```prisma
model ConsultantProfile {
  // Existing fields...

  // Widget configuration (JSON field or separate fields)
  widgetConfig Json? // { enabled, theme, plans, customCss }
}

// Widget config structure
interface WidgetConfig {
  enabled: boolean;
  publicId: string;        // Unique ID for embedding
  theme: {
    primaryColor: string;
    backgroundColor: string;
    textColor: string;
    borderRadius: string;
    fontFamily?: string;
  };
  plans: string[];         // Plan IDs to show in widget
  displayMode: 'inline' | 'popup' | 'floating';
  position?: 'bottom-right' | 'bottom-left'; // For floating
  showAvatar: boolean;
  showRating: boolean;
  customCss?: string;
}
```

### Widget Architecture

```
┌─────────────────────────────────────────────────────────┐
│              WIDGET ARCHITECTURE                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  CONSULTANT'S WEBSITE                                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │                                                  │   │
│  │  <script src="https://familiarise.com/widget.js"│   │
│  │          data-consultant="abc123">              │   │
│  │  </script>                                       │   │
│  │                                                  │   │
│  │  OR                                              │   │
│  │                                                  │   │
│  │  <iframe src="https://familiarise.com/embed/    │   │
│  │          abc123" width="400" height="600">      │   │
│  │  </iframe>                                       │   │
│  │                                                  │   │
│  └─────────────────────────────────────────────────┘   │
│                        │                                │
│                        │ Loads                          │
│                        ▼                                │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Widget Application                  │   │
│  │  (Standalone React/Preact micro-app)            │   │
│  │                                                  │   │
│  │  - Fetches consultant data via API              │   │
│  │  - Renders booking UI                           │   │
│  │  - Handles checkout (redirect or iframe)        │   │
│  │  - Posts booking confirmation back              │   │
│  └─────────────────────────────────────────────────┘   │
│                        │                                │
│                        │ API Calls                      │
│                        ▼                                │
│  ┌─────────────────────────────────────────────────┐   │
│  │           Familiarise Backend                    │   │
│  │                                                  │   │
│  │  GET /api/widget/[publicId]                     │   │
│  │  GET /api/widget/[publicId]/availability        │   │
│  │  POST /api/widget/[publicId]/book               │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Embed Options

```html
<!-- Option 1: Script Tag (Recommended) -->
<div id="familiarise-widget"></div>
<script
  src="https://familiarise.com/widget.js"
  data-consultant="abc123"
  data-theme="light"
  data-mode="inline"
></script>

<!-- Option 2: iFrame -->
<iframe
  src="https://familiarise.com/embed/abc123?theme=light"
  width="400"
  height="600"
  frameborder="0"
></iframe>

<!-- Option 3: Popup Button -->
<button onclick="FamiliariseWidget.open('abc123')">
  Book a Consultation
</button>
<script src="https://familiarise.com/widget.js"></script>

<!-- Option 4: Floating Button -->
<script
  src="https://familiarise.com/widget.js"
  data-consultant="abc123"
  data-mode="floating"
  data-position="bottom-right"
></script>
```

### Widget Script Implementation

```typescript
// public/widget.js (compiled from TypeScript/React)

(function() {
  const WIDGET_URL = 'https://familiarise.com';

  // Parse script attributes
  const script = document.currentScript;
  const consultantId = script?.dataset.consultant;
  const mode = script?.dataset.mode || 'inline';
  const theme = script?.dataset.theme || 'light';
  const position = script?.dataset.position || 'bottom-right';

  if (!consultantId) {
    console.error('Familiarise Widget: data-consultant attribute required');
    return;
  }

  // Create widget container
  const container = document.createElement('div');
  container.id = 'familiarise-widget-container';

  if (mode === 'inline') {
    const target = document.getElementById('familiarise-widget');
    if (target) {
      target.appendChild(container);
    }
  } else if (mode === 'floating') {
    container.className = `familiarise-floating familiarise-${position}`;
    document.body.appendChild(container);
  }

  // Load widget iframe
  const iframe = document.createElement('iframe');
  iframe.src = `${WIDGET_URL}/embed/${consultantId}?theme=${theme}&mode=${mode}`;
  iframe.style.border = 'none';
  iframe.style.width = mode === 'inline' ? '100%' : '380px';
  iframe.style.height = mode === 'inline' ? '600px' : '500px';
  iframe.allow = 'payment';

  container.appendChild(iframe);

  // Handle messages from iframe
  window.addEventListener('message', (event) => {
    if (event.origin !== WIDGET_URL) return;

    const { type, data } = event.data;

    switch (type) {
      case 'BOOKING_COMPLETE':
        window.dispatchEvent(new CustomEvent('familiarise:booking', { detail: data }));
        break;
      case 'RESIZE':
        iframe.style.height = `${data.height}px`;
        break;
      case 'OPEN_CHECKOUT':
        window.open(data.url, '_blank');
        break;
    }
  });

  // Global API
  window.FamiliariseWidget = {
    open: (consultantId) => {
      // Open popup modal
      const modal = createModal(consultantId);
      document.body.appendChild(modal);
    },
    close: () => {
      const modal = document.getElementById('familiarise-modal');
      if (modal) modal.remove();
    },
  };
})();
```

### Widget Embed Page

```typescript
// app/embed/[publicId]/page.tsx

export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: { publicId: string };
  searchParams: { theme?: string; mode?: string };
}) {
  const consultant = await prisma.consultantProfile.findFirst({
    where: { widgetConfig: { path: ['publicId'], equals: params.publicId } },
    include: {
      user: { select: { name: true, image: true } },
      consultationPlans: { where: { isActive: true } },
      domain: true,
    },
  });

  if (!consultant) {
    return <div>Widget not found</div>;
  }

  const widgetConfig = consultant.widgetConfig as WidgetConfig;
  const theme = searchParams.theme || 'light';

  return (
    <html>
      <head>
        <style>{`
          :root {
            --primary: ${widgetConfig.theme.primaryColor};
            --background: ${widgetConfig.theme.backgroundColor};
            --text: ${widgetConfig.theme.textColor};
            --radius: ${widgetConfig.theme.borderRadius};
          }
          body {
            margin: 0;
            font-family: ${widgetConfig.theme.fontFamily || 'system-ui'};
          }
          ${widgetConfig.customCss || ''}
        `}</style>
      </head>
      <body>
        <WidgetApp
          consultant={consultant}
          config={widgetConfig}
          mode={searchParams.mode}
        />
      </body>
    </html>
  );
}

function WidgetApp({ consultant, config, mode }) {
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [step, setStep] = useState<'plans' | 'calendar' | 'confirm'>('plans');

  return (
    <div className="widget-container">
      {config.showAvatar && (
        <div className="consultant-header">
          <img src={consultant.user.image} alt="" />
          <div>
            <h3>{consultant.user.name}</h3>
            {config.showRating && <span>⭐ {consultant.rating}%</span>}
          </div>
        </div>
      )}

      {step === 'plans' && (
        <PlanSelector
          plans={consultant.consultationPlans.filter(p =>
            config.plans.includes(p.id)
          )}
          onSelect={(plan) => {
            setSelectedPlan(plan);
            setStep('calendar');
          }}
        />
      )}

      {step === 'calendar' && (
        <CalendarPicker
          consultantId={consultant.id}
          planId={selectedPlan.id}
          onSelect={(slot) => {
            setSelectedSlot(slot);
            setStep('confirm');
          }}
          onBack={() => setStep('plans')}
        />
      )}

      {step === 'confirm' && (
        <ConfirmBooking
          plan={selectedPlan}
          slot={selectedSlot}
          onConfirm={() => {
            // Redirect to checkout or open in new tab
            const checkoutUrl = buildCheckoutUrl(selectedPlan, selectedSlot);
            window.parent.postMessage({
              type: 'OPEN_CHECKOUT',
              data: { url: checkoutUrl }
            }, '*');
          }}
          onBack={() => setStep('calendar')}
        />
      )}
    </div>
  );
}
```

### API Endpoints

```
GET /api/widget/[publicId]
  Returns: Consultant profile, plans, widget config
  CORS: Allow all origins (public)

GET /api/widget/[publicId]/availability
  Query: ?planId=xxx&month=2024-12
  Returns: Available slots for the month
  CORS: Allow all origins

POST /api/widget/[publicId]/init-booking
  Body: { planId, slotId, email, name }
  Returns: { checkoutUrl, bookingId }
  CORS: Allow all origins

GET /api/widget/[publicId]/booking/[bookingId]
  Returns: Booking status
  CORS: Allow all origins

// Widget configuration (Consultant)
GET /api/consultants/[id]/widget
  Returns: Widget settings and embed code

PATCH /api/consultants/[id]/widget
  Body: { enabled, theme, plans, ... }
  Updates: Widget configuration
```

---

## UI/UX Design

### Widget Configuration Page (Consultant Dashboard)

```
┌─────────────────────────────────────────────────────────┐
│  Booking Widget                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ☑ Enable booking widget on external websites          │
│                                                         │
│  Your Widget ID: abc123-def456                         │
│                                                         │
│  Customization                                          │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Display Mode:                                          │
│  ○ Inline (embedded in page)                           │
│  ● Floating button (bottom corner)                     │
│  ○ Popup (click to open)                               │
│                                                         │
│  Theme Colors:                                          │
│  Primary:    [#6366F1] ■                               │
│  Background: [#FFFFFF] □                               │
│  Text:       [#1F2937] ■                               │
│                                                         │
│  Show in Widget:                                        │
│  ☑ Your avatar and name                                │
│  ☑ Your rating                                         │
│  ☐ Multiple plans (select below)                       │
│                                                         │
│  Plans to Display:                                      │
│  ☑ 1-on-1 Consultation (₹2,000/hr)                    │
│  ☑ Strategy Session (₹3,500/hr)                       │
│  ☐ Monthly Subscription (₹15,000/mo)                  │
│                                                         │
│  Preview                                                │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌───────────────────┐                                 │
│  │  [Widget Preview] │                                 │
│  │                   │                                 │
│  │  👤 Priya Sharma  │                                 │
│  │  ⭐ 4.9           │                                 │
│  │                   │                                 │
│  │  [Book Now ₹2,000]│                                 │
│  └───────────────────┘                                 │
│                                                         │
│  Embed Code                                             │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ <script src="https://familiarise.com/widget.js"    ││
│  │         data-consultant="abc123-def456"            ││
│  │         data-mode="floating"                       ││
│  │         data-position="bottom-right">              ││
│  │ </script>                                          ││
│  └─────────────────────────────────────────────────────┘│
│  [Copy Code]                                            │
│                                                         │
│  Need help? [View Integration Guide]                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Widget Appearance (Inline Mode)

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │                                                  │   │
│  │  👤 Book with Priya Sharma                      │   │
│  │     Marketing Strategist | ⭐ 4.9 (47 reviews)  │   │
│  │                                                  │   │
│  │  ─────────────────────────────────────────────  │   │
│  │                                                  │   │
│  │  Select a service:                              │   │
│  │                                                  │   │
│  │  ┌─────────────────────────────────────────┐   │   │
│  │  │ 1-on-1 Consultation                     │   │   │
│  │  │ 60 min • ₹2,000                         │   │   │
│  │  │ [Select]                                │   │   │
│  │  └─────────────────────────────────────────┘   │   │
│  │                                                  │   │
│  │  ┌─────────────────────────────────────────┐   │   │
│  │  │ Strategy Session                        │   │   │
│  │  │ 90 min • ₹3,500                         │   │   │
│  │  │ [Select]                                │   │   │
│  │  └─────────────────────────────────────────┘   │   │
│  │                                                  │   │
│  │  Powered by Familiarise                         │   │
│  │                                                  │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Widget Appearance (Floating Button)

```
                                    ┌──────────────────┐
                                    │ 💬 Book with Me  │
                                    └──────────────────┘

   When clicked, expands to:

                          ┌─────────────────────────────┐
                          │ 👤 Priya Sharma             │
                          │    ⭐ 4.9                   │
                          │                             │
                          │ ┌─────────────────────────┐ │
                          │ │ Dec 2024         [>]    │ │
                          │ │ ┌───┬───┬───┬───┬───┐  │ │
                          │ │ │ M │ T │ W │ T │ F │  │ │
                          │ │ │ 9 │10 │11 │12 │13 │  │ │
                          │ │ │ ● │ ● │   │ ● │   │  │ │
                          │ │ └───┴───┴───┴───┴───┘  │ │
                          │ └─────────────────────────┘ │
                          │                             │
                          │ Available times:            │
                          │ [10:00] [14:00] [16:00]    │
                          │                             │
                          │ [Continue →]               │
                          │                             │
                          │ ───────────────────────    │
                          │ Powered by Familiarise     │
                          └─────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Basic Widget

1. Create `/embed/[publicId]` page
2. Build minimal widget React app
3. Implement plan selection and calendar
4. Redirect to main site for checkout

### Phase 2: Script Embed

1. Build widget.js loader script
2. Add floating and popup modes
3. Implement iframe communication
4. Handle booking confirmations

### Phase 3: Customization

1. Widget configuration UI in dashboard
2. Theme customization (colors, fonts)
3. Plan selection controls
4. Custom CSS option

### Phase 4: Analytics & Polish

1. Track widget impressions and conversions
2. A/B test widget placements
3. Performance optimization (lazy loading)
4. Accessibility improvements

---

## Dependencies

### Depends On

- ConsultantProfile model
- Availability/booking APIs
- Checkout flow

### Features That Depend On This

- **Analytics Dashboard** - Widget conversion metrics

---

## Security Considerations

- Widget APIs are public but rate-limited
- CORS properly configured for widget domains
- No sensitive data exposed in widget
- Payment handled on main domain (PCI compliance)
- CSP headers to prevent clickjacking
