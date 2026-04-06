// functions/getEvents.js
// HTTP Trigger: GET /api/events
// Returns today + upcoming 7 days of calendar events.

const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

app.http("getEvents", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "events",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken } = extractAuth(req);
      const result = await graphService.getTodayEvents(accessToken);

      const events = (result.value || []).map((e) => ({
        id: e.id,
        subject: e.subject,
        start: e.start?.dateTime,
        end: e.end?.dateTime,
        attendees: e.attendees?.map((a) => ({
          name: a.emailAddress?.name,
          email: a.emailAddress?.address,
        })),
        bodyPreview: e.bodyPreview,
        joinUrl: e.onlineMeeting?.joinUrl || e.joinWebUrl,
        isOnline: !!e.onlineMeeting,
      }));

      return jsonResponse({ success: true, events });
    } catch (err) {
      context.error("[GetEvents] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});
