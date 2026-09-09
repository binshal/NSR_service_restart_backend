const mongoose = require("mongoose");

const ServiceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["running", "stopped", "restarting"],
      default: "running",
    },
  },
  { timestamps: true }
);

const FailureReportSchema = new mongoose.Schema(
  {
    code: { type: String, default: null },
    category: { type: String, default: null },
    title: { type: String, default: null },
    description: { type: String, default: null },
    restart_required: { type: Boolean, default: false },
    target_services: { type: [String], default: [] },
    recommended_action: { type: String, default: null },
    detected_at: { type: Date, default: null },
  },
  { _id: false }
);

const EventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "fail",
        "restart",
        "created",
        "service_added",
        "service_removed",
        "health",
        "storage",
        "failure_report",
      ],
      required: true,
    },
    message: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ServerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    os_type: { type: String, enum: ["Windows", "AIX"], required: true },
    // This is the host state. A NetWorker service failure does NOT make the
    // host down; production remediation is normally service/daemon scoped.
    server_status: {
      type: String,
      enum: ["up", "down"],
      default: "up",
    },
    health_status: {
      type: String,
      enum: ["healthy", "unhealthy", "not_reporting"],
      default: "healthy",
    },
    storage_used_percent: {
      type: Number,
      min: 0,
      max: 100,
      default: 20,
    },
    services: { type: [ServiceSchema], default: [] },
    // The DPA-style failure report is deliberately stored separately from
    // service status. This lets the agent consume the diagnosed root cause
    // and the exact NetWorker services that are candidates for restart.
    active_failure_report: { type: FailureReportSchema, default: null },
    events: { type: [EventSchema], default: [] },
  },
  { timestamps: true }
);

ServerSchema.methods.pushEvent = function (type, message) {
  this.events.unshift({ type, message, at: new Date() });
  if (this.events.length > 25) this.events = this.events.slice(0, 25);
};

module.exports = mongoose.model("Server", ServerSchema);
