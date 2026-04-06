const { app } = require("@azure/functions");
const { generateContextWhisper } = require("../services/openaiService");

// ── Hardcoded demo context ────────────────────────────────────────────────────
const DEMO_CONTEXT = `
Meeting: Q2 Investment Planning — Action & Delivery Review
Participants: Sanjeev, Robin, Akshay, Krithi

PAST DECISIONS AND AGREEMENTS:
- Agreed in last meeting (Mar 20) to cap Infosys allocation at 15% of equity book.
- Agreed in Mar 20 meeting that SMID allocation would be increased to 15% over two quarters.
- Robin committed on Apr 1 email to deliver Q1 reconciliation by April 8th.
- Sanjeev approved 60-30-10 split (equity-debt-alternatives) in the Feb planning session.
- Team agreed that NO single stock should exceed 15% of the equity portfolio.
- Krithi committed in the Mar 20 meeting to finalise both investee term sheets before Apr 10.
- Akshay committed to fixing the 4 portfolio tracker bugs before the next investor demo (Apr 15).

RECENT EMAIL CONTEXT:
- Apr 2 email from Robin to Sanjeev: "Confirming the Edelweiss subscription window closes April 12th — no extensions possible."
- Apr 3 email from Krithi: "Spoke to Edelweiss — minimum investment is 50 lakhs for the structured product."
- Apr 4 email from Akshay: "Portfolio tracker bugs — 2 of 4 fixed so far, 2 still open."
- Mar 28 email chain agreed that startup (EdTech) investment decision pushed to Q3.

PENDING ACTION ITEMS FROM LAST MEETING:
- Sanjeev: Review vendor contracts (overdue from Mar 20)
- Robin: Complete Q1 reconciliation (due Apr 8 — today is Apr 5)
- Krithi: Finalise 2 investee term sheets (due Apr 10)
- Akshay: Fix 4 bugs in portfolio tracker (due Apr 15)
`;

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
      result = await generateContextWhisper({
        transcript: transcript.trim(),
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
    console.log("ContextWhisper result:", result);
    return {
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify(result),
    };
  },
});