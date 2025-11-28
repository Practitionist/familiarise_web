# Stream SDK Hooks & Utilities

Comprehensive guide to custom hooks and utilities for Stream Chat and Video integration.

## Navigation

- [Back to README](./README.md)
- [Architecture](./01-architecture.md)
- [Setup & Configuration](./02-setup-configuration.md)
- [Provider & Authentication](./03-provider-authentication.md)
- [Error Handling](./12-error-handling.md)
- [Known Issues](./13-known-issues.md)
- [Troubleshooting](./14-troubleshooting.md)

---

## Table of Contents

1. [Core Hooks](#core-hooks)
   - [useGetCallById](#usegetcallbyid)
   - [useStreamConnection](#usestreamconnection)
   - [useUserData](#useuserdata)
2. [Stream SDK Hooks](#stream-sdk-hooks)
3. [Custom Hook Patterns](#custom-hook-patterns)
4. [Error Handling in Hooks](#error-handling-in-hooks)
5. [Best Practices](#best-practices)

---

## Core Hooks

### useGetCallById

The `useGetCallById` hook fetches or creates a Stream Video call by its ID. It handles both existing and new calls seamlessly.

#### Location

```
/app/meetings/[id]/hooks/useGetCallById.ts
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `callId` | `string` | Yes | Unique identifier for the call |

#### Return Values

| Property | Type | Description |
|----------|------|-------------|
| `call` | `Call \| null` | Stream Video call instance or null if not loaded |
| `isCallLoading` | `boolean` | Loading state indicator |
| `error` | `Error \| null` | Error object if call fetch/creation failed |

#### Implementation

```typescript
import { useGetCallById } from '@/app/meetings/[id]/hooks/useGetCallById';

function MeetingPage({ callId }: { callId: string }) {
  const { call, isCallLoading, error } = useGetCallById(callId);

  if (isCallLoading) {
    return <LoadingSpinner />;
  }

  if (error) {
    return <ErrorDisplay error={error} />;
  }

  if (!call) {
    return <div>No call found</div>;
  }

  return <StreamCall call={call}>{/* Meeting UI */}</StreamCall>;
}
```

#### How It Works

The hook performs the following steps:

1. **Validates Prerequisites**
   - Checks if `StreamVideoClient` is available
   - Validates that `callId` is provided

2. **Query First Approach**
   ```typescript
   // First, attempts to find existing call
   const { calls } = await client.queryCalls({
     filter_conditions: { id: callId },
   });
   ```

3. **Fallback Creation**
   ```typescript
   // If no call found, creates new call with default type
   if (calls.length === 0) {
     const callInstance = client.call('default', callId);
     await callInstance.getOrCreate();
   }
   ```

4. **Error Handling**
   - Sets error state for missing client
   - Sets error state for missing call ID
   - Catches and logs all fetch/creation errors

#### Error States

| Error Condition | Error Message | Description |
|----------------|---------------|-------------|
| No client | "Video client not available" | StreamProvider not initialized |
| No call ID | "Call ID is required" | Invalid or missing callId parameter |
| Query/Create failure | Varies | Network, permission, or API errors |

#### Usage Example with Error Handling

```typescript
function MeetingRoom({ meetingId }: { meetingId: string }) {
  const { call, isCallLoading, error } = useGetCallById(meetingId);

  useEffect(() => {
    if (error) {
      console.error('Failed to get call:', error);

      if (error.message.includes('client not available')) {
        // Handle client initialization error
        toast.error('Video service not initialized');
      } else if (error.message.includes('Call ID is required')) {
        // Handle missing ID
        redirect('/meetings');
      }
    }
  }, [error]);

  if (isCallLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner />
        <p>Loading call...</p>
      </div>
    );
  }

  if (error) {
    return (
      <ErrorBoundary error={error}>
        <Button onClick={() => window.location.reload()}>
          Retry
        </Button>
      </ErrorBoundary>
    );
  }

  return call ? <VideoMeeting call={call} /> : null;
}
```

---

### useStreamConnection

The `useStreamConnection` hook provides access to the Stream connection state and retry functionality.

#### Location

```
/providers/StreamProvider.tsx
```

#### Return Values

| Property | Type | Description |
|----------|------|-------------|
| `chatConnected` | `boolean` | Chat client connection status |
| `videoConnected` | `boolean` | Video client connection status |
| `isConnecting` | `boolean` | Connection in progress indicator |
| `error` | `string \| null` | Current connection error message |
| `retryConnection` | `() => void` | Function to retry failed connection |

#### Implementation

```typescript
import { useStreamConnection } from '@/providers/StreamProvider';

function ConnectionMonitor() {
  const {
    chatConnected,
    videoConnected,
    isConnecting,
    error,
    retryConnection
  } = useStreamConnection();

  return (
    <div className="connection-status">
      <StatusIndicator
        label="Chat"
        connected={chatConnected}
        loading={isConnecting}
      />
      <StatusIndicator
        label="Video"
        connected={videoConnected}
        loading={isConnecting}
      />

      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <button onClick={retryConnection}>Retry</button>
        </div>
      )}
    </div>
  );
}
```

#### Usage Patterns

##### Connection Status Display

```typescript
function ConnectionStatusBadge() {
  const { chatConnected, videoConnected } = useStreamConnection();

  const isFullyConnected = chatConnected && videoConnected;

  return (
    <Badge variant={isFullyConnected ? 'success' : 'warning'}>
      {isFullyConnected ? 'Connected' : 'Connecting...'}
    </Badge>
  );
}
```

##### Conditional Feature Enabling

```typescript
function ChatFeature() {
  const { chatConnected } = useStreamConnection();

  if (!chatConnected) {
    return <p>Chat is connecting...</p>;
  }

  return <ChatInterface />;
}
```

##### Manual Retry with User Feedback

```typescript
function ConnectionErrorHandler() {
  const { error, retryConnection, isConnecting } = useStreamConnection();
  const [retryAttempts, setRetryAttempts] = useState(0);

  const handleRetry = () => {
    setRetryAttempts(prev => prev + 1);
    retryConnection();
  };

  if (!error) return null;

  return (
    <Alert variant="destructive">
      <AlertTitle>Connection Failed</AlertTitle>
      <AlertDescription>
        {error}
        {retryAttempts > 0 && ` (Attempt ${retryAttempts})`}
      </AlertDescription>
      <Button
        onClick={handleRetry}
        disabled={isConnecting}
        className="mt-2"
      >
        {isConnecting ? 'Retrying...' : 'Retry Connection'}
      </Button>
    </Alert>
  );
}
```

#### Important Notes

- Must be used within `StreamProvider` component tree
- Throws error if used outside provider context
- Connection state updates automatically
- `retryConnection` resets attempt counter

---

### useUserData

The `useUserData` hook fetches comprehensive user details including profile and reviews based on user role.

#### Location

```
/hooks/useUserData.ts
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `userId` | `string` | Yes | User ID to fetch details for |

#### Return Values

| Property | Type | Description |
|----------|------|-------------|
| `userDetails` | `User \| null` | Core user object with auth data |
| `profileDetails` | `TConsultantProfile \| TConsulteeProfile \| TStaffProfile \| null` | Role-specific profile data |
| `reviews` | `ConsultantReview[]` | Reviews array (consultants only) |
| `isLoading` | `boolean` | Loading state indicator |
| `error` | `Error \| null` | Error object if fetch failed |

#### Implementation

```typescript
import { useUserData } from '@/hooks/useUserData';

function UserProfile({ userId }: { userId: string }) {
  const {
    userDetails,
    profileDetails,
    reviews,
    isLoading,
    error
  } = useUserData(userId);

  if (isLoading) return <Skeleton />;
  if (error) return <ErrorDisplay error={error} />;
  if (!userDetails) return <NotFound />;

  return (
    <div>
      <h1>{userDetails.name}</h1>
      <p>{userDetails.email}</p>
      <RoleBadge role={userDetails.role} />

      {userDetails.role === 'CONSULTANT' && (
        <ConsultantProfile
          profile={profileDetails as TConsultantProfile}
          reviews={reviews}
        />
      )}
    </div>
  );
}
```

#### Role-Based Data Loading

The hook automatically fetches appropriate profile data based on user role:

##### CONSULTANT

```typescript
// Fetches:
// - User details
// - Consultant profile
// - Consultant reviews
if (userData.role === 'CONSULTANT' && userData.consultantProfileId) {
  const consultantData = await fetchConsultantDetails(
    userData.consultantProfileId
  );
  const reviewsData = await fetchReviews(userData.consultantProfileId);
}
```

##### CONSULTEE

```typescript
// Fetches:
// - User details
// - Consultee profile
if (userData.role === 'CONSULTEE' && userData.consulteeProfileId) {
  const consulteeData = await fetchConsulteeDetails(
    userData.consulteeProfileId
  );
}
```

##### STAFF

```typescript
// Fetches:
// - User details
// - Staff profile
if (userData.role === 'STAFF' && userData.staffProfileId) {
  const staffData = await fetchStaffDetails(userData.staffProfileId);
}
```

#### Error Handling

The hook displays toast notifications on error:

```typescript
catch (err: any) {
  console.error('Error fetching user details:', err);
  setError(err);
  toast({
    title: 'Error fetching user details',
    description: err.message,
    variant: 'destructive',
  });
}
```

#### Usage in Stream Provider

```typescript
// StreamProvider uses this hook to get user data for connection
function StreamProvider({ userId, children }: StreamProviderProps) {
  const { userDetails, isLoading } = useUserData(userId);

  useEffect(() => {
    if (!isLoading && userDetails) {
      connectToStream(userDetails);
    }
  }, [userDetails, isLoading]);

  return isLoading ? <Spinner /> : children;
}
```

---

## Stream SDK Hooks

The Stream SDK provides built-in hooks for accessing clients and state:

### useStreamVideoClient

Access the Stream Video client instance.

```typescript
import { useStreamVideoClient } from '@stream-io/video-react-sdk';

function VideoComponent() {
  const client = useStreamVideoClient();

  if (!client) {
    return <p>Video client not available</p>;
  }

  // Use client for operations
  const createCall = async () => {
    const call = client.call('default', 'my-call-id');
    await call.getOrCreate();
  };

  return <button onClick={createCall}>Create Call</button>;
}
```

### useChatContext

Access the Stream Chat client and connection state.

```typescript
import { useChatContext } from 'stream-chat-react';

function ChatComponent() {
  const { client, connectionState } = useChatContext();

  if (connectionState !== 'connected') {
    return <p>Connecting to chat...</p>;
  }

  return <ChannelList filters={{ members: { $in: [client.userID!] } }} />;
}
```

### useCall

Access current call state and controls.

```typescript
import { useCall } from '@stream-io/video-react-sdk';

function CallControls() {
  const call = useCall();

  if (!call) return null;

  return (
    <div>
      <button onClick={() => call.microphone.toggle()}>
        Toggle Mic
      </button>
      <button onClick={() => call.camera.toggle()}>
        Toggle Camera
      </button>
      <button onClick={() => call.leave()}>
        Leave Call
      </button>
    </div>
  );
}
```

---

## Custom Hook Patterns

### Token Refresh Hook

```typescript
function useTokenRefresh(userId: string) {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  const refreshToken = useCallback(async () => {
    const newToken = await tokenProvider(userId);
    const expiresAt = Date.now() + 50 * 60 * 1000; // 50 minutes

    setToken(newToken);
    setExpiresAt(expiresAt);

    return newToken;
  }, [userId]);

  useEffect(() => {
    // Refresh token when it's about to expire
    if (!expiresAt) return;

    const timeUntilExpiry = expiresAt - Date.now();
    const refreshTime = timeUntilExpiry - 5 * 60 * 1000; // 5 min before

    if (refreshTime > 0) {
      const timer = setTimeout(refreshToken, refreshTime);
      return () => clearTimeout(timer);
    }
  }, [expiresAt, refreshToken]);

  return { token, refreshToken };
}
```

### Call State Hook

```typescript
function useCallState(callId: string) {
  const { call, isCallLoading, error } = useGetCallById(callId);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [callState, setCallState] = useState<'idle' | 'ringing' | 'joined'>('idle');

  useEffect(() => {
    if (!call) return;

    const unsubscribe = call.on('call.session_participant_joined', (event) => {
      console.log('Participant joined:', event.participant);
      setParticipants(call.state.participants);
    });

    return unsubscribe;
  }, [call]);

  return {
    call,
    participants,
    callState,
    isLoading: isCallLoading,
    error,
  };
}
```

### Connection Health Hook

```typescript
function useConnectionHealth() {
  const { chatConnected, videoConnected, error } = useStreamConnection();
  const [health, setHealth] = useState<'healthy' | 'degraded' | 'offline'>('healthy');

  useEffect(() => {
    if (error) {
      setHealth('offline');
    } else if (chatConnected && videoConnected) {
      setHealth('healthy');
    } else {
      setHealth('degraded');
    }
  }, [chatConnected, videoConnected, error]);

  return health;
}
```

---

## Error Handling in Hooks

### Pattern 1: Error State Management

```typescript
function useStreamOperation<T>(operation: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const execute = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await operation();
      setData(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Operation failed');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [operation]);

  return { data, error, isLoading, execute };
}
```

### Pattern 2: Retry Logic

```typescript
function useStreamRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3
) {
  const [attempts, setAttempts] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(async () => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const result = await operation();
        setData(result);
        setAttempts(0);
        return result;
      } catch (err) {
        setAttempts(i + 1);
        if (i === maxRetries - 1) {
          setError(err instanceof Error ? err : new Error('Failed'));
          throw err;
        }
        // Exponential backoff
        await new Promise(resolve =>
          setTimeout(resolve, Math.pow(2, i) * 1000)
        );
      }
    }
  }, [operation, maxRetries]);

  return { data, error, attempts, execute };
}
```

### Pattern 3: Error Boundaries Integration

```typescript
function useStreamErrorHandler() {
  const [error, setError] = useState<Error | null>(null);

  const handleError = useCallback((err: unknown) => {
    const error = err instanceof Error ? err : new Error('Unknown error');

    console.error('Stream error:', error);
    setError(error);

    // Log to monitoring service
    if (process.env.NODE_ENV === 'production') {
      // Sentry, LogRocket, etc.
      logError(error);
    }

    return error;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { error, handleError, clearError };
}
```

---

## Best Practices

### 1. Always Check Client Availability

```typescript
function MyComponent() {
  const client = useStreamVideoClient();

  if (!client) {
    return <StreamClientError />;
  }

  // Safe to use client
}
```

### 2. Handle Loading States Gracefully

```typescript
function DataComponent({ userId }: { userId: string }) {
  const { userDetails, isLoading, error } = useUserData(userId);

  // Loading state first
  if (isLoading) {
    return <Skeleton />;
  }

  // Error state second
  if (error) {
    return <ErrorDisplay error={error} />;
  }

  // Empty state third
  if (!userDetails) {
    return <EmptyState />;
  }

  // Success state last
  return <UserDisplay user={userDetails} />;
}
```

### 3. Cleanup Subscriptions

```typescript
function useCallEvents(call: Call | null) {
  useEffect(() => {
    if (!call) return;

    const unsubscribe = call.on('*', (event) => {
      console.log('Call event:', event);
    });

    // Always cleanup
    return () => unsubscribe();
  }, [call]);
}
```

### 4. Memoize Expensive Operations

```typescript
function useFilteredChannels(userId: string) {
  const { client } = useChatContext();

  const filters = useMemo(() => ({
    type: 'messaging',
    members: { $in: [userId] },
  }), [userId]);

  const sort = useMemo(() => ({
    last_message_at: -1,
  }), []);

  return { filters, sort };
}
```

### 5. Combine Related Hooks

```typescript
function useStreamSetup(userId: string) {
  const { userDetails, isLoading: userLoading } = useUserData(userId);
  const {
    chatConnected,
    videoConnected,
    isConnecting,
    error
  } = useStreamConnection();

  const isReady = useMemo(
    () => !userLoading && !isConnecting && chatConnected && videoConnected,
    [userLoading, isConnecting, chatConnected, videoConnected]
  );

  return {
    userDetails,
    isReady,
    error,
    isLoading: userLoading || isConnecting,
  };
}
```

### 6. Type Safety

```typescript
import { Call, StreamVideoClient } from '@stream-io/video-react-sdk';
import { StreamChat } from 'stream-chat';

function useTypedStreamClients() {
  const videoClient = useStreamVideoClient() as StreamVideoClient | undefined;
  const { client: chatClient } = useChatContext() as {
    client: StreamChat | undefined
  };

  return { videoClient, chatClient };
}
```

### 7. Error Context Propagation

```typescript
function useStreamWithErrorContext(userId: string) {
  const { userDetails, error: userError } = useUserData(userId);
  const { error: connectionError } = useStreamConnection();

  const error = useMemo(
    () => userError || connectionError,
    [userError, connectionError]
  );

  return { userDetails, error };
}
```

---

## Next Steps

- Learn about [Error Handling](./12-error-handling.md)
- Review [Known Issues](./13-known-issues.md)
- Check [Troubleshooting Guide](./14-troubleshooting.md)
- Return to [README](./README.md)

---

**Last Updated:** 2025-11-29
