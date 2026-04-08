const { app } = require("@azure/functions");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");
const { watchLiveTranscript } = require("../services/liveSessionService");
const wsManager = require("../services/wsManager");
const graphService = require("../services/graphService");
const { buildLiveContext } = require("../services/liveInsightContext");

// Store active sessions: { sessionId: { meetingUrl, botProcess, transcriptPath, lastLineCount, watchers[] } }
const activeSessions = new Map();

app.http("startLiveSession", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "start-live-session",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken, userId } = extractAuth(req);
      const body = await req.json();
      const { meetingUrl, meetingContext, brief, user } = body;

      if (!meetingUrl) {
        return errorResponse("meetingUrl is required");
      }

      // Generate session ID
      const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const botDir = path.join(__dirname, "../../..", "teams-bot");
      const mainPyPath = path.join(botDir, "main.py");
      const transcriptPath = path.join(botDir, "transcript.txt");
      const backendBaseUrl = process.env.BACKEND_BASE_URL || "http://localhost:7071";
      const liveWsPort = process.env.LIVE_WS_PORT || "7072";

      context.log(`[StartLiveSession] Starting new session: ${sessionId}`);
      context.log(`[StartLiveSession] Meeting URL: ${meetingUrl}`);
      context.log(`[StartLiveSession] User: ${userId}`);
      context.log(`[StartLiveSession] Bot directory: ${botDir}`);
      context.log(`[StartLiveSession] Main script: ${mainPyPath}`);
      context.log(`[StartLiveSession] WebSocket port: ${liveWsPort}`);

      // Reset transcript file so a new live session does not replay stale captions.
      fs.writeFileSync(transcriptPath, "", "utf-8");

      // Ensure WebSocket server is available before clients connect.
      wsManager.ensureServer();

      const [profile, eventsResult, tasksResult, inboxResult] = await Promise.all([
        graphService.getMyProfile(accessToken).catch(() => null),
        graphService.getTodayEvents(accessToken).catch(() => ({ value: [] })),
        graphService.getDispatchTasks(accessToken).catch(() => ({ value: [] })),
        graphService.getRecentInboxMessages(accessToken, 8).catch(() => ({ value: [] })),
      ]);

      const liveContext = buildLiveContext({
        currentMeeting: meetingContext || { subject: "Live meeting", joinUrl: meetingUrl },
        brief,
        profile,
        calendarEvents: eventsResult?.value || [],
        tasks: tasksResult?.value || [],
        inboxMessages: inboxResult?.value || [],
        user,
      });

      // Spawn Python bot in background
      // Use 'python' or 'python3' and provide full path, working directory, and environment
      const botProcess = spawn("python", [mainPyPath, meetingUrl], {
        cwd: botDir, // Set working directory to teams-bot folder
        detached: true,
        stdio: ["ignore", "pipe", "pipe"], // Capture stdout/stderr for logging
        shell: process.platform === "win32", // Use shell on Windows
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1", // Unbuffered output
          BACKEND_BASE_URL: "", // Live-session API fanout is handled by the watcher service.
        },
      });

      // Log bot output
      if (botProcess.stdout) {
        botProcess.stdout.on("data", (data) => {
          context.log(`[Bot stdout] ${data.toString()}`);
        });
      }

      if (botProcess.stderr) {
        botProcess.stderr.on("data", (data) => {
          context.log(`[Bot stderr] ${data.toString()}`);
        });
      }

      botProcess.on("error", (err) => {
        context.error(`[Bot error] ${err.message}`);
        context.error(`[Bot error] Stack: ${err.stack}`);
        activeSessions.delete(sessionId);
      });

      botProcess.on("exit", (code, signal) => {
        context.log(`[Bot exit] Process exited with code ${code}, signal ${signal}`);
      });

      // Allow parent process to exit without waiting for bot
      botProcess.unref();

      // Store session info
      activeSessions.set(sessionId, {
        meetingUrl,
        botProcess,
        transcriptPath,
        userId,
        startTime: new Date().toISOString(),
        batches: [],
        watcher: null,
        liveContext,
        latestInsights: {},
      });

      const watcher = watchLiveTranscript(transcriptPath, sessionId, {
        batchSize: 10,
        focusRecoveryBatchSize: 5,
        backendUrl: backendBaseUrl,
        liveContext,
        userName: liveContext?.user?.name || "You",
        onBatch: (batchData) => {
          const session = activeSessions.get(sessionId);
          if (!session) return;
          session.batches.push(batchData);
          session.latestBatch = batchData;
          session.latestInsights = {
            ...session.latestInsights,
            ...batchData.apis,
          };
          if (session.batches.length > 25) {
            session.batches = session.batches.slice(-25);
          }
          context.log(`[StartLiveSession] Batch ${batchData.batchNumber} ready for ${sessionId}`);
        },
        onInsight: (insightType, insightData) => {
          const session = activeSessions.get(sessionId);
          if (!session) return;
          session.latestInsights = {
            ...session.latestInsights,
            [insightType]: insightData,
          };
        },
        onError: (err) => {
          context.error(`[StartLiveSession] Watcher error for ${sessionId}:`, err.message);
        },
      });

      const session = activeSessions.get(sessionId);
      if (session) {
        session.watcher = watcher;
      }

      context.log(`[StartLiveSession] Bot process spawned with PID: ${botProcess.pid}`);
      context.log(`[StartLiveSession] Session created: ${sessionId}`);
      context.log(`[StartLiveSession] Bot running independently...`);

      return jsonResponse({
        success: true,
        sessionId,
        wsUrl: `ws://localhost:${liveWsPort}/live-session?sessionId=${sessionId}`,
        message: "Live session started. Connect to WebSocket to receive real-time updates.",
      });
    } catch (err) {
      context.error("[StartLiveSession] Error:", err.stack || err.message);
      return errorResponse(err.message);
    }
  },
});

// Export for use in related live-session handlers.
module.exports = { activeSessions };
