// functions/meetingNotes.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP Trigger: POST /api/meeting-notes
// ─────────────────────────────────────────────────────────────────────────────

const { app } = require("@azure/functions");
const openaiService = require("../services/openaiService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

app.http("meetingNotes", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "meeting-notes",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      extractAuth(req); // validates token

      const body = await req.json();
      const {
        eventId,
        meetingTitle,
        language = "English",
        agenda = [],
        followUpItems = [],
        openPoints = [],
        keyContext = "",
        currentStatus = "",
        questions = [],
        answers = {},
        additionalNotes = "",
      } = body;

      if (!meetingTitle && !eventId) {
        return errorResponse("meetingTitle or eventId is required", 400);
      }

      // ───────────────────────────────────────────────────────────────────────
      // FIX: Normalize Agenda/Points
      // If items are rich objects (from the new Jira-aware brief), extract the text.
      // ───────────────────────────────────────────────────────────────────────
      const normalizeToText = (arr) => 
        (arr || []).map(item => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && item.text) return item.text;
          return "";
        }).filter(Boolean);

      const cleanAgenda     = normalizeToText(agenda);
      const cleanOpenPoints = normalizeToText(openPoints);

      // Validate: at least something was answered
      const hasContent =
        Object.values(answers).some((a) => (a || "").trim().length > 0) ||
        (additionalNotes || "").trim().length > 0;

      if (!hasContent) {
        return errorResponse(
          "No answers or additional notes provided. Please answer at least one question.",
          400
        );
      }

      context.log(
        `[MeetingNotes] title="${meetingTitle}" | lang=${language} | ` +
          `answeredQ=${Object.keys(answers).length} | hasAdditional=${!!additionalNotes}`
      );

      // Send the cleaned (string-based) agenda to OpenAI
      const result = await openaiService.generateSpeakingPoints({
        meetingTitle,
        language,
        agenda: cleanAgenda,
        followUpItems,
        openPoints: cleanOpenPoints,
        keyContext,
        currentStatus,
        questions,
        answers,
        additionalNotes,
      });

      return jsonResponse({
        success: true,
        ...result,
      });
    } catch (err) {
      context.error("[MeetingNotes] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});