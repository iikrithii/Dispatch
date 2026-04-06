const { app } = require("@azure/functions");
const { detectContextDrift } = require("../services/openaiService");

const DEMO_AGENDA = `
1. Review total corpus and confirm 70-20-10 allocation split
2. Lock delivery dates for the investor portfolio deck (due April 20th)
3. Confirm Infosys rebalancing plan and execution date
4. Decide on Edelweiss structured product and REIT allocation (deadline April 12th)
5. Assign SMID stock research owner and timeline
6. Schedule CA call for advance tax discussion
`;

const DEMO_CONTEXT = `
Meeting: Q2 Investment Planning — Action & Delivery Review
Participants: Sanjeev, Robin, Akshay, Krithi
Duration: 42 minutes
All agenda items are important. The Edelweiss deadline (April 12th) is the most time-sensitive.
The investor deck deadline (April 20th) is fixed and non-negotiable.
`;

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

    const { transcript } = body;
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
        agenda: DEMO_AGENDA,
        context: DEMO_CONTEXT,
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