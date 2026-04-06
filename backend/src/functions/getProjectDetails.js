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

function parseAttendee(attendee) {
  if (!attendee) return null;

  if (typeof attendee === "string") {
    const match = attendee.match(/^(.+?)\s*<(.+?)>$/);
    if (match) {
      return {
        name: match[1].trim(),
        email: match[2].trim().toLowerCase(),
      };
    }

    const text = attendee.trim();
    return {
      name: text.includes("@") ? "" : text,
      email: text.includes("@") ? text.toLowerCase() : "",
    };
  }

  if (attendee.emailAddress?.address) {
    return {
      name: attendee.emailAddress.name || "",
      email: String(attendee.emailAddress.address || "").trim().toLowerCase(),
    };
  }

  if (attendee.address || attendee.email) {
    return {
      name: attendee.name || "",
      email: String(attendee.address || attendee.email || "").trim().toLowerCase(),
    };
  }

  return null;
}

function deriveDisplayName(name = "", email = "") {
  if (name) return name;
  if (!email) return "";
  return email
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function ownerMatchesPerson(owner = "", person = {}) {
  const ownerText = String(owner || "").trim().toLowerCase();
  if (!ownerText) return false;

  const name = String(person.name || "").trim().toLowerCase();
  const email = String(person.email || "").trim().toLowerCase();
  const firstName = name.split(/\s+/)[0] || "";
  const localPart = email.split("@")[0] || "";

  return [name, firstName, email, localPart].some((candidate) => candidate && ownerText.includes(candidate));
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
      const meetingLimit = Math.min(
        Math.max(parseInt(req.query.get("meetingLimit") || "5", 10) || 5, 1),
        20
      );

      if (!threadId && !projectName) {
        return errorResponse("threadId or projectName is required", 400);
      }

      context.log(`[ProjectDetails] project="${projectName}" threadId="${threadId}"`);

      // ── 1. Get matching meeting records from Cosmos ──
      // Use project name as keyword signal; attendees empty (we don't know them yet)
      const keywords    = tokenize(projectName);
      const meetings    = await cosmosService.getPreviousMeetings(userId, [], keywords, meetingLimit);

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
          const parsed = parseAttendee(a);
          const name = deriveDisplayName(parsed?.name || "", parsed?.email || "");
          const email = parsed?.email || "";
          const key = email || name.toLowerCase();
          if (!key) continue;

          if (!attendeeMap.has(key)) {
            attendeeMap.set(key, { name, email, taskCount: 0 });
          }
          // Count tasks assigned to this person
          for (const item of pendingTasks) {
            if (ownerMatchesPerson(item.data?.owner || item.data?.person || "", { name, email })) {
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
        attendees:   (m.attendees || [])
          .map((attendee) => parseAttendee(attendee))
          .filter(Boolean)
          .map((attendee) => ({
            name: deriveDisplayName(attendee.name || "", attendee.email || ""),
            email: attendee.email || "",
          })),
        actionItems: (m.actionItems || []).map((a) => ({
          owner:  a.owner || "",
          task:   a.task  || "",
          deadline: a.deadline || null,
          urgency: a.urgency || null,
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
