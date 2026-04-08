// services/wsManager.js
// Manages a dedicated WebSocket server for live session updates.

const EventEmitter = require("events");
const { WebSocketServer } = require("ws");

class WSManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.server = null;
    this.port = parseInt(process.env.LIVE_WS_PORT || "7072", 10);
  }

  ensureServer() {
    if (this.server) {
      return this.server;
    }

    this.server = new WebSocketServer({
      port: this.port,
      path: "/live-session",
    });

    this.server.on("listening", () => {
      console.log(`[WSManager] WebSocket server listening on ws://localhost:${this.port}/live-session`);
    });

    this.server.on("connection", (ws, req) => {
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const sessionId = requestUrl.searchParams.get("sessionId");

      if (!sessionId) {
        ws.close(1008, "sessionId is required");
        return;
      }

      this.addClient(sessionId, ws);
      this.sendToClient(ws, {
        type: "connected",
        sessionId,
        timestamp: new Date().toISOString(),
      });

      this.emit("client-connected", { sessionId, ws });
    });

    this.server.on("error", (err) => {
      console.error("[WSManager] Server error:", err.message);
    });

    return this.server;
  }

  addClient(sessionId, ws) {
    if (!this.connections.has(sessionId)) {
      this.connections.set(sessionId, new Set());
    }
    this.connections.get(sessionId).add(ws);

    ws.on("close", () => {
      this.removeClient(sessionId, ws);
    });

    ws.on("error", (err) => {
      console.error(`[WSManager] WS error for session ${sessionId}:`, err.message);
      this.removeClient(sessionId, ws);
    });
  }

  removeClient(sessionId, ws) {
    const clients = this.connections.get(sessionId);
    if (!clients) return;

    clients.delete(ws);
    if (clients.size === 0) {
      this.connections.delete(sessionId);
    }
  }

  sendToClient(ws, payload) {
    if (ws.readyState !== 1) return;

    ws.send(JSON.stringify(payload), (err) => {
      if (err) {
        console.error("[WSManager] Send error:", err.message);
      }
    });
  }

  broadcastBatch(sessionId, batchData) {
    this.broadcast(sessionId, {
      type: "batch",
      data: batchData,
    });
  }

  broadcastInsight(sessionId, insightType, data) {
    this.broadcast(sessionId, {
      type: "insight",
      insightType,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastStatus(sessionId, status, message, extra = {}) {
    this.broadcast(sessionId, {
      type: "status",
      sessionId,
      status,
      message,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }

  broadcast(sessionId, payload) {
    const clients = this.connections.get(sessionId);
    if (!clients || clients.size === 0) {
      return;
    }

    for (const ws of clients) {
      this.sendToClient(ws, payload);
    }
  }

  getClientCount(sessionId) {
    return this.connections.get(sessionId)?.size || 0;
  }

  closeSession(sessionId) {
    const clients = this.connections.get(sessionId);
    if (!clients) return;

    for (const ws of clients) {
      try {
        ws.close(1000, "Session ended");
      } catch (err) {
        console.error("[WSManager] Close error:", err.message);
      }
    }

    this.connections.delete(sessionId);
  }
}

module.exports = new WSManager();
