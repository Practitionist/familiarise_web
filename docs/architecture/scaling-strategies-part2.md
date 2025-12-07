I'll outline a comprehensive production-grade architecture to handle high concurrency for this scheduling system.

Let me highlight the key areas you need to focus on for production-grade implementation:

1. Performance Optimization:

```typescript
- Implement aggressive caching using Redis for:
  - Consultant availability
  - User session data
  - Common query results
- Use database indexing on frequently queried fields
- Implement database partitioning for large datasets
```

2. Concurrency Control:

```typescript
- Implement distributed locking using Redis
- Use optimistic locking for database operations
- Queue system for handling allocation requests
- Rate limiting per user/IP
```

3. Scalability:

```typescript
- Break down into microservices:
  - Authentication Service
  - Availability Service
  - Booking Service
  - Notification Service
  - Payment Service
- Use message queues (RabbitMQ/Kafka) for async operations
- Implement horizontal scaling with Kubernetes
```

4. High Availability:

```typescript
- Deploy across multiple regions
- Implement failover mechanisms
- Use load balancers
- Set up database replication
```

5. Monitoring and Error Handling:

```typescript
- Implement comprehensive logging
- Set up metrics collection (Prometheus)
- Use circuit breakers for external services
- Implement retry mechanisms with exponential backoff
```

6. Security:

```typescript
- Rate limiting
- Request validation
- SQL injection prevention
- Authentication/Authorization checks
```

Would you like me to elaborate on any of these aspects? I can provide more detailed implementation examples for specific areas you're interested in.
