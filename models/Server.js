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

const EventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["fail", "restart", "created", "service_added", "service_removed", "health", "storage"],
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
    server_status: {
      type: String,
      enum: ["up", "down"],
      default: "up",
    },
    // Independent from server_status/services: mirrors DPA's real distinction
    // between "backup jobs failing" and "monitoring health" — a server can be
    // up with all services running and still be flagged unhealthy or
    // not-reporting, so this needs to be simulatable on its own.
    health_status: {
      type: String,
      enum: ["healthy", "unhealthy", "not_reporting"],
      default: "healthy",
    },
    // Real field (not derived/faked) so the Storage Capacity widgets reflect
    // something you actually set, and can be pushed toward a threshold on demand.
    storage_used_percent: {
      type: Number,
      min: 0,
      max: 100,
      default: 20,
    },
    services: { type: [ServiceSchema], default: [] },
    events: { type: [EventSchema], default: [] },
  },
  { timestamps: true }
);

// Keep only the most recent 25 events per server so documents don't grow unbounded
ServerSchema.methods.pushEvent = function (type, message) {
  this.events.unshift({ type, message, at: new Date() });
  if (this.events.length > 25) this.events = this.events.slice(0, 25);
};

module.exports = mongoose.model("Server", ServerSchema);
