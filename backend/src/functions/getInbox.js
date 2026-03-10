// functions/getInbox.js
// HTTP Trigger: GET /api/inbox
// Returns inbox messages GROUPED by conversationId — one entry per thread, Gmail-style.

const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

app.http("getInbox", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "inbox",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken } = extractAuth(req);
      // Fetch more than the display limit so grouping produces enough threads
      const limit = parseInt(req.query.get("limit") || "20");
      const fetchLimit = Math.min(limit * 3, 60); // fetch 3× to have enough after grouping

      const result = await graphService.getRecentInboxMessages(accessToken, fetchLimit);
      const messages = result.value || [];

      // ── Group by conversationId ──
      // Map: conversationId → thread object
      const threadMap = new Map();

      for (const m of messages) {
        const key = m.conversationId || m.id;

        if (!threadMap.has(key)) {
          threadMap.set(key, {
            conversationId: key,
            subject: m.subject || "(No subject)",
            latestFrom: m.from?.emailAddress || null,
            latestDate: m.receivedDateTime || null,
            isRead: m.isRead ?? true,
            messageCount: 0,
            participantNames: new Set(),
            bodyPreview: m.bodyPreview || "",
          });
        }

        const thread = threadMap.get(key);
        thread.messageCount++;

        // Track unique participant names
        const name = m.from?.emailAddress?.name || m.from?.emailAddress?.address;
        if (name) thread.participantNames.add(name);

        // Keep the latest message's metadata at the top level
        if (
          !thread.latestDate ||
          (m.receivedDateTime && m.receivedDateTime > thread.latestDate)
        ) {
          thread.latestFrom = m.from?.emailAddress || null;
          thread.latestDate = m.receivedDateTime || null;
          thread.subject = m.subject || thread.subject;
          thread.bodyPreview = m.bodyPreview || thread.bodyPreview;
          // Thread is unread if any message is unread
          if (!m.isRead) thread.isRead = false;
        }
      }

      // Serialise and sort newest-first
      const threads = Array.from(threadMap.values())
        .map((t) => ({
          ...t,
          participantNames: Array.from(t.participantNames),
        }))
        .sort((a, b) => {
          if (!a.latestDate) return 1;
          if (!b.latestDate) return -1;
          return new Date(b.latestDate) - new Date(a.latestDate);
        })
        .slice(0, limit);

      return jsonResponse({
        success: true,
        messages: threads, // field kept as "messages" to avoid breaking existing api.js call
      });
    } catch (err) {
      context.error("[GetInbox] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});