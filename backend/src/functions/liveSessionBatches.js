const { app } = require("@azure/functions");
const { jsonResponse, errorResponse } = require("../utils/auth");
const { activeSessions } = require("./startLiveSession");
const wsManager = require("../services/wsManager");

app.http("getLiveSessionBatches", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "live-session/{sessionId}/batches",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const sessionId = req.params.sessionId;
      const sinceBatch = parseInt(req.query.get("sinceBatch") || "0", 10);

      if (!sessionId) {
        return errorResponse("sessionId is required");
      }

      const session = activeSessions.get(sessionId);
      if (!session) {
        return errorResponse("Session not found", 404);
      }

      const batches = session.batches || [];
      const newBatches = batches.slice(sinceBatch);

      return jsonResponse({
        success: true,
        sessionId,
        batches: newBatches,
        totalBatches: batches.length,
        wsClients: wsManager.getClientCount(sessionId),
        liveContext: session.liveContext || null,
        latestInsights: session.latestInsights || {},
      });
    } catch (err) {
      context.error("[LiveSessionBatches] Error:", err.stack || err.message);
      return errorResponse(err.message);
    }
  },
});

app.http("endLiveSession", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "live-session/{sessionId}/end",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const sessionId = req.params.sessionId;

      if (!sessionId) {
        return errorResponse("sessionId is required");
      }

      const session = activeSessions.get(sessionId);
      if (session?.watcher) {
        session.watcher.stop();
      }

      if (session?.botProcess?.pid) {
        try {
          process.kill(-session.botProcess.pid);
        } catch (err) {
          context.log("[EndLiveSession] Warning: Could not kill process:", err.message);
        }
      }

      wsManager.broadcastStatus(sessionId, "ended", "Live session ended.");
      wsManager.closeSession(sessionId);
      activeSessions.delete(sessionId);

      context.log(`[EndLiveSession] Session ${sessionId} ended`);

      return jsonResponse({
        success: true,
        message: "Session ended",
        sessionId,
      });
    } catch (err) {
      context.error("[EndLiveSession] Error:", err.stack || err.message);
      return errorResponse(err.message);
    }
  },
});
