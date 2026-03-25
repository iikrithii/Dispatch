// functions/getProjectDetails.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP Trigger: GET /api/project-details
// Query params: threadId, projectName, nextMeetingId (all optional but at least one needed)
//
// Returns:
//   meetings[]      — past meeting records from Cosmos matching this project
//   pendingTasks[]  — items from approval queue linked to matching meetings
//   attendees[]     — unique people across all matching meetings
//   emailThreads[]  — the linked email thread(s)
// ─────────────────────────────────────────────────────────────────────────────

const { app }          = require("@azure/functions");
const cosmosService    = require("../services/cosmosService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

const STOP_WORDS = new Set([
  "with","from","this","that","have","will","been","your","meeting","call",
  "sync","review","weekly","update","prep","follow","about","just","also",
]);

function tokenize(text = "") {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

app.http("getProjectDetails", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "project-details",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { userId } = extractAuth(req);

      const threadId     = req.query.get("threadId")     || "";
      const projectName  = req.query.get("projectName")  || "";
      const nextMeetingId = req.query.get("nextMeetingId") || "";

      if (!threadId && !projectName) {
        return errorResponse("threadId or projectName is required", 400);
      }

      context.log(`[ProjectDetails] project="${projectName}" threadId="${threadId}"`);

      // ── 1. Get matching meeting records from Cosmos ──
      // Use project name as keyword signal; attendees empty (we don't know them yet)
      const keywords    = tokenize(projectName);
      const meetings    = await cosmosService.getPreviousMeetings(userId, [], keywords, 5);

      // ── 2. Get all pending items from approval queue ──
      const allPending  = await cosmosService.getPendingItems(userId);

      // Filter pending items that belong to meetings we found
      const meetingIds  = new Set(meetings.map((m) => m.meetingId || m.id));
      const pendingTasks = allPending
        .filter((batch) => meetingIds.has(batch.meetingId))
        .flatMap((batch) => (batch.items || []).filter((item) => item.status === "pending"))
        .slice(0, 20);

      // ── 3. Build unique attendees from meeting records ──
      const attendeeMap = new Map();
      for (const m of meetings) {
        for (const a of (m.attendees || [])) {
          // attendees stored as "Name <email>" or just email
          const match   = typeof a === "string" ? a.match(/^(.+?)\s*<(.+?)>$/) : null;
          const name    = match ? match[1].trim() : (typeof a === "string" ? a : a.name || a.email || "");
          const email   = match ? match[2].trim() : (typeof a === "object" ? a.email : a);
          const key     = email || name;
          if (!key) continue;

          if (!attendeeMap.has(key)) {
            attendeeMap.set(key, { name, email, taskCount: 0 });
          }
          // Count tasks assigned to this person
          for (const item of pendingTasks) {
            if ((item.data?.owner || "").toLowerCase().includes((name || "").toLowerCase().split(" ")[0])) {
              attendeeMap.get(key).taskCount++;
            }
          }
        }
      }

      // ── 4. Email threads — just the linked thread from the project summary ──
      // We don't re-fetch emails here; just return the threadId as metadata
      const emailThreads = threadId
        ? [{ conversationId: threadId, subject: projectName, latestDate: null, messageCount: null }]
        : [];

      // ── 5. Shape meeting records for UI ──
      const shapedMeetings = meetings.map((m) => ({
        id:          m.id,
        subject:     m.subject || "(Untitled meeting)",
        date:        m.startTime || m.savedAt || null,
        summary:     m.summary  || null,
        actionItems: (m.actionItems || []).map((a) => ({
          owner:  a.owner || "",
          task:   a.task  || "",
          status: a.status || "pending",
        })),
      }));

      return jsonResponse({
        success:    true,
        meetings:   shapedMeetings,
        pendingTasks,
        attendees:  Array.from(attendeeMap.values()),
        emailThreads,
      });
    } catch (err) {
      context.error("[ProjectDetails] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});