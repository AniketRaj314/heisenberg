import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHealthSnapshot } from "../src/health.js";

test("package and lockfile versions remain aligned at 1.0.0", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  const packageLock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8")
  );
  assert.equal(packageJson.version, "1.0.0");
  assert.equal(packageLock.version, "1.0.0");
  assert.equal(packageLock.packages[""].version, "1.0.0");
});

test("health snapshot exposes public-safe operational metadata", () => {
  const snapshot = createHealthSnapshot({
    version: "1.0.0",
    startedAt: new Date("2026-07-23T10:00:00.000Z"),
    now: new Date("2026-07-23T10:02:03.000Z"),
    uptimeSeconds: 123.9,
    memoryUsage: {
      rss: 128 * 1024 * 1024,
      heapUsed: 32.5 * 1024 * 1024
    },
    environment: {
      NODE_ENV: "production",
      TZ: "Asia/Kolkata",
      RAILWAY_ENVIRONMENT_NAME: "production",
      RAILWAY_GIT_COMMIT_SHA: "1234567890abcdef"
    },
    components: {
      http: "healthy",
      storage: "healthy",
      mcp: "healthy",
      telegram: "healthy",
      scheduler: "healthy"
    }
  });
  assert.deepEqual(snapshot, {
    status: "ok",
    service: "heisenberg",
    version: "1.0.0",
    timestamp: "2026-07-23T10:02:03.000Z",
    started_at: "2026-07-23T10:00:00.000Z",
    uptime_seconds: 123,
    runtime: {
      memory_mb: { rss: 128, heap_used: 32.5 },
      timezone: "Asia/Kolkata"
    },
    deployment: {
      platform: "railway",
      environment: "production",
      commit: "1234567890ab"
    },
    components: {
      http: "healthy",
      storage: "healthy",
      mcp: "healthy",
      telegram: "healthy",
      scheduler: "healthy"
    }
  });
});

test("health snapshot reports startup and failure states", () => {
  const base = {
    version: "1.0.0",
    startedAt: new Date("2026-07-23T10:00:00.000Z"),
    now: new Date("2026-07-23T10:00:01.000Z"),
    uptimeSeconds: 1,
    memoryUsage: { rss: 0, heapUsed: 0 },
    environment: {}
  };
  assert.equal(
    createHealthSnapshot({
      ...base,
      components: { http: "starting", storage: "healthy" }
    }).status,
    "starting"
  );
  assert.equal(
    createHealthSnapshot({
      ...base,
      components: { http: "healthy", storage: "failed" }
    }).status,
    "degraded"
  );
});
