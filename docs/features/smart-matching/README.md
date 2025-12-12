# Smart Matching AI

## Overview

An intelligent recommendation engine that matches consultees with the most suitable consultants based on their needs, preferences, and consultant expertise. Uses machine learning and semantic search to provide personalized recommendations.

### Value Proposition

- **Better Matches**: Higher satisfaction and rebooking rates
- **Discovery**: Help users find experts they wouldn't have searched for
- **Efficiency**: Reduce time spent browsing consultants
- **Fairness**: Surface qualified consultants beyond just top-rated ones

---

## User Stories

### Consultees

- As a consultee, I want to describe my problem and see recommended experts
- As a consultee, I want recommendations based on my past consultations
- As a consultee, I want to see why each consultant is recommended
- As a consultee, I want to filter recommendations by price, availability, language

### Consultants

- As a consultant, I want to understand how to improve my matching visibility
- As a consultant, I want to see what types of queries I'm being matched to
- As a consultant, I want fair exposure regardless of how long I've been on the platform

---

## Technical Architecture

### Database Schema

**No new models required.** Uses existing data:

```
Existing Models Used:
├── ConsultantProfile
│   ├── qualifications, specialization, experience
│   ├── rating, consultationCount
│   └── description (text for semantic search)
├── Domain / SubDomain / Tag
│   └── Hierarchical categorization
├── ConsultantReview
│   └── Feedback text for sentiment analysis
├── Consultation / Subscription
│   └── Past booking history
└── User (consultee)
    └── Goals, interests, preferences
```

### Matching Algorithm Components

```
┌─────────────────────────────────────────────────────────┐
│                  MATCHING PIPELINE                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  User Query: "I need help with startup fundraising"     │
│                        │                                │
│                        ▼                                │
│  ┌─────────────────────────────────────────────────┐   │
│  │           1. QUERY UNDERSTANDING                 │   │
│  │  - Extract intent (consultation type)            │   │
│  │  - Identify domain (Startup, Finance)            │   │
│  │  - Extract keywords (fundraising, investor)      │   │
│  │  - Generate embedding vector                     │   │
│  └─────────────────────────────────────────────────┘   │
│                        │                                │
│                        ▼                                │
│  ┌─────────────────────────────────────────────────┐   │
│  │           2. CANDIDATE RETRIEVAL                 │   │
│  │  - Filter by domain/subdomain match              │   │
│  │  - Semantic similarity search (embeddings)       │   │
│  │  - Availability filter (optional)                │   │
│  │  - Price range filter (optional)                 │   │
│  └─────────────────────────────────────────────────┘   │
│                        │                                │
│                        ▼                                │
│  ┌─────────────────────────────────────────────────┐   │
│  │           3. SCORING & RANKING                   │   │
│  │  Score = w1*Relevance + w2*Quality + w3*Freshness│   │
│  │                                                  │   │
│  │  Relevance: Semantic similarity + tag match      │   │
│  │  Quality:   Rating, reviews, completion rate     │   │
│  │  Freshness: Recency, response time, availability │   │
│  └─────────────────────────────────────────────────┘   │
│                        │                                │
│                        ▼                                │
│  ┌─────────────────────────────────────────────────┐   │
│  │           4. DIVERSITY & FAIRNESS                │   │
│  │  - Ensure mix of established + new consultants   │   │
│  │  - Price diversity (show range)                  │   │
│  │  - Avoid over-concentration on top results       │   │
│  └─────────────────────────────────────────────────┘   │
│                        │                                │
│                        ▼                                │
│  Ranked Results with Explanation                        │
│  "Recommended because: Startup funding expert,          │
│   4.9 rating, available this week"                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Embedding & Semantic Search

```typescript
// Using OpenAI embeddings + pgvector OR external vector DB

// Option A: pgvector (Postgres extension)
// Add to schema:
// model ConsultantProfile {
//   ...
//   embedding Float[] @db.Vector(1536)  // OpenAI ada-002 dimension
// }

// Option B: External vector DB (Pinecone, Weaviate, Qdrant)
// Store embeddings separately, query by consultant ID

// Embedding generation
import OpenAI from "openai";
const openai = new OpenAI();

async function generateConsultantEmbedding(
  profile: ConsultantProfile,
): Promise<number[]> {
  const text = `
    ${profile.description}
    Specialization: ${profile.specialization}
    Qualifications: ${profile.qualifications}
    Experience: ${profile.experience} years
    Domain: ${profile.domain?.name}
    SubDomains: ${profile.subDomains?.map((s) => s.name).join(", ")}
    Tags: ${profile.tags?.map((t) => t.name).join(", ")}
  `;

  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: text,
  });

  return response.data[0].embedding;
}
```

### Scoring Function

```typescript
// lib/matching/scoring.ts

interface MatchScore {
  total: number;
  breakdown: {
    relevance: number; // 0-1
    quality: number; // 0-1
    freshness: number; // 0-1
    priceMatch: number; // 0-1
  };
  explanation: string[];
}

const WEIGHTS = {
  relevance: 0.4,
  quality: 0.3,
  freshness: 0.2,
  priceMatch: 0.1,
};

export function calculateMatchScore(
  consultant: ConsultantProfile,
  query: ParsedQuery,
  semanticSimilarity: number,
): MatchScore {
  const breakdown = {
    relevance: calculateRelevance(consultant, query, semanticSimilarity),
    quality: calculateQuality(consultant),
    freshness: calculateFreshness(consultant),
    priceMatch: calculatePriceMatch(consultant, query.budget),
  };

  const total =
    WEIGHTS.relevance * breakdown.relevance +
    WEIGHTS.quality * breakdown.quality +
    WEIGHTS.freshness * breakdown.freshness +
    WEIGHTS.priceMatch * breakdown.priceMatch;

  const explanation = generateExplanation(consultant, breakdown);

  return { total, breakdown, explanation };
}

function calculateRelevance(
  consultant: ConsultantProfile,
  query: ParsedQuery,
  semanticSimilarity: number,
): number {
  let score = semanticSimilarity * 0.6; // Base semantic score

  // Boost for exact domain match
  if (consultant.domainId === query.domainId) {
    score += 0.2;
  }

  // Boost for subdomain match
  const subdomainMatch = consultant.subDomains?.some((s) =>
    query.subdomainIds?.includes(s.id),
  );
  if (subdomainMatch) {
    score += 0.1;
  }

  // Boost for tag match
  const tagMatchCount =
    consultant.tags?.filter((t) =>
      query.keywords.includes(t.name.toLowerCase()),
    ).length || 0;
  score += Math.min(tagMatchCount * 0.05, 0.1);

  return Math.min(score, 1);
}

function calculateQuality(consultant: ConsultantProfile): number {
  const ratingScore = (consultant.rating || 0) / 100; // Rating is 0-100
  const reviewScore = Math.min(consultant._count?.reviews || 0, 50) / 50; // Cap at 50 reviews
  const completionRate = consultant.completionRate || 0.9;

  return ratingScore * 0.5 + reviewScore * 0.3 + completionRate * 0.2;
}

function calculateFreshness(consultant: ConsultantProfile): number {
  // Favor consultants who are active and responsive
  const lastActiveScore = getLastActiveScore(consultant.user?.lastLogin);
  const responseTimeScore =
    1 - Math.min((consultant.avgResponseTime || 24) / 48, 1);
  const availabilityScore = consultant.hasAvailabilityThisWeek ? 1 : 0.5;

  return (
    lastActiveScore * 0.3 + responseTimeScore * 0.3 + availabilityScore * 0.4
  );
}

function generateExplanation(
  consultant: ConsultantProfile,
  scores: MatchScore["breakdown"],
): string[] {
  const explanations: string[] = [];

  if (scores.relevance > 0.7) {
    explanations.push(`Expert in ${consultant.specialization}`);
  }
  if (scores.quality > 0.8) {
    explanations.push(`${consultant.rating}% positive rating`);
  }
  if (scores.freshness > 0.8) {
    explanations.push("Available this week");
  }

  return explanations;
}
```

### API Endpoints

```
POST /api/matching/search
  Body: {
    query: string,           // Natural language query
    domainId?: string,       // Optional filter
    budget?: { min, max },   // Optional price range
    availableAfter?: Date,   // Optional availability filter
    limit?: number           // Default 10
  }
  Returns: {
    results: MatchResult[],
    queryUnderstanding: { domain, keywords, intent }
  }

GET /api/matching/recommendations
  Query: ?userId=xxx&limit=10
  Returns: Personalized recommendations based on history

GET /api/matching/similar/[consultantId]
  Returns: Similar consultants (for "You might also like")

POST /api/matching/feedback
  Body: { matchId, clicked, booked, rating }
  Used for: Improving algorithm over time
```

### Response Schema

```typescript
interface MatchResult {
  consultant: {
    id: string;
    name: string;
    avatar: string;
    title: string;
    rating: number;
    reviewCount: number;
    hourlyRate: number;
    currency: string;
    domain: string;
    tags: string[];
  };
  score: number;
  explanation: string[]; // "Expert in fundraising", "4.9 rating", etc.
  availability: {
    nextAvailable: Date;
    slotsThisWeek: number;
  };
}

interface SearchResponse {
  results: MatchResult[];
  total: number;
  queryUnderstanding: {
    originalQuery: string;
    domain: string | null;
    subdomains: string[];
    keywords: string[];
    intent: "consultation" | "subscription" | "webinar" | "class";
  };
  filters: {
    applied: Record<string, any>;
    available: {
      domains: { id: string; name: string; count: number }[];
      priceRange: { min: number; max: number };
    };
  };
}
```

---

## UI/UX Design

### Smart Search Bar (`/explore`)

```
┌─────────────────────────────────────────────────────────┐
│  Find the perfect expert for you                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 🔍 Describe what you need help with...              ││
│  │                                                     ││
│  │ "I'm launching a D2C brand and need help with       ││
│  │  performance marketing and unit economics"          ││
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Quick filters:                                         │
│  [Marketing ▼] [₹500-2000/hr ▼] [Available this week] │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  We understood: D2C Marketing, Performance Marketing,   │
│  Unit Economics                              [Edit ✏️]  │
│                                                         │
│  Top Matches (12 found)                                │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ ⭐ 98% match                                        ││
│  │                                                     ││
│  │ 👤 Priya Sharma                                    ││
│  │    D2C Growth Strategist | Ex-Meesho               ││
│  │    ⭐ 4.9 (47 reviews) | ₹1,500/hr                 ││
│  │                                                     ││
│  │    Why recommended:                                 ││
│  │    • Scaled 3 D2C brands to ₹10Cr ARR              ││
│  │    • Expert in performance marketing               ││
│  │    • Available tomorrow                            ││
│  │                                                     ││
│  │    [View Profile]  [Book Now]                      ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 94% match                                           ││
│  │ 👤 Rahul Verma                                     ││
│  │    ... (similar card)                              ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Personalized Recommendations Section

```
┌─────────────────────────────────────────────────────────┐
│  Recommended for You                                    │
│  Based on your interests in Startup Growth              │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │  Amit   │  │  Sarah  │  │  Vikram │  │  Neha   │   │
│  │   ⭐4.8 │  │   ⭐4.9 │  │   ⭐4.7 │  │   ⭐4.9 │   │
│  │₹1,200/h │  │₹2,000/h │  │₹800/hr  │  │₹1,500/h │   │
│  │  [Book] │  │  [Book] │  │  [Book] │  │  [Book] │   │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘   │
│                                                         │
│  You might also be interested in:                       │
│  [Fundraising] [Product Strategy] [Market Research]    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Basic Matching (No ML)

1. Query parsing with keyword extraction
2. Domain/subdomain/tag filtering
3. Simple scoring (rating + review count + availability)
4. Basic relevance ranking

```typescript
// Phase 1: Simple matching without embeddings
async function simpleMatch(
  query: string,
  filters: Filters,
): Promise<ConsultantProfile[]> {
  const keywords = extractKeywords(query); // Simple tokenization

  return prisma.consultantProfile.findMany({
    where: {
      OR: [
        { description: { contains: keywords[0], mode: "insensitive" } },
        { specialization: { contains: keywords[0], mode: "insensitive" } },
        { tags: { some: { name: { in: keywords, mode: "insensitive" } } } },
      ],
      isActive: true,
      ...buildFilters(filters),
    },
    orderBy: [{ rating: "desc" }, { consultationCount: "desc" }],
    take: filters.limit || 10,
  });
}
```

### Phase 2: Semantic Search

1. Generate embeddings for all consultant profiles
2. Set up vector storage (pgvector or Pinecone)
3. Implement semantic similarity search
4. Combine with structured filters

### Phase 3: Personalization

1. Track user search and booking history
2. Build user preference profiles
3. Implement collaborative filtering ("users like you also booked...")
4. A/B test recommendation algorithms

### Phase 4: Continuous Learning

1. Track click-through and booking rates per match
2. Implement feedback loop for algorithm tuning
3. Monitor fairness metrics (new consultant exposure)
4. Regular model retraining

---

## Dependencies

### Depends On

- ConsultantProfile, Domain, SubDomain, Tag models
- OpenAI API (for embeddings) OR local embedding model
- Vector database (pgvector, Pinecone, or Weaviate)

### Features That Depend On This

- **Analytics Dashboard** - Match quality metrics
- **Consultant Badges** - "Top Match" badge

---

## Fairness & Transparency

### New Consultant Exposure

- Reserve 10-20% of results for newer consultants with limited reviews
- Implement "Rising Stars" section
- Weight recency of activity to favor active consultants

### Transparency

- Always show "Why recommended" explanation
- Allow users to see and adjust their preference profile
- Provide opt-out from personalization

### Bias Mitigation

- Audit matching results for demographic bias
- Ensure price diversity in results
- Monitor and report on consultant exposure fairness
