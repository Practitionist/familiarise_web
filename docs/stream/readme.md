# Stream SDK Documentation

> Comprehensive documentation for Stream Chat and Video integration in Familiarise

## 📚 Table of Contents

### Getting Started

- [**01. Architecture Overview**](./01-architecture.md) - System design and component relationships
- [**02. Setup & Configuration**](./02-setup-configuration.md) - Environment setup and installation

### Core Implementation

- [**03. Provider & Authentication**](./03-provider-authentication.md) - StreamProvider lifecycle and token management
- [**04. Chat Implementation**](./04-chat-implementation.md) - Chat SDK integration and channel patterns
- [**05. Video Implementation**](./05-video-implementation.md) - Video SDK integration and meeting flows
- [**06. Channel Management**](./06-channel-management.md) - Channel creation, sync, and membership

### Operations & Management

- [**07. User Management**](./07-user-management.md) - User operations, search, and synchronization
- [**08. Token Management**](./08-token-management.md) - Token generation, caching, and refresh
- [**09. Background Sync**](./09-background-sync.md) - Daily cleanup job and user sync
- [**10. API Endpoints**](./10-api-endpoints.md) - REST API reference

### Developer Resources

- [**11. Hooks & Utilities**](./11-hooks-utilities.md) - Custom React hooks and helper functions
- [**12. Error Handling**](./12-error-handling.md) - Error boundaries and retry logic
- [**13. Known Issues**](./13-known-issues.md) - ⚠️ **Bugs, workarounds, and limitations**
- [**14. Troubleshooting**](./14-troubleshooting.md) - Common problems and solutions

## 🎯 Quick Links

### External Resources

- [Stream Chat Docs](https://getstream.io/chat/docs/)
- [Stream Video Docs](https://getstream.io/video/docs/)
- [Stream Node SDK](https://getstream.io/chat/docs/node/)
- [Stream React SDK](https://getstream.io/chat/docs/sdk/react/)

### Critical Information

- ⚠️ [**Known Critical Bug: Universal Admin Role**](./13-known-issues.md#critical-bug-1-universal-admin-role)
- 🔐 [Environment Variables Required](./02-setup-configuration.md#environment-variables)
- 📊 [Architecture Diagrams](./01-architecture.md#system-architecture)

## 🚀 Quick Start

### Prerequisites

```bash
# Required environment variables
NEXT_PUBLIC_STREAM_API_KEY=<your-api-key>
STREAM_API_SECRET=<your-secret>
```

### Basic Usage

```typescript
// Wrap your app with StreamProvider
import StreamProvider from '@/providers/StreamProvider'

<StreamProvider userId={session.user.id}>
  {children}
</StreamProvider>
```

**For detailed setup:** See [02. Setup & Configuration](./02-setup-configuration.md)

## 📦 SDK Versions

| Package                      | Version | Purpose                |
| ---------------------------- | ------- | ---------------------- |
| `@stream-io/video-react-sdk` | 1.12.6  | Video meetings & calls |
| `stream-chat`                | 8.57.6  | Chat client (core)     |
| `stream-chat-react`          | 12.13.1 | Chat UI components     |
| `@stream-io/node-sdk`        | 0.4.17  | Server-side operations |

## 🏗️ What Stream SDK Powers

### Chat Features

- 💬 Direct messaging between users
- 👥 Group channels for webinars and classes
- 📝 Event-specific channels (consultations, subscriptions)
- 🔔 Real-time notifications
- 🔍 User search with relationship status

### Video Features

- 📹 1-on-1 consultation video calls
- 🎥 Group meetings for classes and webinars
- 🎚️ Audio/video controls and device management
- 📊 Call statistics and quality monitoring
- 🎬 Meeting recordings (MeetingSession model)

### Background Operations

- 🔄 Daily user synchronization (3:30 UTC)
- 🧹 Stale user cleanup
- 📊 User-to-database consistency checks

## ⚠️ Critical Issues

Before using Stream SDK in production, review these known issues:

### 🔴 CRITICAL: Universal Admin Role

**All users get "admin" role in Stream regardless of actual role**

- **Security Impact:** HIGH
- **Location:** `lib/user.ts:98-115`
- **Details:** [Known Issues - Bug #1](./13-known-issues.md#critical-bug-1-universal-admin-role)

### 🟡 MEDIUM: Token Race Conditions

**Token cache expiry may cause connection drops**

- **Location:** `providers/StreamProvider.tsx`
- **Details:** [Known Issues - Bug #2](./13-known-issues.md#medium-bug-2-token-expiry-race-condition)

### 🟡 MEDIUM: Channel Creation Races

**Concurrent channel creation may fail**

- **Details:** [Known Issues - Bug #3](./13-known-issues.md#medium-bug-3-channel-creation-race-conditions)

**Full bug list:** [13. Known Issues](./13-known-issues.md)

## 🔍 Finding What You Need

### I want to...

**Understand the system architecture**
→ Start with [01. Architecture Overview](./01-architecture.md)

**Set up Stream SDK locally**
→ Follow [02. Setup & Configuration](./02-setup-configuration.md)

**Implement chat features**
→ See [04. Chat Implementation](./04-chat-implementation.md)

**Implement video meetings**
→ See [05. Video Implementation](./05-video-implementation.md)

**Debug connection issues**
→ Check [14. Troubleshooting](./14-troubleshooting.md)

**Understand known bugs**
→ Review [13. Known Issues](./13-known-issues.md)

**Use Stream API endpoints**
→ Reference [10. API Endpoints](./10-api-endpoints.md)

**Create custom hooks**
→ See [11. Hooks & Utilities](./11-hooks-utilities.md)

## 📊 System Overview

```
┌─────────────────────────────────────────────┐
│            Client Application               │
│  ┌────────────┐        ┌─────────────────┐  │
│  │ StreamProv.│───────▶│ Chat Client     │  │
│  │            │        │ Video Client    │  │
│  └────────────┘        └─────────────────┘  │
│         │                       │           │
└─────────┼───────────────────────┼───────────┘
          │                       │
          ▼                       ▼
┌─────────────────────────────────────────────┐
│            Server Actions & APIs            │
│  ┌──────────────────────────────────────┐   │
│  │  Token Providers │ Channel Creation  │   │
│  │  User Sync       │ Background Jobs   │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
          │                       │
          ▼                       ▼
┌─────────────────────────────────────────────┐
│              Stream Cloud                   │
│         Chat API  │  Video API              │
└─────────────────────────────────────────────┘
```

**For detailed diagrams:** [01. Architecture Overview](./01-architecture.md)

## 🛠️ Development Workflow

### Adding New Features

1. **Plan the integration** - Understand which SDK (Chat/Video/Both)
2. **Check existing patterns** - Review implementation docs
3. **Create channels** - Use channel management patterns
4. **Handle errors** - Implement retry logic and boundaries
5. **Test thoroughly** - Check known issues and edge cases

### Common Tasks

- **Create a new channel type:** [06. Channel Management](./06-channel-management.md#creating-channels)
- **Add a new user hook:** [11. Hooks & Utilities](./11-hooks-utilities.md)
- **Debug token issues:** [14. Troubleshooting](./14-troubleshooting.md#token-issues)
- **Update background sync:** [09. Background Sync](./09-background-sync.md)

## 📝 Documentation Conventions

### Code Examples

All code examples are from the actual codebase with file references:

```typescript
// File: providers/StreamProvider.tsx
const chatClient = StreamChat.getInstance(apiKey);
```

### Diagrams

Mermaid diagrams show actual implementation flows:

- **Sequence diagrams** for time-based flows
- **Flowcharts** for decision logic
- **Component diagrams** for structure

### Callout Boxes

- 🔴 **CRITICAL** - Security or data integrity issues
- 🟡 **WARNING** - Important considerations
- 🔵 **INFO** - Helpful information
- 🟢 **TIP** - Best practices

## 🤝 Contributing

When updating this documentation:

1. Keep code examples in sync with actual implementation
2. Update diagrams when architecture changes
3. Document new bugs in [13. Known Issues](./13-known-issues.md)
4. Add troubleshooting steps for new problems

## 📅 Last Updated

- **Version:** Stream SDK Integration v1
- **Date:** November 2025
- **Maintainer:** Development Team

---

**Next:** Start with [01. Architecture Overview](./01-architecture.md) →
