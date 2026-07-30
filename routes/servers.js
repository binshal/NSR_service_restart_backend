const express = require("express");
const router = express.Router();
const Server = require("../models/Server");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shape a server document into the status payload the restart agent scripts expect
// (mirrors the mock API contract used by restart_nsr_windows / restart_nsr_aix)
function toStatusPayload(server) {
  return {
    server: server.name,
    os_type: server.os_type,
    server_status: server.server_status,
    services: server.services.map((s) => ({
      id: s._id,
      name: s.name,
      status: s.status,
    })),
    running: server.services.length > 0 && server.services.every((s) => s.status === "running"),
  };
}

// GET /api/servers - list all servers
router.get("/", async (req, res) => {
  const servers = await Server.find().sort({ createdAt: -1 });
  res.json(servers);
});

// POST /api/servers - add a new server
router.post("/", async (req, res) => {
  try {
    const { name, os_type } = req.body;
    if (!name || !os_type) {
      return res.status(400).json({ error: "name and os_type are required" });
    }
    if (!["Windows", "AIX"].includes(os_type)) {
      return res.status(400).json({ error: "os_type must be Windows or AIX" });
    }
    const server = new Server({ name, os_type });
    server.pushEvent("created", `Server ${name} (${os_type}) registered`);
    await server.save();
    res.status(201).json(server);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "A server with this name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:serverName - get one server
router.get("/:serverName", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  res.json(server);
});

// DELETE /api/servers/:serverName
router.delete("/:serverName", async (req, res) => {
  const server = await Server.findOneAndDelete({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  res.json({ deleted: true });
});

// POST /api/servers/:serverName/services - add an NSR service to a server
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

// DELETE /api/servers/:serverName/services/:serviceId
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

// POST /api/servers/:serverName/fail - simulate the server going down
// (backup services stop running, as in the SOP's failure scenario)
router.post("/:serverName/fail", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });

  server.server_status = "down";
  server.services.forEach((s) => (s.status = "stopped"));
  server.pushEvent("fail", `Server failure simulated — all NSR services stopped`);
  await server.save();
  res.json(toStatusPayload(server));
});

// POST /api/servers/:serverName/health - simulate a monitoring/health change
// (independent of server_status/services — mirrors DPA's real distinction)
router.post("/:serverName/health", async (req, res) => {
  const { health_status } = req.body;
  if (!["healthy", "unhealthy", "not_reporting"].includes(health_status)) {
    return res.status(400).json({ error: "health_status must be healthy, unhealthy, or not_reporting" });
  }
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });

  server.health_status = health_status;
  server.pushEvent("health", `Health status simulated as "${health_status}"`);
  await server.save();
  res.json(server);
});

// PATCH /api/servers/:serverName/storage - set storage utilization
router.patch("/:serverName/storage", async (req, res) => {
  const { storage_used_percent } = req.body;
  const pct = Number(storage_used_percent);
  if (Number.isNaN(pct) || pct < 0 || pct > 100) {
    return res.status(400).json({ error: "storage_used_percent must be a number between 0 and 100" });
  }
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });

  server.storage_used_percent = pct;
  server.pushEvent("storage", `Storage utilization set to ${pct}%`);
  await server.save();
  res.json(server);
});

// GET /api/servers/:serverName/nsr-status - current NSR status
// This is the endpoint the restart_nsr_windows / restart_nsr_aix mock blocks poll
router.get("/:serverName/nsr-status", async (req, res) => {
  const server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });
  res.json(toStatusPayload(server));
});

// POST /api/servers/:serverName/nsr-restart - restart NSR services
// This is the endpoint the restart agent's tools call to bring services back up.
// Mirrors the SOP's stop -> validate -> start -> validate sequence by passing
// through a "restarting" state (visible on the dashboard/event log) before
// landing on "running", instead of flipping status instantly.
router.post("/:serverName/nsr-restart", async (req, res) => {
  let server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });

  // Phase 1: mark services as restarting (visible immediately to anyone polling)
  server.services.forEach((s) => (s.status = "restarting"));
  server.pushEvent("restart", `NSR restart initiated by agent — stopping services`);
  await server.save();

  // Simulate the real-world time a stop/start cycle takes
  await delay(2500);

  // Phase 2: reload in case anything changed during the delay, then bring services up
  server = await Server.findOne({ name: req.params.serverName });
  if (!server) return res.status(404).json({ error: "Server not found" });

  server.server_status = "up";
  server.services.forEach((s) => (s.status = "running"));
  server.pushEvent("restart", `NSR services restarted by agent — all services running`);
  await server.save();

  res.json(toStatusPayload(server));
});

module.exports = router;
