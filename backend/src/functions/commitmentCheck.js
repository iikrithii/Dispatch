const { app } = require("@azure/functions");
const { checkCommitmentsWithAI } = require("../services/openaiService");
const { buildCommitmentContextText } = require("../services/liveInsightContext");

app.http("commitmentCheck", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "commitment-check",
  handler: async (request, context) => {
    context.log("commitment-check triggered");

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return { status: 204, headers: corsHeaders };
    }

    // ── Parse body ────────────────────────────────────────────────────────────
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

    if (!transcript || typeof transcript !== "string" || transcript.trim().length < 5) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "transcript field is required (min 5 characters)" }),
      };
    }

    const fullContext = buildCommitmentContextText(liveContext);

    // ── Call AI ───────────────────────────────────────────────────────────────
    let result;
    try {
      result = await checkCommitmentsWithAI({
        transcript: transcript.trim(),
        context: fullContext,
      });
    } catch (err) {
      context.log("AI error:", err.message);
      return {
        status: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: "AI service error: " + err.message }),
      };
    }
    console.log("CommitmentCheck result:", result);
    return {
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify(result),
    };
  },
});
