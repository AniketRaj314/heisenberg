export function createRateLimiter({ limit, windowMs }) {
  const attempts = new Map();

  function consume(key) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (attempts.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= limit) {
      const retryAfterMs = recent[0] + windowMs - now;
      attempts.set(key, recent);
      return { allowed: false, retryAfterMs };
    }
    recent.push(now);
    attempts.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }

  return { consume };
}

export function rateLimitMiddleware(limiter, keyForRequest = (request) => request.ip) {
  return (request, response, next) => {
    const result = limiter.consume(keyForRequest(request));
    if (result.allowed) return next();
    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    response.set("Retry-After", String(retryAfterSeconds));
    return response.status(429).json({
      error: "rate_limited",
      message: "Too many requests. Try again later.",
      retry_after_seconds: retryAfterSeconds
    });
  };
}
