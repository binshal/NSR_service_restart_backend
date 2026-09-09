const express = require("express");
const router = express.Router();
const Server = require("../models/Server");

function jobStatusForService(status) {
  if (status === "running") return "completed";
  if (status === "restarting") return "running";
  return "failed";
}

function assetStatusForServer(server) {
  if (server.server_status === "down") return "failed";
  if (server.services.length === 0) return "pending";
  if (server.services.some((s) => s.status === "restarting")) return "running";
  if (server.services.every((s) => s.status === "running")) return "completed";
  return "failed";
}

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
    server.services.forEach((svc) => jobsDonut[jobStatusForService(svc.status)]++);

    const h = { healthy: "healthy", unhealthy: "unhealthy", not_reporting: "notReporting" }[server.health_status] || "healthy";
    health[h]++;
    health.list.push({ name: server.name, os_type: server.os_type, health: h });

    server.events.forEach((ev) => {
      let level = "info";
      if (ev.type === "fail" || ev.type === "failure_report") level = "error";
      else if (ev.type === "restart" && /initiated/.test(ev.message)) level = "warn";
      alerts[level]++;
      alerts.recent.push({ server: server.name, type: ev.type, level, message: ev.message, at: ev.at });
    });

    const failCount = server.events.filter((e) => e.type === "fail" || e.type === "failure_report").length;
    if (failCount >= 3) topOffenders.push({ server: server.name, os_type: server.os_type, failures: failCount });
    storageTop.push({ server: server.name, percent: server.storage_used_percent ?? 0 });
  });

  alerts.recent.sort((a, b) => new Date(b.at) - new Date(a.at));
  alerts.recent = alerts.recent.slice(0, 6);
  storageTop.sort((a, b) => b.percent - a.percent);

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
  servers.forEach((server) => server.events.forEach((ev) => {
    const t = new Date(ev.at);
    const bucket = days.find((d) => t >= d.dayStart && t < d.dayEnd);
    if (!bucket) return;
    if (ev.type === "fail" || ev.type === "failure_report") bucket.failed++;
    if (ev.type === "restart" && /services restarted/.test(ev.message)) bucket.completed++;
  }));

  res.json({
    generatedAt: new Date(),
    assets: { total: servers.length, backedUp: servers.filter((s) => s.services.length > 0).length },
    assetsBackupsReplications: { ...assetsDonut, total: servers.length },
    jobsBackupsReplications: { ...jobsDonut, total: jobsDonut.completed + jobsDonut.failed + jobsDonut.running + jobsDonut.pending },
    trend: days.map((d) => ({ label: d.label, completed: d.completed, failed: d.failed })),
    topOffenders,
    alerts,
    health,
    storage: {
      topUtilization: storageTop.slice(0, 3),
      summary: { usedPercent: storageTop.length ? Math.round(storageTop.reduce((a, b) => a + b.percent, 0) / storageTop.length) : 0 },
    },
  });
});

// DPA-style failure endpoint. In production, DPA is the source of monitoring/
// analytics data; the remediation agent reads the diagnosis and decides what
// to do. The important contract is: failed services + root cause + target
// services + restart_required. DPA itself is not rebooting the host here.
router.get("/jobs/failed", async (req, res) => {
  const servers = await Server.find();
  const failures = servers
    .filter((server) => server.active_failure_report || server.services.some((s) => s.status === "stopped"))
    .map((server) => {
      const report = server.active_failure_report;
      const failedServices = server.services.filter((s) => s.status === "stopped").map((s) => s.name);

      return {
        server: server.name,
        os_type: server.os_type,
        server_status: server.server_status,
        failed_services: failedServices,
        failure_report: report || {
          code: "service_stopped_unknown_cause",
          category: "service",
          title: "NetWorker service is stopped",
          description: "A NetWorker service is stopped but no root cause has been classified yet.",
          restart_required: false,
          target_services: failedServices,
          recommended_action: "Do not restart until the failure cause is diagnosed.",
          detected_at: new Date(),
        },
        detected_at: report?.detected_at || new Date(),
      };
    });

  res.json({ count: failures.length, failures });
});

// One failure is exposed as a service-level DPA diagnosis for agent testing.
router.get("/jobs/failed/:serverName", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });

  const failedServices = server.services.filter((s) => s.status === "stopped").map((s) => s.name);
  if (!server.active_failure_report && failedServices.length === 0) {
    return res.json({ count: 0, failures: [] });
  }

  res.json({
    count: 1,
    failures: [{
      server: server.name,
      os_type: server.os_type,
      server_status: server.server_status,
      failed_services: failedServices,
      failure_report: server.active_failure_report,
      detected_at: server.active_failure_report?.detected_at || new Date(),
    }],
  });
});

module.exports = router;
