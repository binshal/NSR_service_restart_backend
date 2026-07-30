const express = require("express");
const router = express.Router();
const Server = require("../models/Server");

// This router mocks the "Data Protection Advisor" REST API surface — same
// resource-based GET pattern DPA's real API uses (see routes/cyberark.js for
// the same trick applied to CyberArk CCP). It reads NO new data: every
// widget/field below is derived live from the same Server collection the
// NSR console writes to, so failing a server in the NSR tab is immediately
// visible here, and vice versa.

function jobStatusForService(status) {
  if (status === "running") return "completed";
  if (status === "restarting") return "running";
  return "failed"; // stopped
}

function assetStatusForServer(server) {
  if (server.server_status === "down") return "failed";
  if (server.services.length === 0) return "pending";
  if (server.services.some((s) => s.status === "restarting")) return "running";
  if (server.services.every((s) => s.status === "running")) return "completed";
  return "failed";
}

// GET /api/dpa/dashboard - aggregate payload for the Data Protection Central widgets
router.get("/dashboard", async (req, res) => {
  const servers = await Server.find().sort({ createdAt: -1 });

  const assetsDonut = { completed: 0, failed: 0, completedWithExceptions: 0, running: 0, pending: 0 };
  const jobsDonut = { completed: 0, failed: 0, completedWithExceptions: 0, running: 0, pending: 0 };
  const alerts = { error: 0, warn: 0, info: 0, recent: [] };
  const topOffenders = [];
  const health = { notReporting: 0, unhealthy: 0, healthy: 0, list: [] };
  const storageTop = [];

  servers.forEach((server) => {
    assetsDonut[assetStatusForServer(server)]++;

    server.services.forEach((svc) => {
      jobsDonut[jobStatusForService(svc.status)]++;
    });

    const h = { healthy: "healthy", unhealthy: "unhealthy", not_reporting: "notReporting" }[
      server.health_status
    ] || "healthy";
    health[h]++;
    health.list.push({ name: server.name, os_type: server.os_type, health: h });

    server.events.forEach((ev) => {
      let level = "info";
      if (ev.type === "fail") level = "error";
      else if (ev.type === "restart" && /initiated/.test(ev.message)) level = "warn";
      alerts[level]++;
      alerts.recent.push({ server: server.name, type: ev.type, level, message: ev.message, at: ev.at });
    });

    const failCount = server.events.filter((e) => e.type === "fail").length;
    if (failCount >= 3) {
      topOffenders.push({ server: server.name, os_type: server.os_type, failures: failCount });
    }

    storageTop.push({ server: server.name, percent: server.storage_used_percent ?? 0 });
  });

  alerts.recent.sort((a, b) => new Date(b.at) - new Date(a.at));
  alerts.recent = alerts.recent.slice(0, 6);
  storageTop.sort((a, b) => b.percent - a.percent);

  // Trend: last 7 buckets (6 days ago -> now), tallying fail vs successful-restart events
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(now);
    dayStart.setDate(now.getDate() - i);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);
    days.push({ label: i === 0 ? "Now" : String(i), dayStart, dayEnd, completed: 0, failed: 0 });
  }
  servers.forEach((server) => {
    server.events.forEach((ev) => {
      const t = new Date(ev.at);
      const bucket = days.find((d) => t >= d.dayStart && t < d.dayEnd);
      if (!bucket) return;
      if (ev.type === "fail") bucket.failed++;
      if (ev.type === "restart" && /all services running/.test(ev.message)) bucket.completed++;
    });
  });

  res.json({
    generatedAt: new Date(),
    assets: {
      total: servers.length,
      backedUp: servers.filter((s) => s.services.length > 0).length,
    },
    assetsBackupsReplications: { ...assetsDonut, total: servers.length },
    jobsBackupsReplications: {
      ...jobsDonut,
      total: jobsDonut.completed + jobsDonut.failed + jobsDonut.running + jobsDonut.pending,
    },
    trend: days.map((d) => ({ label: d.label, completed: d.completed, failed: d.failed })),
    topOffenders,
    alerts,
    health,
    storage: {
      topUtilization: storageTop.slice(0, 3),
      summary: {
        usedPercent: storageTop.length
          ? Math.round(storageTop.reduce((a, b) => a + b.percent, 0) / storageTop.length)
          : 0,
      },
    },
  });
});

// GET /api/dpa/jobs/failed
// This is the endpoint the agent's "Check DPA REST API" tool polls on a
// schedule. It mirrors DPA's real resource-based GET contract and returns
// exactly what the NSR restart agent needs to act: server name + os_type.
router.get("/jobs/failed", async (req, res) => {
  const servers = await Server.find();
  const failures = [];

  servers.forEach((server) => {
    const failedServices = server.services.filter((s) => s.status === "stopped");
    if (server.server_status === "down" || failedServices.length > 0) {
      failures.push({
        server: server.name,
        os_type: server.os_type,
        failed_services: failedServices.map((s) => s.name),
        detected_at: new Date(),
      });
    }
  });

  res.json({ count: failures.length, failures });
});

module.exports = router;
