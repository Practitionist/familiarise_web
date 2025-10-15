# Booking Algorithm Documentation

Welcome to the Familiarise booking algorithm documentation. This comprehensive guide covers the slot allocation and validation system that powers consultations, subscriptions, webinars, and classes.

## 📚 Documentation Structure

### Getting Started

- **[Quick Start Guide](./01_QUICK_START.md)** - New developer onboarding (15 min read)
  - System overview
  - Key concepts
  - Running your first allocation
  - Common workflows

### Core Documentation

- **[Architecture Overview](./02_ARCHITECTURE.md)** - System design and components
  - Service layer architecture
  - Database schema
  - Validation flow
  - Recent bug fixes and improvements

- **[Event Types](./03_EVENT_TYPES.md)** - Understanding different event types
  - Consultations
  - Subscriptions
  - Webinars
  - Classes
  - Similarities and differences

- **[Validation Layers](./04_VALIDATION_LAYERS.md)** - Complete validation guide
  - Zod schema validation
  - Business rule validation
  - Subscription-specific validation
  - Error handling

- **[Slot Calculations](./05_SLOT_CALCULATIONS.md)** - Time slot mathematics
  - Week counting algorithm
  - Slot duration rules
  - Consecutive slot validation
  - Timezone handling

### Reference

- **[API Reference](./06_API_REFERENCE.md)** - Complete endpoint documentation
  - Allocate endpoints
  - Validate endpoints
  - Request/response examples
  - Error codes

- **[Bug Fixes Changelog](./07_BUG_FIXES_CHANGELOG.md)** - Recent improvements
  - 10 critical bugs fixed
  - Before/after comparisons
  - Impact and testing

### Troubleshooting & Testing

- **[Troubleshooting Guide](./08_TROUBLESHOOTING.md)** - Common issues and solutions
  - Validation errors
  - Allocation failures
  - Debugging strategies

- **[Testing Guide](./09_TESTING_GUIDE.md)** - Testing the allocation system
  - Unit test examples
  - Integration testing
  - Manual testing workflows

## 🎯 Quick Navigation by Task

### I want to...

**Add a new event type**
→ Start with [Event Types](./03_EVENT_TYPES.md) → [Architecture](./02_ARCHITECTURE.md) → [API Reference](./06_API_REFERENCE.md)

**Understand validation errors**
→ Check [Validation Layers](./04_VALIDATION_LAYERS.md) → [Troubleshooting](./08_TROUBLESHOOTING.md)

**Fix a slot allocation bug**
→ Review [Bug Fixes Changelog](./07_BUG_FIXES_CHANGELOG.md) → [Slot Calculations](./05_SLOT_CALCULATIONS.md) → [Testing Guide](./09_TESTING_GUIDE.md)

**Integrate with the API**
→ Read [API Reference](./06_API_REFERENCE.md) → [Quick Start](./01_QUICK_START.md)

**Write tests**
→ Follow [Testing Guide](./09_TESTING_GUIDE.md) → [Architecture](./02_ARCHITECTURE.md)

## 🏗️ System Overview

### Core Services

```
┌─────────────────────────────────────────────────────────┐
│                     API Routes                          │
│  (consultations, subscriptions, webinars, classes)      │
└────────────────┬────────────────────────────────────────┘
                 │
        ┌────────▼────────┐
        │ Zod Validation  │  Layer 1: Input validation
        └────────┬────────┘
                 │
        ┌────────▼─────────────────┐
        │ SlotAllocationService    │  Layer 2: Business logic
        │ SlotValidationService    │
        │ SubscriptionValidation   │
        └────────┬─────────────────┘
                 │
        ┌────────▼────────┐
        │  Prisma/Database│  Layer 3: Data persistence
        └─────────────────┘
```

### Key Features

- **Type-Safe Validation**: Zod schemas with automatic TypeScript inference
- **3-Layer Validation**: Input → Business Rules → Database
- **Flexible Allocation**: Auto, Manual, and Requested modes
- **Conflict Prevention**: Time range overlap detection
- **Subscription Limits**: Weekly call limits and total call tracking
- **Timezone Support**: Consistent UTC handling with timezone conversion

## 📊 Statistics

- **4 Event Types**: Consultations, Subscriptions, Webinars, Classes
- **8 API Endpoints**: 4 allocate + 4 validate
- **3 Allocation Modes**: Auto, Manual, Requested
- **10 Critical Bugs Fixed**: See [changelog](./07_BUG_FIXES_CHANGELOG.md)
- **~75% Code Reduction**: From custom validation to Zod schemas

## 🔄 Recent Changes

### December 2024 - Major Improvements

- ✅ Migrated from custom InputValidator to industry-standard Zod
- ✅ Fixed 10 critical bugs including double-booking prevention
- ✅ Added comprehensive inline comments for new developers
- ✅ Improved error messages with detailed validation paths
- ✅ Centralized duration validation
- ✅ Server-side scheduling period enforcement

See [Bug Fixes Changelog](./07_BUG_FIXES_CHANGELOG.md) for details.

## 💡 Best Practices

1. **Always validate on the server** - Never trust client-side validation alone
2. **Use Zod schemas** - Automatic type inference prevents bugs
3. **Handle timezone conversions carefully** - Store UTC, display local
4. **Test edge cases** - Past dates, overlapping slots, duplicate slots
5. **Check business rules** - Weekly limits, session durations, availability
6. **Use transactions** - Atomic updates prevent race conditions

## 🤝 Contributing

When making changes to the booking algorithm:

1. Read the [Architecture docs](./02_ARCHITECTURE.md) first
2. Write tests following the [Testing Guide](./09_TESTING_GUIDE.md)
3. Update relevant documentation
4. Test all edge cases mentioned in [Troubleshooting](./08_TROUBLESHOOTING.md)
5. Add comments explaining your changes

## 📞 Support

If you're stuck:

1. Check the [Troubleshooting Guide](./08_TROUBLESHOOTING.md)
2. Review the [Bug Fixes Changelog](./07_BUG_FIXES_CHANGELOG.md) for similar issues
3. Consult the [API Reference](./06_API_REFERENCE.md) for endpoint details
4. Ask the team in #engineering-support

## 📖 Additional Resources

- **UI Guide**: `docs/booking-algorithm/UI_GUIDE.md` - Frontend calendar components
- **Prisma Schema**: `prisma/schema.prisma` - Database structure
- **Zod Schemas**: `schemas/slotAllocation/validationSchemas.ts` - Validation rules

---

**Next Steps**: Start with the [Quick Start Guide](./01_QUICK_START.md) →
