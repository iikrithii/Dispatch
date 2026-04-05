// services/openaiService.js
// Merged:
//   - Azure OpenAI toggle (from openaiService_additions)
//   - generatePreCallBrief now accepts jiraExecutionContext (from friend's Jira branch)
//   - processPostCall updated with effectiveness + engagement (user's new feature)
//   - generateSpeakingPoints (Meeting Notes feature)
//   - detectUnresolvedIssues (Projects tab feature)

const OpenAI = require("openai");

// ─────────────────────────────────────────────
// Client — auto-detects Groq vs Azure OpenAI
// ─────────────────────────────────────────────

let _client          = null;
let _useAzure        = false;
let _azureDeployment = null;

function getClient() {
  if (_client) return _client;

  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureKey      = process.env.AZURE_OPENAI_KEY;
  const azureDeploy   = process.env.AZURE_OPENAI_DEPLOYMENT;

  if (azureEndpoint && azureKey && azureDeploy) {
    const { AzureOpenAI } = require("openai");
    _client = new AzureOpenAI({
      endpoint:   azureEndpoint,
      apiKey:     azureKey,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview",
      deployment: azureDeploy,
    });
    _useAzure        = true;
    _azureDeployment = azureDeploy;
    console.log(`[openaiService] Using Azure OpenAI — deployment: ${azureDeploy}`);
  } else {
    _client   = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
    _useAzure = false;
    console.log("[openaiService] Using Groq");
  }
  return _client;
}

async function complete(systemPrompt, userContent, temperature = 0.3) {
  const client = getClient();
  const model  = _useAzure
    ? _azureDeployment
    : (process.env.GROQ_MODEL || "llama-3.3-70b-versatile");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userContent  },
    ],
    temperature,
    max_tokens: 2500,
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0].message.content;
  try { return JSON.parse(raw); }
  catch {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    try { return JSON.parse(cleaned); }
    catch { return { raw }; }
  }
}

// ─────────────────────────────────────────────
// PRE-CALL BRIEF
// Updated: accepts jiraExecutionContext so the LLM is aware of Jira state
// when writing currentStatus, openPoints, agendaForToday, keyContext.
// ─────────────────────────────────────────────

async function generatePreCallBrief({ event, recentEmails, emailThreads = [], pastMeetings, jiraExecutionContext }) {
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
"currentStatus": Exactly 2 sentences. Where does the project/work stand right now? Do NOT mention the upcoming meeting. Do not mention number of jira tasks and stuff, you can mention the content from the task, highlight whatever is completed and pending from email and threads.
"followUps": null if no past meeting. Otherwise populate all fields.
  "narrative": 3-5 sentences on what happened IN the meeting.
  "conversationStory": 4-8 sentences reconstructing email back-and-forth AFTER the meeting.
  "items": Every action item. Match owner name to email senders to determine done/pending.
  "nextMeetingPoints": Things planned for the NEXT meeting. Max 4.
"openPoints": Max 3 unresolved blockers. If Jira blockers are provided, prefer those. Avoid duplicating discussionItems.
"agendaForToday": Max 4 concrete things to decide/accomplish. Use Jira discussion points if provided.
"keyContext": 1-2 sentences of critical background. Don't use Jira tasks, rathed use the context of the project, from all the information`;

  const jiraBlock = jiraExecutionContext
    ? `━━━ JIRA EXECUTION CONTEXT ━━━
Project: ${jiraExecutionContext.title || ""}
Status: ${jiraExecutionContext.statusLine || ""}
Blockers: ${(jiraExecutionContext.blockers || []).join("; ") || "none"}
Discussion points: ${(jiraExecutionContext.discussionPoints || []).join("; ") || "none"}`
    : "NO JIRA CONTEXT AVAILABLE.";

  const pastMeetingsText = !pastMeetings || pastMeetings.length === 0
    ? "NO PAST MEETING RECORD AVAILABLE."
    : pastMeetings.slice(0, 1).map((m) => `
PAST MEETING SUBJECT: ${m.subject}
PAST MEETING DATE: ${m.date || "unknown"}
SUMMARY: ${m.summary || "none"}
TRANSCRIPT (up to 4000 chars):
${m.transcript || "none"}
ACTION ITEMS:
${(m.actionItems || []).length > 0 ? m.actionItems.map((a) => `  - Owner: ${a.owner} | Task: ${a.task}`).join("\n") : "  none recorded"}
PLANNED FOR NEXT MEETING:
${Array.isArray(m.plannedForNextMeeting) && m.plannedForNextMeeting.length > 0 ? m.plannedForNextMeeting.map((p) => `  - ${p}`).join("\n") : "  none recorded"}`).join("\n===\n");

  const emailText = (recentEmails || []).length === 0
    ? "NO RELEVANT EMAILS FOUND."
    : recentEmails.slice(0, 25).map((e, i) =>
        `idx:${i + 1} | id:${e.id || "no-id"} | [${e.receivedDateTime?.slice(0, 10)}] From: ${e.from?.emailAddress?.name || e.from?.emailAddress?.address || "unknown"} | Subject: "${e.subject || "(no subject)"}" | Body: ${(e.bodyClean || e.bodyPreview || "(none)").slice(0, 300)}`
      ).join("\n");

  const threadText = (emailThreads || []).length === 0
    ? "NO EMAIL THREADS FOUND."
    : emailThreads.slice(0, 5).map((t, i) =>
        `── THREAD ${i + 1}: "${t.subject}" (${t.messagesCount} message(s)) ──\n${t.conversationLog || "(no conversation log)"}`
      ).join("\n\n");

  const userContent = `UPCOMING MEETING: "${event.subject}"
SCHEDULED FOR: ${event.start?.dateTime || event.start || "unknown"}
ATTENDEES: ${(event.attendees || []).map((a) => a.emailAddress?.name || a.emailAddress?.address).join(", ")}

${jiraBlock}

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
// Updated: adds meetingEffectiveness + meetingEngagement sections.
// priorMeeting (from Cosmos) enables effectiveness scoring against prior agenda.
// ─────────────────────────────────────────────

async function processPostCall(transcript, meetingInfo, priorMeeting = null) {
  const priorContext = priorMeeting
    ? `PRIOR MEETING CONTEXT (for effectiveness analysis):
Subject: ${priorMeeting.subject || "unknown"}
Date: ${priorMeeting.startTime || priorMeeting.savedAt || "unknown"}
Planned agenda / action items from that meeting:
${(priorMeeting.actionItems || []).length > 0
  ? priorMeeting.actionItems.map((a) => `  - [${a.status || "pending"}] ${a.owner}: ${a.task}`).join("\n")
  : "  none recorded"}
Summary: ${(priorMeeting.summary || "none").slice(0, 600)}`
    : "NO PRIOR MEETING CONTEXT AVAILABLE.";

  const systemPrompt = `You are Dispatch, an AI post-meeting assistant.
Extract structured information from this meeting transcript.
Always return valid JSON matching exactly this schema — nothing else, no markdown:
{
  "summary": string,
  "actionItems": [{ "id": string, "owner": string, "task": string, "deadline": string | null, "urgency": "high" | "medium" | "low" }],
  "softCommitments": [{ "person": string, "commitment": string, "estimatedDeadline": string | null }],
  "followUpEmails": [{ "id": string, "to": string[], "subject": string, "body": string }],
  "suggestedFollowUpMeeting": { "needed": boolean, "suggestedAgenda": string, "suggestedTimeframe": string },
  "keyDecisions": string[],
  "meetingEffectiveness": {
    "score": number,
    "addressed": [{ "item": string, "outcome": string }],
    "skipped": [{ "item": string, "reason": string | null }],
    "newIssuesRaised": string[]
  },
  "meetingEngagement": {
    "totalSpeakers": number,
    "participants": [
      {
        "name": string,
        "participationLevel": "high" | "medium" | "low" | "silent",
        "speakingShare": number,
        "keyContributions": string[],
        "note": string | null
      }
    ],
    "facilitationQuality": string,
    "dominantSpeaker": string | null
  }
}

FIELD RULES:
"meetingEffectiveness":
  "score": 0-100. 100 = every planned item addressed with a decision.
  "addressed": Items from PRIOR MEETING agenda that WERE discussed today, with outcome.
  "skipped": Items from PRIOR MEETING agenda NOT discussed today, with reason if stated.
  "newIssuesRaised": Topics that came up today not on the prior agenda. Max 4.
  If NO prior meeting context, set score to null and base addressed/skipped on transcript agenda signals.

"meetingEngagement":
  "totalSpeakers": Count of distinct named speakers in transcript.
  "participants": One entry per named person in transcript OR attendees list.
    "participationLevel": high = drove discussion; medium = meaningful contributions; low = 1-2 brief turns; silent = no speaking detected.
    "speakingShare": Estimated % of speaking time, all shares should sum to ~100.
    "keyContributions": Up to 2 specific points this person made.
    "note": Notable flag e.g. "raised blocker", "only spoke when asked". null if nothing notable.
  "facilitationQuality": 1 sentence on how well the meeting was run.
  "dominantSpeaker": Name with highest speakingShare, or null if balanced.

If transcript has no speaker labels, mark all as "low" with note: "Transcript has no speaker labels — engagement estimated".`;

  return complete(systemPrompt, `
MEETING: ${meetingInfo.subject}
DATE: ${meetingInfo.date}
ATTENDEES: ${meetingInfo.attendees?.join(", ")}

${priorContext}

TRANSCRIPT:
${transcript.slice(0, 8000)}

Extract all information now. Return JSON only.`);
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

async function generateProjectsSummary(threads, events = []) {
  const systemPrompt = `You are Dispatch, an AI email analyst. Given recent inbox threads AND upcoming calendar meetings, do two things:

1. Identify 2–5 distinct active PROJECTS or INITIATIVES visible in the email threads.
   Cluster related threads into one project. Skip noise (newsletters, receipts, OOO replies, admin).

2. For each project, find the SINGLE best matching upcoming calendar meeting.

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

"name": 2–4 words. "summary": ONE sentence. "priority": "high" if deadline signals present.
"nextMeetingId": exact event id from MEETINGS LIST. null if no match.
"keyTask": single most critical open action visible in emails.
"threadId": exact conversationId from THREADS LIST.

MATCHING RULES: tokenise both project name/subjects and meeting subject. Count overlapping meaningful words. Minimum 1 overlapping word required.`;

  const threadList = threads.slice(0, 25).map((t, i) =>
    `${i + 1}. conversationId: "${t.conversationId}" | Subject: "${t.subject}" | Participants: ${(t.participantNames || []).join(", ") || "unknown"} | Date: ${t.latestDate?.slice(0, 10) || "unknown"} | Preview: ${(t.bodyPreview || "").slice(0, 200)}`
  ).join("\n");

  const eventList = events.length === 0
    ? "NO UPCOMING MEETINGS FOUND."
    : events.map((e, i) =>
        `${i + 1}. eventId: "${e.id}" | Subject: "${e.subject}" | Start: ${e.start?.slice(0, 16) || "unknown"} | Attendees: ${(e.attendees || []).join(", ") || "none"}`
      ).join("\n");

  return complete(systemPrompt, `INBOX THREADS:\n${threadList}\n\nUPCOMING MEETINGS:\n${eventList}\n\nReturn JSON only.`, 0.2);
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

// ─────────────────────────────────────────────
// SPEAKING POINTS (Meeting Notes feature)
// Output is always English. Input can be any language or codemixed.
// ─────────────────────────────────────────────

async function generateSpeakingPoints({
  meetingTitle, language = "English", agenda = [], followUpItems = [],
  openPoints = [], keyContext = "", currentStatus = "",
  questions = [], answers = {}, additionalNotes = "",
}) {
  const systemPrompt = `You are Dispatch, an AI speaking coach for professionals.
A user is about to enter a meeting. They have jotted down rough prep notes — possibly in mixed languages, shorthand, or fragments. Transform these into polished, confident speaking points.

OUTPUT LANGUAGE: English.
The user's input may be codemixed — Tamil words in English letters, Hindi words, Tanglish, Hinglish, or full sentences in any Indian language romanised. Understand all of it and write the output in clean professional English only.

Return valid JSON — no markdown fences, no commentary:
{
  "openingStatement": string,
  "speakingPoints": [
    { "topic": string, "draft": string, "talkingPoints": string[] }
  ],
  "closingStatement": string,
  "redFlags": string[]
}

"openingStatement": 1–2 sentences to open their turn, verbatim.
"speakingPoints": One entry per answered question plus one for additionalNotes if present.
  "draft": 2–4 polished sentences to read aloud.
  "talkingPoints": 2–4 short bullets (max 15 words each) to glance at during the meeting.
"closingStatement": 1 sentence to hand back the floor.
"redFlags": 0–3 concerns visible in their notes. Empty array if none.

Do NOT invent facts not in the user's notes. If an answer is vague, still generate something useful and note the gap in redFlags.`;

  const answeredQuestions = questions.filter((q) => (answers[q.id] || "").trim().length > 0);

  const qaBlock = answeredQuestions.length === 0
    ? "NO SPECIFIC QUESTION ANSWERS PROVIDED."
    : answeredQuestions.map((q) => {
        const typeLabel = q.type === "followup" ? "FOLLOW-UP TASK" : q.type === "openpoint" ? "OPEN POINT" : "AGENDA ITEM";
        return `[${typeLabel}] ${q.topic}\nUser's answer: ${answers[q.id]}`;
      }).join("\n\n");

  const contextBlock = [
    currentStatus && `Current project status: ${currentStatus}`,
    keyContext     && `Key context: ${keyContext}`,
  ].filter(Boolean).join("\n");

  const userContent = `MEETING: "${meetingTitle}"
${contextBlock ? `\nCONTEXT:\n${contextBlock}` : ""}

FULL AGENDA:
${agenda.length > 0 ? agenda.map((a, i) => `${i + 1}. ${a}`).join("\n") : "Not specified."}

PENDING FOLLOW-UPS:
${followUpItems.length > 0 ? followUpItems.map((f) => `• ${f.owner}: ${f.task}`).join("\n") : "None."}

━━━ USER'S PREP ANSWERS ━━━
${qaBlock}

━━━ ADDITIONAL NOTES ━━━
${additionalNotes.trim() || "No additional notes."}

Transform these into polished English speaking points now.`;

  return complete(systemPrompt, userContent, 0.3);
}

// ─────────────────────────────────────────────
// DETECT UNRESOLVED ISSUES (Projects tab)
// Scans multiple meeting records for recurring unresolved topics.
// ─────────────────────────────────────────────

async function detectUnresolvedIssues(meetingRecords) {
  const systemPrompt = `You are Dispatch, an AI meeting analyst.
Detect RECURRING UNRESOLVED ISSUES — topics that came up in 2+ meetings but were never resolved or closed with a completed action item.

Return valid JSON only — no markdown:
{
  "issues": [
    {
      "issue": string,
      "meetingCount": number,
      "riskLevel": "high" | "medium" | "low",
      "affectedProjects": string[],
      "lastSeen": string | null,
      "suggestion": string
    }
  ]
}

"issue": Concise name, max 10 words. Be specific.
"riskLevel": "high" if appears in 3+ meetings or blocks other work; "medium" if 2 meetings, important; "low" if 2 meetings, minor.
"affectedProjects": Infer 1-3 project names from meeting subjects/summaries.
"lastSeen": ISO date of most recent meeting where this appeared.
"suggestion": ONE concrete action, max 15 words.

DETECTION RULES:
- Only flag topics appearing in 2+ DIFFERENT meetings.
- A topic is "resolved" if there is a completed/done action item explicitly addressing it.
- Do NOT flag general recurring meeting formats (standups, check-ins).
- Maximum 6 issues. If fewer than 2 meetings have overlapping topics, return empty issues array.`;

  const meetingList = meetingRecords.map((m, i) => {
    const actionSummary = (m.actionItems || []).length > 0
      ? m.actionItems.map((a) => `  - [${a.status || "pending"}] ${a.owner}: ${a.task}`).join("\n")
      : "  none recorded";
    return `── MEETING ${i + 1} ──
Subject: ${m.subject || "(no subject)"}
Date: ${m.startTime || m.savedAt || "unknown"}
Summary: ${(m.summary || "none").slice(0, 400)}
Transcript excerpt: ${(m.transcript || "").slice(0, 600)}
Action items:\n${actionSummary}`;
  }).join("\n\n");

  return complete(systemPrompt, `Analyse these ${meetingRecords.length} meeting records for recurring unresolved issues:\n\n${meetingList}\n\nReturn JSON now.`, 0.2);
}


// ─────────────────────────────────────────────
// HANDOVER REPORT (Projects tab)
// Synthesises all project data into structured narrative for PDF.
// ─────────────────────────────────────────────

async function generateHandoverReport({ projectName, meetings, pendingTasks, attendees, emailThreads }) {
  const systemPrompt = `You are Dispatch, an AI project analyst.
Synthesise the provided project data into a structured handover document for a new team member.
Return valid JSON only — no markdown, no commentary:
{
  "oneLiner": string,
  "overview": string,
  "currentStatus": string,
  "meetingHistory": [
    {
      "subject": string,
      "date": string | null,
      "summary": string,
      "decisions": string[]
    }
  ],
  "openActionItems": [
    { "task": string, "owner": string, "status": "pending" | "done" }
  ],
  "keyPeople": [
    { "name": string, "email": string | null, "role": string | null }
  ],
  "emailContext": [
    { "subject": string, "summary": string }
  ],
  "dayOneChecklist": string[]
}

FIELD RULES:
"oneLiner": Single sentence — what this project is and why it matters.
"overview": 3–5 sentences. What is this project? What problem does it solve? Where did it start?
"currentStatus": 1–2 sentences — where things stand RIGHT NOW.
"meetingHistory": All meetings, oldest first. Max 2 decisions per meeting. Keep summaries to 2 sentences.
"openActionItems": All pending tasks plus any incomplete action items from meetings. Deduplicate.
"keyPeople": Every unique person across meetings and attendees. Infer role from context (e.g. "Technical Lead", "Project Sponsor"). null if unclear.
"emailContext": One entry per email thread. Summary = 1–2 sentences on what the thread is about.
"dayOneChecklist": 4–6 specific, concrete things the new person should do first. Actionable imperatives.`;

  const meetingList = meetings.map((m, i) => `
MEETING ${i + 1}: ${m.subject || "(untitled)"}
Date: ${m.startTime || m.savedAt || "unknown"}
Summary: ${(m.summary || "none").slice(0, 400)}
Action items:
${(m.actionItems || []).map((a) => `  - [${a.status || "pending"}] ${a.owner}: ${a.task}`).join("\n") || "  none"}`).join("\n");

  const taskList = pendingTasks.slice(0, 20).map((t) =>
    `- ${t.label || t.data?.subject || "(task)"} | owner: ${t.data?.owner || "unknown"}`
  ).join("\n") || "none";

  const peopleList = attendees.map((a) =>
    `- ${a.name || a.email} <${a.email || "no email"}>${a.taskCount > 0 ? ` (${a.taskCount} tasks)` : ""}`
  ).join("\n") || "none";

  const threadList = emailThreads.map((t) =>
    `- Subject: "${t.subject}" | ID: ${t.conversationId}`
  ).join("\n") || "none";

  return complete(systemPrompt, `
PROJECT: "${projectName}"

MEETINGS (${meetings.length}):
${meetingList || "none"}

PENDING TASKS:
${taskList}

PEOPLE:
${peopleList}

EMAIL THREADS:
${threadList}

Generate the handover report JSON now.`, 0.2);
}

// ─────────────────────────────────────────────
// COMMITMENT INTELLIGENCE (Live Co-Pilot)
// ─────────────────────────────────────────────

async function checkCommitmentsWithAI({ transcript, context }) {
  const systemPrompt = `You are Dispatch's Commitment Intelligence engine.

Analyse a meeting transcript snippet and:
1. Extract every commitment, deadline, or deliverable being proposed or agreed to.
2. Evaluate feasibility based on the calendar load and pending tasks provided.
3. Suggest a realistic alternative when feasibility is risky or unrealistic.
4. List specific calendar conflicts causing the problem.

Feasibility scale:
- "clear"       -> Plenty of time, no conflicts
- "tight"       -> Achievable but little buffer
- "risky"       -> Conflicts exist, likely to slip
- "unrealistic" -> Not achievable given current load

Rules:
- If no owner is mentioned, assume "You".
- Always fill the suggestion field.
- Return strict JSON only. No markdown, no explanation outside JSON.

Return valid JSON matching exactly this schema:
{
  "commitments": [
    {
      "raw": "exact phrase from transcript",
      "owner": "You | Person Name",
      "deadline": "YYYY-MM-DD or null",
      "deadlineLabel": "e.g. Tuesday EOD",
      "feasibility": "clear | tight | risky | unrealistic",
      "reason": "1-2 sentences referencing actual calendar load",
      "suggestion": "Concrete counter-proposal or confirmation",
      "conflicts": [
        { "title": "Meeting title", "time": "Day HH:MM-HH:MM" }
      ]
    }
  ]
}`;

  const userContent = `Today's date: ${new Date().toISOString().slice(0, 10)}

## Meeting Context and Calendar Load
${context}

## Transcript Snippet to Analyse
${transcript}

Extract all commitments. Evaluate feasibility. Return JSON only.`;

  return complete(systemPrompt, userContent, 0.2);
}
// ─────────────────────────────────────────────
// CONTEXT WHISPERS
// Surfaces relevant past context when a topic comes up.
// Flags contradictions against previously agreed decisions.
// ─────────────────────────────────────────────

async function generateContextWhisper({ transcript, context }) {
  const systemPrompt = `You are Dispatch's Context Whisper engine.

A user is in a live meeting. A topic has just come up in the transcript snippet.
Your job is to:
1. Identify what topic or subject is being discussed.
2. Surface the most relevant context from past meetings, emails, or decisions provided.
3. Flag any CONTRADICTIONS — where what is being said now deviates from what was previously agreed.

Return valid JSON only — no markdown, no commentary:
{
  "topic": "brief label for what is being discussed",
  "whispers": [
    {
      "type": "context" | "decision" | "contradiction" | "action_item",
      "content": "the relevant piece of information",
      "source": "e.g. Past meeting Apr 1 | Email from Robin | Decision in Sprint Review",
      "relevanceReason": "one sentence — why this is relevant right now"
    }
  ],
  "contradictions": [
    {
      "currentStatement": "what is being said now",
      "previousAgreement": "what was agreed before",
      "source": "where the previous agreement came from",
      "severity": "high" | "medium" | "low"
    }
  ],
  "hasContradiction": boolean
}

Rules:
- Maximum 3 whispers. Pick only the most relevant.
- Maximum 2 contradictions.
- If nothing relevant found, return empty arrays and hasContradiction: false.
- Be specific — reference actual names, dates, numbers from the context provided.
- whisper type "contradiction" should ONLY be used when there is a direct conflict.`;

  const userContent = `Today's date: ${new Date().toISOString().slice(0, 10)}

## Past Meeting History, Decisions, and Email Context
${context}

## Live Transcript Snippet (what is being said RIGHT NOW)
${transcript}

Surface relevant context and flag any contradictions. Return JSON only.`;

  return complete(systemPrompt, userContent, 0.2);
}

// ─────────────────────────────────────────────
// FOCUS RECOVERY (Zone-Out Assist)
// Tells the user what they missed and what is expected of them.
// ─────────────────────────────────────────────

async function generateFocusRecovery({ transcript, userName, context }) {
  const systemPrompt = `You are Dispatch's Focus Recovery engine.

A meeting participant has zoned out or stepped away. You are given the last portion of the meeting transcript.
Your job is to:
1. Summarise what was just discussed in plain language.
2. Identify if anything was directed at or expected from the user specifically.
3. Give them exactly what they need to re-engage without friction.

Return valid JSON only — no markdown, no commentary:
{
  "catchUpSummary": "2-3 sentences — what happened while they were zoned out",
  "currentTopic": "one line — what is being discussed RIGHT NOW",
  "directedAtUser": boolean,
  "whatWasAsked": "exact question or task directed at the user, or null if nothing directed at them",
  "suggestedResponse": "a ready-to-use response they can say immediately, or null if nothing is expected",
  "missedDecisions": [
    "any decisions made while they were out — max 3"
  ],
  "missedActionItems": [
    { "owner": "person name", "task": "what they committed to" }
  ]
}

Rules:
- Keep catchUpSummary under 60 words.
- suggestedResponse should be natural spoken language, not formal.
- If the user's name appears in the transcript with a question or task, set directedAtUser to true.
- missedDecisions and missedActionItems max 3 each.`;

  const userContent = `Today's date: ${new Date().toISOString().slice(0, 10)}
User's name: ${userName || "the user"}

## Meeting Background Context
${context}

## Transcript from the last 60 seconds (what the user missed)
${transcript}

Generate the focus recovery briefing now. Return JSON only.`;

  return complete(systemPrompt, userContent, 0.2);
}

// ─────────────────────────────────────────────
// LIVE CONTEXT DRIFT DETECTION
// Detects when discussion moves away from intended agenda.
// ─────────────────────────────────────────────

async function detectContextDrift({ transcript, agenda, context }) {
  const systemPrompt = `You are Dispatch's Context Drift Detection engine.

A meeting is in progress. You are given the intended agenda and the current transcript.
Your job is to detect if the discussion has drifted away from the agenda and suggest a gentle nudge to bring it back.

Return valid JSON only — no markdown, no commentary:
{
  "driftDetected": boolean,
  "driftScore": number,
  "currentTopic": "what is actually being discussed right now",
  "expectedTopic": "what should be discussed based on the agenda",
  "driftReason": "one sentence explaining how and why the discussion drifted, or null if no drift",
  "nudge": "a gentle, professional suggestion to redirect the conversation, or null if no drift",
  "agendaProgress": [
    {
      "item": "agenda item text",
      "status": "completed" | "in_progress" | "not_started" | "skipped"
    }
  ],
  "timeRisk": "on_track" | "at_risk" | "behind",
  "timeRiskReason": "one sentence on time risk, or null if on track"
}

Rules:
- driftScore: 0-100. 0 = perfectly on agenda. 100 = completely off topic.
- driftDetected = true if driftScore >= 40.
- nudge should be a suggestion a facilitator could say out loud — natural, not robotic.
- agendaProgress tracks ALL agenda items based on transcript evidence.
- timeRisk: "at_risk" if a major item hasn't started and time seems short. "behind" if items clearly skipped.`;

  const userContent = `Today's date: ${new Date().toISOString().slice(0, 10)}

## Intended Meeting Agenda
${agenda}

## Meeting Background Context
${context}

## Current Transcript (recent portion of the meeting)
${transcript}

Detect drift and generate nudge if needed. Return JSON only.`;

  return complete(systemPrompt, userContent, 0.2);
}

// ─────────────────────────────────────────────
// ADD THESE TO module.exports:

// ─────────────────────────────────────────────
module.exports = {
  generatePreCallBrief,
  processPostCall,
  generateThreadCatchup,
  generateProjectsSummary,
  generateDailyPriorities,
  generateNudge,
  generateSpeakingPoints,
  detectUnresolvedIssues,
  generateHandoverReport,
  checkCommitmentsWithAI, 
  generateContextWhisper,
generateFocusRecovery,
detectContextDrift,
};


