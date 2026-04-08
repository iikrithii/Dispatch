const { app } = require("@azure/functions");
const { detectContextDrift } = require("../services/openaiService");
const { buildAgendaText, buildMeetingContextText } = require("../services/liveInsightContext");

app.http("driftDetection", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "drift-detection",
  handler: async (request, context) => {
    context.log("drift-detection triggered");

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return { status: 204, headers: corsHeaders };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Invalid JSON body" }),
      };
    }

    const { transcript, liveContext } = body;
    if (!transcript || transcript.trim().length < 5) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "transcript field is required" }),
      };
    }

    let result;
    try {
      result = await detectContextDrift({
        transcript: transcript.trim(),
        agenda: buildAgendaText(liveContext),
        context: buildMeetingContextText(liveContext),
      });
    } catch (err) {
      context.log("AI error:", err.message);
      return {
        status: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: "AI service error: " + err.message }),
      };
    }
    console.log("DriftDetection result:", result);
    return {
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify(result),
    };
  },
});
