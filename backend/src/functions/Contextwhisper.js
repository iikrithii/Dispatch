const { app } = require("@azure/functions");
const { generateContextWhisper } = require("../services/openaiService");
const { buildMeetingContextText } = require("../services/liveInsightContext");

app.http("contextWhisper", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "context-whisper",
  handler: async (request, context) => {
    context.log("context-whisper triggered");

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
      result = await generateContextWhisper({
        transcript: transcript.trim(),
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
    console.log("ContextWhisper result:", result);
    return {
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify(result),
    };
  },
});
