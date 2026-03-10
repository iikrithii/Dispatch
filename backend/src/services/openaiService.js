// services/openaiService.js
// Wraps Groq (OpenAI-compatible) API calls.

const OpenAI = require("openai");

let _client = null;

function getClient() {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return _client;
}

async function complete(systemPrompt, userContent, temperature = 0.3) {
  const client = getClient();
  const response = await client.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature,
    max_tokens: 2500,
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0].message.content;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

// ─────────────────────────────────────────────
// PRE-CALL BRIEF
// ─────────────────────────────────────────────

async function generatePreCallBrief({ event, recentEmails, emailThreads = [], pastMeetings }) {
  const systemPrompt = `You are Dispatch, an AI meeting assistant. Generate a tight, useful pre-call brief.

Return valid JSON matching EXACTLY this schema — nothing else, no markdown, no commentary:
{
  "meetingTitle": string,
  "currentStatus": string,
  "followUps": {
    "date": string,
    "subject": string,
    "narrative": string,
    "conversationStory": string,
    "items": [
      {
        "owner": string,
        "task": string,
        "status": "done" | "pending",
        "evidence": string | null,
        "emailId": string | null,
        "emailSubject": string | null
      }
    ],
    "nextMeetingPoints": string[]
  } | null,
  "openPoints": string[],
  "agendaForToday": string[],
  "keyContext": string
}

"meetingTitle": Subject of the upcoming meeting.
"currentStatus": Exactly 2 sentences. Where does the project/work stand right now? Do NOT mention the upcoming meeting.
"followUps": null if no past meeting. Otherwise populate all fields.
  "narrative": 3-5 sentences on what happened IN the meeting.
  "conversationStory": 4-8 sentences reconstructing email back-and-forth AFTER the meeting. Use real names, specific dates, say what was sent/asked/not replied to.
  "items": Every action item. Match owner name to email senders to determine done/pending.
  "nextMeetingPoints": Things planned for the NEXT meeting. Max 4.
"openPoints": Max 3 unresolved blockers not already in followUps.items.
"agendaForToday": Max 4 concrete things to decide/accomplish.
"keyContext": 1-2 sentences of critical background.`;

  const pastMeetingsText =
    !pastMeetings || pastMeetings.length === 0
      ? "NO PAST MEETING RECORD AVAILABLE."
      : pastMeetings.slice(0, 1).map((m) => `
PAST MEETING SUBJECT: ${m.subject}
PAST MEETING DATE: ${m.date || "unknown"}
SUMMARY: ${m.summary || "none"}
TRANSCRIPT (up to 4000 chars):
${m.transcript || "none"}
ACTION ITEMS:
${(m.actionItems || []).length > 0
  ? m.actionItems.map((a) => `  - Owner: ${a.owner} | Task: ${a.task}`).join("\n")
  : "  none recorded"}
PLANNED FOR NEXT MEETING:
${Array.isArray(m.plannedForNextMeeting) && m.plannedForNextMeeting.length > 0
  ? m.plannedForNextMeeting.map((p) => `  - ${p}`).join("\n")
  : "  none recorded"}`).join("\n===\n");

  const emailText =
    (recentEmails || []).length === 0
      ? "NO RELEVANT EMAILS FOUND."
      : recentEmails.slice(0, 25).map((e, i) =>
          `idx:${i + 1} | id:${e.id || "no-id"} | [${e.receivedDateTime?.slice(0, 10)}] From: ${
            e.from?.emailAddress?.name || e.from?.emailAddress?.address || "unknown"
          } | Subject: "${e.subject || "(no subject)"}" | Body: ${(e.bodyClean || e.bodyPreview || "(none)").slice(0, 300)}`
        ).join("\n");

  const threadText =
    (emailThreads || []).length === 0
      ? "NO EMAIL THREADS FOUND."
      : emailThreads.slice(0, 5).map((t, i) =>
          `── THREAD ${i + 1}: "${t.subject}" (${t.messagesCount} message(s)) ──\n${t.conversationLog || "(no conversation log)"}`
        ).join("\n\n");

  const userContent = `UPCOMING MEETING: "${event.subject}"
SCHEDULED FOR: ${event.start?.dateTime || event.start || "unknown"}
ATTENDEES: ${(event.attendees || []).map((a) => a.emailAddress?.name || a.emailAddress?.address).join(", ")}

━━━ PAST MEETING ━━━
${pastMeetingsText}

━━━ EMAIL FLAT LIST (done/pending matching) ━━━
${emailText}

━━━ EMAIL CONVERSATION THREADS (for conversationStory) ━━━
${threadText}

Generate the pre-call brief now.`;

  return complete(systemPrompt, userContent, 0.2);
}

// ─────────────────────────────────────────────
// POST-CALL PROCESSING
// ─────────────────────────────────────────────

async function processPostCall(transcript, meetingInfo) {
  const systemPrompt = `You are Dispatch, an AI post-meeting assistant.
Extract structured information from this meeting transcript.
Always return valid JSON matching exactly this schema:
{
  "summary": string,
  "actionItems": [{ "id": string, "owner": string, "task": string, "deadline": string | null, "urgency": "high" | "medium" | "low" }],
  "softCommitments": [{ "person": string, "commitment": string, "estimatedDeadline": string | null }],
  "followUpEmails": [{ "id": string, "to": string[], "subject": string, "body": string }],
  "suggestedFollowUpMeeting": { "needed": boolean, "suggestedAgenda": string, "suggestedTimeframe": string },
  "keyDecisions": string[]
}`;

  return complete(systemPrompt, `
MEETING: ${meetingInfo.subject}
DATE: ${meetingInfo.date}
ATTENDEES: ${meetingInfo.attendees?.join(", ")}
TRANSCRIPT:
${transcript.slice(0, 8000)}
Extract all action items, commitments, and draft follow-up emails now.`);
}

// ─────────────────────────────────────────────
// THREAD CATCH-UP
// ─────────────────────────────────────────────

async function generateThreadCatchup(messages, userEmail) {
  const systemPrompt = `You are Dispatch, an AI email intelligence assistant.
Summarize this email thread into a structured catch-up for a busy professional.
Always return valid JSON matching exactly this schema:
{
  "subject": string,
  "whatThisIsAbout": string,
  "whereItStandsNow": string,
  "whatIsExpectedOfYou": string,
  "urgency": "high" | "medium" | "low",
  "suggestedReply": string | null,
  "participants": string[],
  "lastActivity": string,
  "unreadCount": number
}`;

  const threadText = messages.map((m) =>
    `[${m.receivedDateTime}] FROM: ${m.from?.emailAddress?.name} <${m.from?.emailAddress?.address}>\n${m.body?.content || m.bodyPreview}\n---`
  ).join("\n");

  return complete(systemPrompt, `USER EMAIL: ${userEmail}\n\nEMAIL THREAD (${messages.length} messages):\n${threadText.slice(0, 6000)}\n\nGenerate the catch-up now.`);
}

// ─────────────────────────────────────────────
// PROJECTS SUMMARY
// ─────────────────────────────────────────────

/**
 * Identify distinct active projects from inbox threads and match each to the most
 * relevant upcoming calendar meeting.
 * @param {Array} threads - [{ conversationId, subject, participantNames, latestDate, bodyPreview }]
 * @param {Array} events  - [{ id, subject, start, attendees }]
 */
async function generateProjectsSummary(threads, events = []) {
  const systemPrompt = `You are Dispatch, an AI email analyst. Given recent inbox threads AND upcoming calendar meetings, do two things:

1. Identify 2–5 distinct active PROJECTS or INITIATIVES visible in the email threads.
   Cluster related threads into one project. Skip noise (newsletters, receipts, OOO replies, admin).

2. For each project, find the SINGLE best matching upcoming calendar meeting by comparing:
   - Keywords in the project name and email subjects/previews against meeting subjects
   - Participant names in emails against meeting attendees
   - The meeting that shares the most topic overlap wins
   If no meeting matches, set nextMeetingId to null and derive nextMeeting from email content.

Return valid JSON — nothing else, no markdown:
{
  "projects": [
    {
      "name": string,
      "summary": string,
      "priority": "high" | "medium" | "low",
      "nextMeeting": string | null,
      "nextMeetingId": string | null,
      "keyTask": string,
      "threadId": string
    }
  ]
}

Field rules:
"name": 2–4 words matching the topic. e.g. "Customer Webinar", "Landing Page Launch".
"summary": ONE sentence — what is this project working toward right now?
"priority": "high" if deadline signals present (tomorrow, tonight, urgent, blocked, asap, overdue). "medium" otherwise.
"nextMeeting": Human-readable label e.g. "Tomorrow 9:30 AM — Leadership Update Prep" or "Tuesday — Webinar Dry Run". null if truly nothing found.
"nextMeetingId": The exact event id string from the MEETINGS LIST below that best matches this project. null if no match.
"keyTask": ONE sentence — the single most critical open action visible in the emails.
"threadId": The exact conversationId from the THREADS LIST that best represents this project.

MATCHING RULES for nextMeetingId:
- Tokenise both the project name/email subjects and each meeting subject into lowercase words
- Count overlapping meaningful words (ignore: the, a, an, in, on, at, for, with, from, this, that)
- Pick the meeting with the highest overlap score
- Minimum 1 overlapping meaningful word required — otherwise null`;

  const threadList = threads.slice(0, 25).map((t, i) =>
    `${i + 1}. conversationId: "${t.conversationId}" | Subject: "${t.subject}" | Participants: ${(t.participantNames || []).join(", ") || "unknown"} | Date: ${t.latestDate?.slice(0, 10) || "unknown"} | Preview: ${(t.bodyPreview || "").slice(0, 200)}`
  ).join("\n");

  const eventList = events.length === 0
    ? "NO UPCOMING MEETINGS FOUND."
    : events.map((e, i) =>
        `${i + 1}. eventId: "${e.id}" | Subject: "${e.subject}" | Start: ${e.start?.slice(0, 16) || "unknown"} | Attendees: ${(e.attendees || []).join(", ") || "none"}`
      ).join("\n");

  const userContent = `INBOX THREADS (identify projects from these):
${threadList}

UPCOMING CALENDAR MEETINGS (match each project to its best meeting):
${eventList}

Identify the projects and match them to meetings now. Return JSON only.`;

  return complete(systemPrompt, userContent, 0.2);
}

// ─────────────────────────────────────────────
// DAILY TO-DO PRIORITIZATION
// ─────────────────────────────────────────────

async function generateDailyPriorities({ todayEvents, pendingTasks, urgentEmails }) {
  const systemPrompt = `You are Dispatch, an AI daily planning assistant.
Create a prioritized daily plan from the user's calendar, tasks, and email.
Always return valid JSON:
{
  "greeting": string,
  "topPriorities": [{ "rank": number, "type": "meeting"|"task"|"email"|"deadline", "title": string, "context": string, "time": string|null, "action": string }],
  "meetingCount": number,
  "overdueItems": string[],
  "endOfDayGoals": string[]
}`;

  return complete(systemPrompt, `
TODAY'S MEETINGS (${todayEvents.length}):
${todayEvents.map((e) => `- ${e.start?.dateTime?.slice(11, 16)} | ${e.subject} | ${e.attendees?.length} attendees`).join("\n")}

PENDING TASKS:
${pendingTasks.slice(0, 10).map((t) => `- [${t.importance?.toUpperCase()}] ${t.title} | Due: ${t.dueDateTime?.dateTime || "no date"}`).join("\n")}

URGENT EMAILS:
${urgentEmails.slice(0, 5).map((e) => `- From: ${e.from?.emailAddress?.name} | ${e.subject}`).join("\n")}

Generate daily priorities now.`);
}

// ─────────────────────────────────────────────
// NUDGE GENERATION
// ─────────────────────────────────────────────

async function generateNudge(task) {
  return complete(
    `You are Dispatch. Generate a brief nudge for an overdue task. Return JSON: { "nudge": string, "suggestedAction": string }`,
    `TASK: ${task.title}\nNOTES: ${task.body?.content || "No notes"}\nDUE: ${task.dueDateTime?.dateTime}`
  );
}

module.exports = {
  generatePreCallBrief,
  processPostCall,
  generateThreadCatchup,
  generateProjectsSummary,
  generateDailyPriorities,
  generateNudge,
};