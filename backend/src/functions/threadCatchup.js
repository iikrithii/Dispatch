// functions/threadCatchup.js
// HTTP Trigger: GET /api/thread-catchup?conversationId=XXX
// Returns a 3-line catch-up + the cleaned message array for Gmail-style display.

const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const openaiService = require("../services/openaiService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

/**
 * Strip HTML tags and collapse whitespace into readable plain text.
 * Keeps structure (newlines) but removes all markup.
 */
function htmlToPlainText(html = "") {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

app.http("threadCatchup", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "thread-catchup",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken, userEmail } = extractAuth(req);

      let conversationId;
      if (req.method === "GET") {
        conversationId = req.query.get("conversationId");
      } else {
        const body = await req.json();
        conversationId = body.conversationId;
      }

      if (!conversationId) {
        return errorResponse("conversationId is required", 400);
      }

      context.log(`[ThreadCatchup] Fetching thread: ${conversationId}`);

      // Fetch the full thread (includes body.content)
      const threadResult = await graphService.getEmailThread(accessToken, conversationId);
      const rawMessages = threadResult.value || [];

      if (rawMessages.length === 0) {
        return errorResponse("Email thread not found or empty", 404);
      }

      // ── Clean messages for frontend display ──
      // Sort oldest → newest (Graph returns newest first)
      const sorted = [...rawMessages].sort((a, b) => {
        if (!a.receivedDateTime) return 1;
        if (!b.receivedDateTime) return -1;
        return new Date(a.receivedDateTime) - new Date(b.receivedDateTime);
      });

      const cleanMessages = sorted.map((m) => ({
        id: m.id || null,
        from: {
          name: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "Unknown",
          address: m.from?.emailAddress?.address || "",
        },
        to: (m.toRecipients || []).map((r) => ({
          name: r.emailAddress?.name || r.emailAddress?.address || "",
          address: r.emailAddress?.address || "",
        })),
        receivedDateTime: m.receivedDateTime || null,
        subject: m.subject || "",
        // Prefer full body stripped of HTML; fall back to bodyPreview
        bodyText: m.body?.content
          ? htmlToPlainText(m.body.content).slice(0, 1500)
          : (m.bodyPreview || ""),
        bodyPreview: m.bodyPreview || "",
      }));

      // ── Generate AI catch-up ──
      const catchup = await openaiService.generateThreadCatchup(rawMessages, userEmail);

      // Unique participant addresses (for meta)
      const participants = [
        ...new Set(rawMessages.map((m) => m.from?.emailAddress?.address).filter(Boolean)),
      ];

      return jsonResponse({
        success: true,
        catchup,
        // NEW: cleaned messages for Gmail-style rendering in the frontend
        messages: cleanMessages,
        meta: {
          messageCount: rawMessages.length,
          participants,
          dateRange: {
            first: sorted[0]?.receivedDateTime || null,
            last: sorted[sorted.length - 1]?.receivedDateTime || null,
          },
        },
      });
    } catch (err) {
      context.error("[ThreadCatchup] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});