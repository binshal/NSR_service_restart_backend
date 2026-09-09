const express = require("express");
const router = express.Router();
const Server = require("../models/Server");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Failure catalog used by the simulator. The catalog intentionally separates
// root-cause diagnosis from remediation. Only failures whose primary remedy is
// a NetWorker daemon/service restart have restart_required=true.
const FAILURE_CATALOG = {
  daemon_stopped: {
    category: "service",
    title: "NetWorker daemon stopped",
    description: "A required NetWorker daemon/service is stopped.",
    restart_required: true,
    recommended_action: "Restart only the affected NetWorker service(s), then verify status.",
  },
  daemon_crash: {
    category: "service",
    title: "NetWorker daemon crashed",
    description: "A NetWorker daemon terminated unexpectedly.",
    restart_required: true,
    recommended_action: "Restart only the affected NetWorker service(s), then verify status and logs.",
  },
  daemon_hung: {
    category: "service",
    title: "NetWorker daemon is hung",
    description: "A NetWorker daemon is present but not responding normally.",
    restart_required: true,
    recommended_action: "Restart the affected NetWorker service/daemon and verify recovery.",
  },
  rpc_nsrexecd_down: {
    category: "service_connectivity",
    title: "nsrexecd/NetWorker RPC endpoint unavailable",
    description: "The NetWorker remote execution daemon is unavailable to the backup workflow.",
    restart_required: true,
    recommended_action: "Restart nsrexecd on the affected client/host, then verify the service port and connectivity.",
  },
  nsr_server_daemon_down: {
    category: "service",
    title: "NetWorker server daemon unavailable",
    description: "The NetWorker server daemon is unavailable.",
    restart_required: true,
    recommended_action: "Restart the affected NetWorker server service/daemon; do not reboot the operating system.",
  },
  storage_full: {
    category: "storage",
    title: "Storage capacity exhausted",
    description: "The filesystem or NetWorker storage area is full or above the configured threshold.",
    restart_required: false,
    recommended_action: "Free or extend storage and retry the backup. Do not restart NSR as the first remediation.",
  },
  connectivity: {
    category: "network",
    title: "Network connectivity failure",
    description: "The host cannot communicate with the required NetWorker peer/service endpoint.",
    restart_required: false,
    recommended_action: "Fix routing, firewall, port reachability, or network availability before retrying.",
  },
  dns_resolution: {
    category: "network",
    title: "DNS/hostname resolution failure",
    description: "A required NetWorker hostname cannot be resolved correctly.",
    restart_required: false,
    recommended_action: "Fix DNS, hosts-file, or hostname configuration; restarting NSR is not the primary fix.",
  },
  authentication: {
    category: "authentication",
    title: "NetWorker authentication or peer authorization failure",
    description: "Authentication, client/server trust, or peer authorization is preventing the operation.",
    restart_required: false,
    recommended_action: "Correct credentials, peer authorization, or trust configuration.",
  },
  permission_denied: {
    category: "authorization",
    title: "Filesystem or service permission failure",
    description: "The NetWorker process cannot access a required path, device, or resource due to permissions.",
    restart_required: false,
    recommended_action: "Correct ownership, ACLs, service-account permissions, or access configuration.",
  },
  device_unavailable: {
    category: "storage_device",
    title: "Backup device unavailable",
    description: "The required backup device, volume, or storage resource is unavailable.",
    restart_required: false,
    recommended_action: "Restore device/resource availability and validate the storage path before retrying.",
  },
  license: {
    category: "configuration",
    title: "License or entitlement issue",
    description: "A licensing or entitlement condition prevents the requested operation.",
    restart_required: false,
    recommended_action: "Correct the license/entitlement issue; do not restart NSR as the primary remediation.",
  },
  configuration: {
    category: "configuration",
    title: "NetWorker configuration/policy issue",
    description: "The backup failed because of an incorrect workflow, policy, client, or save-set configuration.",
    restart_required: false,
    recommended_action: "Correct the NetWorker configuration and rerun the operation.",
  },
};

const DEFAULT_SERVICES = {
  Windows: ["nsrexecd", "nsrd", "nsrpsd"],
  AIX: ["nsrexecd", "nsrd"],
};

function toStatusPayload(server) {
  return {
    server: server.name,
    os_type: server.os_type,
    server_status: server.server_status,
    services: server.services.map((s) => ({ id: s._id, name: s.name, status: s.status })),
    running: server.services.length > 0 && server.services.every((s) => s.status === "running"),
    failure_report: server.active_failure_report,
  };
}

function buildFailureReport(code, targetServices) {
  const definition = FAILURE_CATALOG[code];
  if (!definition) return null;
  return {
    code,
    ...definition,
    target_services: targetServices,
    detected_at: new Date(),
  };
}

router.get("/failure-catalog", (req, res) => {
  res.json({
    failures: Object.entries(FAILURE_CATALOG).map(([code, value]) => ({ code, ...value })),
  });
});

router.get("/", async (req, res) => {
  const servers = await Server.find().sort({ createdAt: -1 });
  res.json(servers);
});

router.post("/", async (req, res) => {
  try {
    const { name, os_type } = req.body;
    if (!name || !os_type) return res.status(400).json({ error: "name and os_type are required" });
    if (!["Windows", "AIX"].includes(os_type)) return res.status(400).json({ error: "os_type must be Windows or AIX" });

    const server = new Server({
      name,
      os_type,
      services: DEFAULT_SERVICES[os_type].map((serviceName) => ({ name: serviceName, status: "running" })),
    });
    server.pushEvent("created", `Server ${name} (${os_type}) registered with NetWorker services`);
    await server.save();
    res.status(201).json(server);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A server with this name already exists" });
    res.status(500).json({ error: err.message });
  }
});

router.get("/:serverName", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  res.json(server);
});

router.delete("/:serverName", async (req, res) => {
  const server = await Server.findOneAndDelete({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  res.json({ deleted: true });
});

router.post("/:serverName/services", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Service name is required" });
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  server.services.push({ name, status: "running" });
  server.pushEvent("service_added", `NSR service "${name}" added`);
  await server.save();
  res.status(201).json(server);
});

router.delete("/:serverName/services/:serviceId", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  const service = server.services.id(req.params.serviceId);
  if (!service) return res.status(404).json({ error: "Service not found" });
  const removedName = service.name;
  service.deleteOne();
  server.pushEvent("service_removed", `NSR service "${removedName}" removed`);
  await server.save();
  res.json(server);
});

// Legacy whole-host failure is retained only as a host outage simulation.
// It is NOT the normal NSR remediation path.
router.post("/:serverName/fail", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  server.server_status = "down";
  server.services.forEach((s) => (s.status = "stopped"));
  server.active_failure_report = buildFailureReport("daemon_stopped", server.services.map((s) => s.name));
  server.pushEvent("fail", `Host outage simulated — NetWorker services stopped`);
  await server.save();
  res.json(toStatusPayload(server));
});

// Simulate a DPA-diagnosed NetWorker failure. This is the main testing path.
router.post("/:serverName/failure", async (req, res) => {
  const { cause, service_ids, services } = req.body;
  const definition = FAILURE_CATALOG[cause];
  if (!definition) return res.status(400).json({ error: "Unknown failure cause", available_causes: Object.keys(FAILURE_CATALOG) });

  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });

  let targets = [];
  if (Array.isArray(service_ids) && service_ids.length) {
    targets = service_ids.map((id) => server.services.id(id)).filter(Boolean);
  } else if (Array.isArray(services) && services.length) {
    targets = server.services.filter((s) => services.includes(s.name));
  } else if (definition.restart_required) {
    // For restartable daemon failures, default to nsrexecd because it is the
    // primary NetWorker client daemon. If the selected cause is nsr-server,
    // target nsrd explicitly from the UI.
    const preferred = cause === "nsr_server_daemon_down" ? ["nsrd"] : ["nsrexecd"];
    targets = server.services.filter((s) => preferred.includes(s.name));
  }

  if (definition.restart_required && targets.length === 0) {
    return res.status(400).json({ error: "The selected restartable cause requires at least one target NetWorker service" });
  }

  const targetNames = targets.map((s) => s.name);
  if (definition.restart_required) targets.forEach((s) => (s.status = "stopped"));

  server.active_failure_report = buildFailureReport(cause, targetNames);
  server.server_status = "up"; // service failures do not reboot or power off the host
  server.pushEvent("failure_report", `${definition.title}: ${targetNames.length ? targetNames.join(", ") : "no service restart target"}`);
  await server.save();
  res.json(toStatusPayload(server));
});

// Clear the DPA failure state without restarting anything.
router.post("/:serverName/failure/clear", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  server.active_failure_report = null;
  server.pushEvent("health", "Active DPA failure report cleared");
  await server.save();
  res.json(toStatusPayload(server));
});

router.post("/:serverName/health", async (req, res) => {
  const { health_status } = req.body;
  if (!["healthy", "unhealthy", "not_reporting"].includes(health_status)) return res.status(400).json({ error: "health_status must be healthy, unhealthy, or not_reporting" });
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  server.health_status = health_status;
  server.pushEvent("health", `Health status simulated as "${health_status}"`);
  await server.save();
  res.json(server);
});

router.patch("/:serverName/storage", async (req, res) => {
  const { storage_used_percent } = req.body;
  const pct = Number(storage_used_percent);
  if (Number.isNaN(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: "storage_used_percent must be a number between 0 and 100" });
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  server.storage_used_percent = pct;
  server.pushEvent("storage", `Storage utilization set to ${pct}%`);
  await server.save();
  res.json(server);
});

router.get("/:serverName/nsr-status", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  res.json(toStatusPayload(server));
});

// Restart ONLY the NetWorker services supplied by the agent/DPA report.
// The host/server_status is deliberately not changed: this simulates service
// remediation rather than an OS reboot.
router.post("/:serverName/nsr-restart", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });

  const requested = Array.isArray(req.body.services) ? req.body.services : [];
  const report = server.active_failure_report;

  if (!report) return res.status(409).json({ error: "No active DPA failure report. Diagnose before restarting a service." });
  if (!report.restart_required) {
    return res.status(409).json({
      error: "Restart not required for this root cause",
      cause: report.code,
      recommended_action: report.recommended_action,
    });
  }

  const allowed = report.target_services || [];
  const names = requested.length ? requested : allowed;
  const invalid = names.filter((name) => !allowed.includes(name));
  if (invalid.length) {
    return res.status(400).json({ error: "Agent requested a service not identified by DPA", invalid_services: invalid, allowed_services: allowed });
  }

  const targets = server.services.filter((s) => names.includes(s.name));
  if (!targets.length) return res.status(400).json({ error: "No matching NetWorker services found" });

  targets.forEach((s) => (s.status = "restarting"));
  server.pushEvent("restart", `NSR service restart initiated by agent: ${names.join(", ")}`);
  await server.save();

  await delay(1500);

  const refreshed = await Server.findOne({ name: req.params.serverName });
  if (!refreshed) return res.status(404).json({ error: "Server not found" });
  refreshed.services.filter((s) => names.includes(s.name)).forEach((s) => (s.status = "running"));
  refreshed.active_failure_report = null;
  refreshed.pushEvent("restart", `NSR services restarted by agent: ${names.join(", ")}`);
  await refreshed.save();

  res.json(toStatusPayload(refreshed));
});

module.exports = router;
