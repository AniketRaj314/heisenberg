function megabytes(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function overallStatus(components) {
  const states = Object.values(components);
  if (states.includes("failed")) return "degraded";
  if (states.includes("starting")) return "starting";
  if (states.includes("stopping")) return "stopping";
  return "ok";
}

export function createHealthSnapshot({
  version,
  startedAt,
  components,
  now = new Date(),
  uptimeSeconds = process.uptime(),
  memoryUsage = process.memoryUsage(),
  environment = process.env
}) {
  const railway =
    Boolean(environment.RAILWAY_ENVIRONMENT_NAME) ||
    Boolean(environment.RAILWAY_PROJECT_ID);
  return {
    status: overallStatus(components),
    service: "heisenberg",
    version,
    timestamp: now.toISOString(),
    started_at: startedAt.toISOString(),
    uptime_seconds: Math.floor(uptimeSeconds),
    runtime: {
      memory_mb: {
        rss: megabytes(memoryUsage.rss),
        heap_used: megabytes(memoryUsage.heapUsed)
      },
      timezone: environment.TZ || "Asia/Kolkata"
    },
    deployment: {
      platform: railway ? "railway" : "local",
      environment:
        environment.RAILWAY_ENVIRONMENT_NAME ||
        environment.NODE_ENV ||
        "development",
      commit: environment.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || null
    },
    components: { ...components }
  };
}
