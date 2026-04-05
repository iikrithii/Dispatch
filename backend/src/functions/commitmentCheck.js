const { app } = require("@azure/functions");
const { checkCommitmentsWithAI } = require("../services/openaiService");

// ── Hardcoded demo transcript ─────────────────────────────────────────────────
const DEMO_TRANSCRIPT = {
  meetingTitle: "Q2 Investment Planning — Action & Delivery Review",
  date: "2026-04-05",
  participants: ["Sanjeev", "Robin", "Akshay", "Krithi"],
  knownCalendarLoad: {
    "2026-04-07": "Tuesday — Sanjeev has 3 back-to-back meetings: Product Sync 10am, Investor Call 1pm, Team Standup 4pm. 5.5 hours blocked.",
    "2026-04-08": "Wednesday — Akshay has Sprint Planning 10am-12pm and a Design Review 2pm-4pm. Robin is free most of the day.",
    "2026-04-09": "Thursday — Sanjeev has an all-day offsite. Krithi has Legal Review 11am and Client Demo 3pm.",
    "2026-04-10": "Friday — Akshay has half day leave from 1pm. Robin has a 9am-11am Finance Sync.",
    "2026-04-14": "Tuesday next week — Full team has Quarterly Business Review 9am-1pm (4 hours blocked).",
    "2026-04-16": "Thursday next week — Sanjeev travelling to Bangalore. Robin has Board Prep call 2pm."
  },
  pendingTasks: [
    "Sanjeev: Review and sign 3 pending vendor contracts (estimated 4 hours of work)",
    "Robin: Complete Q1 expense reconciliation report (in progress, 2 days of work remaining)",
    "Akshay: Fix 4 critical bugs in the portfolio tracker before next investor demo",
    "Krithi: Finalise term sheets for 2 investee companies"
  ]
};

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

    const { transcript } = body;

    if (!transcript || typeof transcript !== "string" || transcript.trim().length < 5) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "transcript field is required (min 5 characters)" }),
      };
    }

    // ── Build context from hardcoded local data ───────────────────────────────
    const calendarContext = Object.entries(DEMO_TRANSCRIPT.knownCalendarLoad)
      .map(([date, desc]) => `${date}: ${desc}`)
      .join("\n");

    const tasksContext = DEMO_TRANSCRIPT.pendingTasks.join("\n");

    const fullContext = `
Meeting: ${DEMO_TRANSCRIPT.meetingTitle}
Participants: ${DEMO_TRANSCRIPT.participants.join(", ")}

Calendar Load for next 7 days:
${calendarContext}

Pending Tasks and existing workload:
${tasksContext}
    `.trim();

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

    return {
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify(result),
    };
  },
});