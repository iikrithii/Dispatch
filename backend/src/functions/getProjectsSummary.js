// functions/getProjectsSummary.js
// HTTP Trigger: POST /api/projects-summary
// Body: { threads: [ { conversationId, subject, participantNames, latestDate, bodyPreview } ] }
// Returns: { projects: [ { name, summary, priority, nextMeeting, keyTask, threadId } ] }
//
// Called automatically after inbox loads to surface active project clusters.

const { app } = require("@azure/functions");
const openaiService = require("../services/openaiService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

app.http("getProjectsSummary", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "projects-summary",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      extractAuth(req); // validates token — we don't need userId here

      const body = await req.json();
      const threads = body.threads || [];
      const events  = body.events  || [];

      if (threads.length === 0) {
        return jsonResponse({ success: true, projects: [] });
      }

      context.log(`[ProjectsSummary] Analysing ${threads.length} threads`);

      const result = await openaiService.generateProjectsSummary(threads, events);

      return jsonResponse({
        success: true,
        projects: result.projects || [],
      });
    } catch (err) {
      context.error("[ProjectsSummary] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});