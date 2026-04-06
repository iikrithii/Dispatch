const { app } = require("@azure/functions");
const { generateFocusRecovery } = require("../services/openaiService");

const DEMO_CONTEXT = `
Meeting: Q2 Investment Planning — Action & Delivery Review
Participants: Sanjeev, Robin, Akshay, Krithi

Background:
- Total corpus: 4.8 crore
- Agreed allocation: 70% equity, 20% debt, 10% alternatives
- Equity book: currently overweight Infosys at 18% (agreed to cap at 12%)
- Alternatives bucket: Edelweiss structured product (9.4% for 18 months) and Embassy REIT
- Edelweiss subscription closes April 12th — hard deadline
- Investor deck due to go out April 20th
- Quarterly Business Review on April 14th — full team blocked 9am-1pm
`;

app.http("focusRecovery", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "focus-recovery",
  handler: async (request, context) => {
    context.log("focus-recovery triggered");

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

    const { transcript, userName } = body;
    if (!transcript || transcript.trim().length < 5) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "transcript field is required" }),
      };
    }

    let result;
    try {
      result = await generateFocusRecovery({
        transcript: transcript.trim(),
        userName: userName || "Sanjeev",
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
    console.log("FocusRecovery result:", result);

    return {
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify(result),
    };
  },
});