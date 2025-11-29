# Production-Grade Scheduling System Architecture

## 1. Database Optimizations

### A. Database Indexing

```sql
-- Key indexes for the appointment system
CREATE INDEX idx_slot_start_time ON slots_of_appointment(slot_start_time_in_utc);
CREATE INDEX idx_consultant_availability ON slots_of_availability_weekly(consultant_profile_id, day_of_week);
CREATE INDEX idx_appointment_status ON appointments(status);
CREATE INDEX idx_user_appointments ON appointments(user_id, status);
```

### B. Database Partitioning

```sql
-- Partition tables by date ranges
CREATE TABLE appointments_partition OF appointments
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

-- Partition by consultant_id for large consultant bases
PARTITION appointments BY HASH (consultant_id);
```

### C. Caching Strategy

```typescript
// Redis cache structure for availability
interface AvailabilityCache {
  consultant_id: string;
  schedule_type: "WEEKLY" | "CUSTOM";
  availability: {
    [date: string]: {
      start_time: string;
      end_time: string;
      is_booked: boolean;
    }[];
  };
}

// Cache invalidation strategy
const CACHE_TTL = {
  AVAILABILITY: 3600, // 1 hour
  APPOINTMENTS: 1800, // 30 minutes
  USER_DATA: 3600, // 1 hour
};
```

## 2. System Architecture

### A. Load Balancing

```typescript
// HAProxy Configuration
global
    maxconn 50000

frontend scheduling_frontend
    bind *:80
    mode http
    default_backend scheduling_servers

backend scheduling_servers
    mode http
    balance roundrobin
    server server1 10.0.0.1:8080 check
    server server2 10.0.0.2:8080 check
    server server3 10.0.0.3:8080 check
```

### B. Message Queue System

```typescript
// RabbitMQ configuration for async operations
interface AllocationMessage {
  type: "CONSULTATION" | "SUBSCRIPTION";
  requestId: string;
  userId: string;
  consultantId: string;
  slots: string[];
  priority: number;
}

const queueConfig = {
  name: "slot_allocation",
  options: {
    durable: true,
    deadLetterExchange: "slot_allocation_dlx",
  },
};
```

### C. Microservices Architecture

```typescript
// Service separation
interface Services {
  AuthenticationService: Express.Application;
  AvailabilityService: Express.Application;
  BookingService: Express.Application;
  NotificationService: Express.Application;
  PaymentService: Express.Application;
}

// Inter-service communication
interface ServiceMessage {
  type: ServiceMessageType;
  payload: any;
  metadata: {
    timestamp: number;
    source: string;
    correlationId: string;
  };
}
```

## 3. Concurrency Handling

### A. Slot Locking Mechanism

```typescript
// Distributed locking using Redis
async function acquireSlotLock(
  slotId: string,
  userId: string,
): Promise<boolean> {
  const lockKey = `slot_lock:${slotId}`;
  const lockValue = userId;
  const lockTTL = 30; // seconds

  return await redis.set(lockKey, lockValue, "NX", "EX", lockTTL);
}

// Optimistic locking in database
const slotVersion = await prisma.slot.findUnique({
  where: { id: slotId },
  select: { version: true },
});

try {
  await prisma.slot.update({
    where: {
      id: slotId,
      version: slotVersion.version,
    },
    data: {
      status: "BOOKED",
      version: { increment: 1 },
    },
  });
} catch (error) {
  // Handle concurrent modification
}
```

### B. Rate Limiting

```typescript
// Rate limiting middleware
const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP",
});

// API-specific limits
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 booking attempts per minute
  message: "Booking rate limit exceeded",
});
```

### C. Request Queue Management

```typescript
// Priority queue for allocation requests
class AllocationQueue {
  private queue: PriorityQueue<AllocationRequest>;
  private processing: boolean = false;

  async enqueue(request: AllocationRequest): Promise<void> {
    this.queue.add(request, request.priority);
    if (!this.processing) {
      await this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    while (!this.queue.isEmpty()) {
      const request = this.queue.pop();
      try {
        await this.processAllocation(request);
      } catch (error) {
        await this.handleAllocationError(request, error);
      }
    }
    this.processing = false;
  }
}
```

## 4. Monitoring and Error Handling

### A. Logging System

```typescript
// Structured logging
interface LogEntry {
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR";
  service: string;
  traceId: string;
  userId?: string;
  action: string;
  details: any;
}

const logger = winston.createLogger({
  format: winston.format.json(),
  defaultMeta: { service: "scheduling-service" },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});
```

### B. Metrics Collection

```typescript
// Prometheus metrics
const metrics = {
  bookingAttempts: new Counter({
    name: "booking_attempts_total",
    help: "Total number of booking attempts",
  }),
  bookingSuccess: new Counter({
    name: "booking_success_total",
    help: "Total number of successful bookings",
  }),
  allocationDuration: new Histogram({
    name: "allocation_duration_seconds",
    help: "Time taken for slot allocation",
  }),
};
```

### C. Circuit Breaker

```typescript
// Circuit breaker for external services
const circuitBreakerOptions = {
  timeout: 3000, // 3 seconds
  errorThresholdPercentage: 50,
  resetTimeout: 30000, // 30 seconds
};

const paymentServiceBreaker = new CircuitBreaker(
  makePayment,
  circuitBreakerOptions,
);
```

## 5. Deployment Strategy

### A. Container Configuration

```yaml
# Docker Compose configuration
version: "3.8"
services:
  scheduling-service:
    build: .
    replicas: 3
    deploy:
      resources:
        limits:
          cpus: "2"
          memory: 4G
      restart_policy:
        condition: on-failure
        max_attempts: 3
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### B. Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scheduling-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: scheduling
  template:
    metadata:
      labels:
        app: scheduling
    spec:
      containers:
        - name: scheduling-service
          image: scheduling-service:latest
          resources:
            requests:
              memory: "2Gi"
              cpu: "1"
            limits:
              memory: "4Gi"
              cpu: "2"
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
```

## 6. Security Measures

### A. Rate Limiting by User

```typescript
const userRateLimiter = new RateLimiter({
  points: 100, // Number of points
  duration: 60, // Per 60 seconds
  blockDuration: 120, // Block for 120 seconds if consumed
});

async function checkUserLimit(userId: string): Promise<boolean> {
  try {
    await userRateLimiter.consume(userId);
    return true;
  } catch (error) {
    return false;
  }
}
```

### B. Request Validation

```typescript
// Request validation middleware
const validateBookingRequest = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const schema = Joi.object({
    consultantId: Joi.string().required(),
    slotId: Joi.string().required(),
    duration: Joi.number().min(30).max(180).required(),
    timezone: Joi.string().required(),
  });

  const { error } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }
  next();
};
```

## 7. Testing Strategy

### A. Load Testing

```typescript
// k6 load testing script
export const options = {
  scenarios: {
    heavy_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 100 },
        { duration: "5m", target: 100 },
        { duration: "2m", target: 200 },
        { duration: "5m", target: 200 },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
};

export default function () {
  const response = http.post(`${BASE_URL}/api/booking`, {
    consultantId: "test-consultant",
    slotId: "test-slot",
    duration: 60,
  });
  check(response, {
    "is status 200": (r) => r.status === 200,
    "transaction time OK": (r) => r.timings.duration < 200,
  });
  sleep(1);
}
```

### B. Chaos Testing

```typescript
// Chaos monkey configuration
const chaosConfig = {
  enabled: true,
  probability: 0.1,
  services: ["database", "cache", "message-queue"],
  actions: ["delay", "error", "kill"],
  excludedEnvironments: ["production"],
};
```
