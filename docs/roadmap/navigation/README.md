# Navigation — Mega-Menu Design

> Full mega-menu navigation structure with competitor analysis and coming-soon strategy.

**Status**: Design
**Decision Date**: 2026-02-02

---

## Table of Contents

- [Competitor Navigation Analysis](#competitor-navigation-analysis)
- [Common Patterns Across Platforms](#common-patterns-across-platforms)
- [Our Navigation Structure](#our-navigation-structure)
- [Coming Soon Strategy](#coming-soon-strategy)
- [Detailed Dropdown Contents](#detailed-dropdown-contents)
- [Footer Structure](#footer-structure)

---

## Competitor Navigation Analysis

### MentorCruise Navigation

```
Header:
  Browse all mentors | Engineering | Design | Startup | AI | Product | Marketing | Leadership | Career | Top Mentors
  [Login] [Find a mentor] [For businesses]

Footer:
  Platform: Browse Mentors, Book a Session, Become a Mentor, Mentorship for Teams, Testimonials
  Resources: Newsletter, Books, Perks, Templates, Career Paths, Blog
  Company: Case Studies, Partner Program, Code of Conduct, Privacy
  Explore: Fractional Executives, Services & Training, Part-Time Experts
  Support: FAQ, Contact
```

### GrowthMentor Navigation

```
Header (Mega Menu with 4 dropdowns):
  Platform: Overview, AI Matching, Slack Community, Help Requests, Community Networking, Video Room
  Use Cases:
    By Role: Founders, Marketers, Product Managers, Teams, Venture Capital
    By Challenge: Product Market Fit, Raising Funding, Growth Strategy, Scaling Operations, Sales Strategy, etc.
  Resources: Blog, Podcasts, Glossary, Video Library, Partner Deals, GrowthMentor Live
  Company: About, Wall of Love, Customer Stories, Become a Mentor, City Squads
  [Explore Membership] [Login] [Browse Mentors]

Footer:
  Getting Started: For Individuals, For Teams, For Venture Capital, Become a Mentor, Self-Guided Tour, Request Demo
  Platform: Overview, AI, Help Requests, Networking, Video Room, Scheduling
  Company: About Us, Wall of Love, Customer Stories, IRL Events
  Resources: Blog, Video Library, Case Studies, Glossary, Partner Deals
```

### Topmate Navigation

```
Header:
  Use Cases | Search | Pricing
  [Sign In] [Start Selling]

Footer: Minimal
```

### Preplaced Navigation

```
Header:
  Home | Explore Mentors | AI Mentors | Success Stories
  [Login] [Find your mentor]

Footer:
  Engineering Domains: Frontend, Backend, Full Stack, DevOps, Cybersecurity, QA
  Data Science Domains: Data Engineer, Data Scientist, Data Analyst, Big Data, AI/ML
  Business Domains: Sales, Marketing, Business Analyst, Finance, HR
  Product Domains: Product Manager, UI/UX, Project Manager, Program Manager
  Resources: Live Events, Stories, Ask Mentor, Support
```

### Clarity.fm Navigation

```
Header:
  Browse/Search | Answers | Clarity Live
  [Become an Expert] [Sign Up]
```

---

## Common Patterns Across Platforms

1. **Primary CTA is always "Find/Browse Mentors" or "Get Started"** — never buried
2. **"For Business/Teams/Enterprise"** is a separate, prominent link (MentorCruise, GrowthMentor)
3. **Category browsing** is often in the navbar itself (MentorCruise lists mentor categories directly)
4. **Use Cases** organized by role AND by challenge (GrowthMentor does this best)
5. **Simple platforms (Topmate, Clarity) have 3-5 nav items.** Complex platforms (GrowthMentor) use mega menus with 4 dropdown sections
6. **Footer is the real sitemap** — it contains all the SEO-friendly links to category pages, resources, and legal pages
7. **Limit top-level categories to 5-7 items** and use mega menu space to provide clarity around core pathways

---

## Our Navigation Structure

**Decision: Full mega-menu, with coming-soon items displayed but non-clickable.**

```
[Logo]  Platform ▼   Solutions ▼   Resources ▼   Pricing   [Login]  [Find an Expert]  [For Enterprise]
```

All items are clickable and navigate to a page, EXCEPT items marked "Coming Soon" which are displayed but greyed out / tagged with a "Coming Soon" badge and are non-clickable.

---

## Coming Soon Strategy

- Items linking to existing pages: **clickable**, navigates to the page
- Items linking to pages not yet built: **non-clickable**, greyed out with a "Coming Soon" tag/badge
- As pages are built, items are flipped from "Coming Soon" to live

---

## Detailed Dropdown Contents

### Platform Dropdown

| Item               | Link                | Status                      |
| ------------------ | ------------------- | --------------------------- |
| Browse Consultants | `/explore/experts`  | **Live** (clickable)        |
| Browse Programs    | `/explore/programs` | **Live** (clickable)        |
| How It Works       | `/how-it-works`     | Coming Soon (non-clickable) |
| Features           | `/features`         | Coming Soon                 |

### Solutions Dropdown

| Item                 | Link                              | Status      |
| -------------------- | --------------------------------- | ----------- |
| **By Audience**      |                                   |             |
| For Individuals      | `/solutions/individuals`          | Coming Soon |
| For Teams            | `/solutions/teams`                | Coming Soon |
| For Enterprise       | `/solutions/enterprise`           | Coming Soon |
| **By Use Case**      |                                   |             |
| Career Transitions   | `/use-cases/career-transitions`   | Coming Soon |
| Technical Mentorship | `/use-cases/technical-mentorship` | Coming Soon |
| Business Strategy    | `/use-cases/business-strategy`    | Coming Soon |
| Leadership Coaching  | `/use-cases/leadership-coaching`  | Coming Soon |

### Resources Dropdown

| Item            | Link               | Status                                 |
| --------------- | ------------------ | -------------------------------------- |
| Blog            | `/blog`            | Coming Soon (until Directus is set up) |
| Success Stories | `/success-stories` | Coming Soon                            |
| Community       | `/community`       | Coming Soon (gated, for paying users)  |
| Help Center     | `/help`            | Coming Soon                            |

### Direct Links (Not in Dropdowns)

| Item                        | Link                    | Status               |
| --------------------------- | ----------------------- | -------------------- |
| Pricing                     | `/pricing`              | **Live** (clickable) |
| Login                       | `/login`                | **Live** (clickable) |
| Find an Expert (CTA button) | `/explore/experts`      | **Live** (clickable) |
| For Enterprise (CTA button) | `/solutions/enterprise` | Coming Soon          |

---

## Footer Structure

Existing reusable pages that belong in the footer (not the navbar):

| Section       | Pages                                                          |
| ------------- | -------------------------------------------------------------- |
| **Legal**     | Privacy Policy, Terms of Service, Cookie Policy, Refund Policy |
| **Platform**  | Browse Experts, Browse Programs, Pricing, How It Works         |
| **Solutions** | For Individuals, For Teams, For Enterprise                     |
| **Resources** | Blog, Success Stories, Help Center, Community                  |
| **Company**   | About Us, Contact, Become a Consultant                         |
| **Domains**   | (Programmatic SEO links to domain/category pages)              |

The footer serves as the full sitemap with SEO-friendly links to every page, including domain-specific category pages for programmatic SEO.
