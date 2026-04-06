// functions/getUnresolvedIssues.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP Trigger: GET /api/unresolved-issues?limit=5
//
// Pulls last N meeting records from Cosmos, runs AI analysis to detect
// topics that appeared in 2+ meetings without a resolved action item.
//
// Returns:
//   issues: [
//     {
//       issue:            string,    — what the unresolved topic is
//       meetingCount:     number,    — how many meetings it appeared in
//       riskLevel:        "high"|"medium"|"low",
//       affectedProjects: string[],  — project names it maps to
//       lastSeen:         string,    — ISO date of most recent meeting
//       suggestion:       string,    — AI's recommended next action
//     }
//   ]
// ─────────────────────────────────────────────────────────────────────────────

const { app }       = require("@azure/functions");
const cosmosService = require("../services/cosmosService");
const openaiService = require("../services/openaiService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

app.http("getUnresolvedIssues", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "unresolved-issues",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { userId } = extractAuth(req);
      const limit      = Math.min(parseInt(req.query.get("limit") || "5"), 20);

      context.log(`[UnresolvedIssues] userId=${userId} limit=${limit}`);

      // ── 1. Pull last N meeting records from Cosmos ──
      // getPreviousMeetings with empty signals returns all recent records
      const meetings = await cosmosService.getRecentMeetingRecords(userId, limit);

      if (!meetings || meetings.length === 0) {
        return jsonResponse({ success: true, issues: [] });
      }

      // ── 2. Filter to rich records only (have summary / transcript / actionItems) ──
      const richMeetings = meetings.filter(
        (m) => m.summary || (m.actionItems && m.actionItems.length > 0) || m.transcript
      );

      if (richMeetings.length < 2) {
        // Need at least 2 meetings to detect recurrence
        return jsonResponse({ success: true, issues: [] });
      }

      context.log(`[UnresolvedIssues] Analysing ${richMeetings.length} rich meeting records`);

      // ── 3. AI analysis ──
      const result = await openaiService.detectUnresolvedIssues(richMeetings);
      

      return jsonResponse({
        success: true,
        issues:  result.issues || [],
        meta: {
          meetingsAnalyzed: richMeetings.length,
        },
      });
    } catch (err) {
      context.error("[UnresolvedIssues] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});