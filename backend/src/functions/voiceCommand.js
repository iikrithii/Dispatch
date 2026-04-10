const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

function normalizeText(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s:/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text = "") {
  return normalizeText(text).split(" ").filter(Boolean);
}

function hasAnyPhrase(text, phrases = []) {
  return phrases.some((phrase) => text.includes(phrase));
}

function extractRequestedCount(text = "") {
  const normalized = normalizeText(text);
  const wordToNumber = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
  };

  const digitMatch = normalized.match(/\b([1-5])\b/);
  if (digitMatch) return Number(digitMatch[1]);

  for (const [word, value] of Object.entries(wordToNumber)) {
    if (normalized.includes(word)) {
      return value;
    }
  }

  return null;
}

function getDateKey(value, timeZone = "Asia/Kolkata") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function formatMeetingTime(value, timeZone = "Asia/Kolkata") {
  if (!value) return "TBD";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

function buildMeetingsTodayAnswer(events, timeZone, limit = null) {
  if (!events.length) {
    return "You do not have any meetings scheduled for today.";
  }

  const requestedCount = limit ? Math.min(limit, events.length) : events.length;
  const lines = events.slice(0, requestedCount).map((event) => {
    const time = formatMeetingTime(event.start?.dateTime, timeZone);
    const subject = event.subject || "Untitled meeting";
    const attendees = event.attendees?.length ? ` with ${event.attendees.length} attendees` : "";
    return `${subject} at ${time}${attendees}`;
  });

  if (requestedCount < events.length) {
    return `You have ${events.length} meetings today. Here are the first ${requestedCount}. ${lines.join(". ")}.`;
  }

  return `You have ${events.length} meeting${events.length === 1 ? "" : "s"} today. ${lines.join(". ")}.`;
}

function buildNextMeetingAnswer(events, timeZone) {
  const now = Date.now();
  const nextEvent = events
    .filter((event) => event.start?.dateTime)
    .sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime))
    .find((event) => new Date(event.start.dateTime).getTime() >= now);

  if (!nextEvent) {
    return "You do not have any more upcoming meetings in your current calendar window.";
  }

  const subject = nextEvent.subject || "Untitled meeting";
  const start = formatMeetingTime(nextEvent.start?.dateTime, timeZone);
  const day = getDateKey(nextEvent.start?.dateTime, timeZone) === getDateKey(now, timeZone)
    ? "today"
    : `on ${getDateKey(nextEvent.start?.dateTime, timeZone)}`;
  return `Your next meeting is ${subject} at ${start} ${day}.`;
}

function buildTasksAnswer(tasks) {
  if (!tasks.length) {
    return "You do not have any open Dispatch tasks right now.";
  }

  const taskLines = tasks.slice(0, 5).map((task, index) => {
    const due = task.dueDateTime?.dateTime
      ? `, due ${task.dueDateTime.dateTime.slice(0, 10)}`
      : "";
    return `${index + 1}. ${task.title || "Untitled task"}${due}`;
  });

  return `You have ${tasks.length} open task${tasks.length === 1 ? "" : "s"}. ${taskLines.join(" ")}`;
}

function toBriefTextList(items = []) {
  return (items || [])
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") return item;
      return item.text || item.title || item.item || null;
    })
    .filter(Boolean);
}

function buildPrioritiesAnswer(topPriorities = []) {
  if (!topPriorities.length) {
    return "You do not have any top priorities lined up right now.";
  }

  const lines = topPriorities.slice(0, 3).map((item, index) => {
    const title = item?.title || `Priority ${index + 1}`;
    const time = item?.time ? ` at ${item.time}` : "";
    return `${index + 1}. ${title}${time}`;
  });

  return `Your top priorities today are ${lines.join(". ")}.`;
}

function buildPendingApprovalsAnswer(count = 0) {
  return count > 0
    ? `You have ${count} pending approval${count === 1 ? "" : "s"} waiting for review.`
    : "You do not have any pending approvals right now.";
}

function buildDueRemindersAnswer(reminders = []) {
  const count = reminders.length || 0;
  return count > 0
    ? `You have ${count} due reminder${count === 1 ? "" : "s"} today.`
    : "You do not have any due reminders right now.";
}

function buildBriefSummaryAnswer(brief = {}, meeting = null) {
  if (!brief || Object.keys(brief).length === 0) {
    return "I do not have a pre-call brief loaded for your next meeting yet.";
  }

  const title = brief.meetingTitle || meeting?.subject || "your next meeting";
  const sections = [];

  // Current Status
  if (brief.currentStatus) {
    sections.push(`Current Status: ${brief.currentStatus}`);
  }

  // Key Context
  if (brief.keyContext) {
    sections.push(`Key Context: ${brief.keyContext}`);
  }

  // Open Points / Blockers
  const openPoints = toBriefTextList(brief.openPoints || []).slice(0, 3);
  if (openPoints.length > 0) {
    sections.push(`Open Points: ${openPoints.join(". ")}.`);
  }

  // Agenda
  const agenda = toBriefTextList(brief.agenda || brief.agendaForToday || []).slice(0, 4);
  if (agenda.length > 0) {
    sections.push(`Agenda: ${agenda.map((item, i) => `${i + 1}. ${item}`).join(" ")}`);
  }

  // Follow-ups if available
  if (brief.followUps?.items && brief.followUps.items.length > 0) {
    const items = brief.followUps.items.slice(0, 3);
    sections.push(`Previous Action Items: ${items.map((item) => `${item.owner}: ${item.task} (${item.status})`).join(". ")}.`);
  }

  return `Here is your pre-call brief for ${title}.\n\n${sections.join("\n\n")}`;
}

function buildBriefAgendaAnswer(brief = {}, meeting = null) {
  const agenda = toBriefTextList(brief?.agenda || brief?.agendaForToday || []);
  if (!agenda.length) {
    return `I do not have agenda items yet for ${brief?.meetingTitle || meeting?.subject || "this meeting"}.`;
  }
  return `For ${brief?.meetingTitle || meeting?.subject || "this meeting"}, the agenda is ${agenda.slice(0, 4).join(". ")}.`;
}

function buildBriefStatusAnswer(brief = {}, meeting = null) {
  if (!brief?.currentStatus) {
    return `I do not have a current status summary yet for ${brief?.meetingTitle || meeting?.subject || "this meeting"}.`;
  }
  return `For ${brief?.meetingTitle || meeting?.subject || "this meeting"}, the current status is: ${brief.currentStatus}`;
}

function buildBriefContextAnswer(brief = {}, meeting = null) {
  if (!brief?.keyContext) {
    return `I do not have extra background context saved yet for ${brief?.meetingTitle || meeting?.subject || "this meeting"}.`;
  }
  return `Key context for ${brief?.meetingTitle || meeting?.subject || "this meeting"}: ${brief.keyContext}`;
}

function buildBriefFollowUpsAnswer(brief = {}, meeting = null) {
  const items = (brief?.followUps?.items || []).slice(0, 3);
  if (!items.length) {
    return `I do not have any follow-ups captured from the last meeting for ${brief?.meetingTitle || meeting?.subject || "this meeting"}.`;
  }

  const lines = items.map((item) => {
    const owner = item?.owner || "someone";
    const task = item?.task || "an action item";
    const status = item?.status || "pending";
    return `${owner}: ${task} (${status})`;
  });

  return `Recent follow-ups for ${brief?.meetingTitle || meeting?.subject || "this meeting"} are ${lines.join(". ")}.`;
}

function buildTaskNotFoundAnswer(action, tasks) {
  if (!tasks.length) {
    return `I could not ${action} a task because you do not have any open Dispatch tasks right now.`;
  }

  const sampleTitles = tasks
    .slice(0, 3)
    .map((task, index) => `${index + 1}. ${task.title || "Untitled task"}`)
    .join(" ");

  return `I could not find the task to ${action}. Try saying the task number or a clearer title. Current tasks: ${sampleTitles}`;
}

function buildGreetingAnswer(profile, events, tasks, timeZone) {
  const name = profile?.displayName?.split(" ")?.[0] || "there";
  const meetingSummary = events.length
    ? `You have ${events.length} meeting${events.length === 1 ? "" : "s"} today, starting with ${events[0].subject || "your first meeting"} at ${formatMeetingTime(events[0].start?.dateTime, timeZone)}.`
    : "You do not have any meetings scheduled for today.";
  const taskSummary = tasks.length
    ? `You also have ${tasks.length} open Dispatch task${tasks.length === 1 ? "" : "s"}.`
    : "You do not have any open Dispatch tasks right now.";

  return `Hi ${name}. ${meetingSummary} ${taskSummary} Ask me about your meetings, ask for your tasks, add a task, update a task, or remove a task.`;
}

function buildUnknownAnswer(transcript, events, tasks, timeZone) {
  const meetingHint = events.length
    ? `Right now you have ${events.length} meeting${events.length === 1 ? "" : "s"} today.`
    : "You do not have any meetings today.";
  const taskHint = tasks.length
    ? `You also have ${tasks.length} open task${tasks.length === 1 ? "" : "s"}.`
    : "You do not have any open tasks.";

  return `I heard "${transcript}", but I could not map that to a command yet. ${meetingHint} ${taskHint} Try asking: what are my meetings today, what is my next meeting, what are my open tasks, add task send investor update tomorrow, update task 2 to send launch summary, or remove task 2.`;
}

function extractTaskTitle(rawTranscript) {
  const patterns = [
    /^(?:add|create|make)\s+(?:a\s+)?task(?:\s+(?:to|for))?\s+(.+)$/i,
    /^(?:remind me to)\s+(.+)$/i,
    /^(?:add)\s+(.+?)\s+to(?:\s+my)?\s+tasks?$/i,
  ];

  for (const pattern of patterns) {
    const match = rawTranscript.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function extractTaskUpdate(rawTranscript) {
  const patterns = [
    /^(?:update|edit|rename|change)\s+task\s+(.+?)\s+(?:to|as)\s+(.+)$/i,
    /^(?:update|edit|rename|change)\s+(.+?)\s+(?:to|as)\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = rawTranscript.match(pattern);
    if (match?.[1] && match?.[2]) {
      return {
        target: match[1].trim(),
        newTitle: match[2].trim(),
      };
    }
  }

  return null;
}

function extractTaskRemovalTarget(rawTranscript) {
  const patterns = [
    /^(?:remove|delete)\s+task\s+(.+)$/i,
    /^(?:remove|delete)\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = rawTranscript.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function extractTaskCompletionTarget(rawTranscript) {
  const patterns = [
    /^(?:complete|finish|mark done)\s+task\s+(.+)$/i,
    /^(?:complete|finish|mark done)\s+(.+)$/i,
    /^(?:mark)\s+(.+?)\s+(?:as done|done|complete|completed)$/i,
  ];

  for (const pattern of patterns) {
    const match = rawTranscript.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function extractMeetingForBrief(rawTranscript) {
  const patterns = [
    /(?:pre.?call|brief|free call)\s+(?:for|about|on)\s+(.+)$/i,
    /(?:brief me|prepare me)\s+(?:for|on)\s+(.+)$/i,
    /(.+?)\s+(?:pre.?call|brief|free call)$/i,
    /(?:what|tell me|get)(?:\s+(?:my|the))?\s+(?:brief|pre.?call|free call)\s+(?:for|about|on)?\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = rawTranscript.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function findMeetingByName(events, name) {
  if (!name || !events || events.length === 0) return null;

  const normalizedName = normalizeText(name);
  
  // Exact match
  const exactMatch = events.find(
    (event) => normalizeText(event.subject || "") === normalizedName
  );
  if (exactMatch) return exactMatch;

  // Contains match
  const containsMatch = events.find(
    (event) =>
      normalizeText(event.subject || "").includes(normalizedName) ||
      normalizedName.includes(normalizeText(event.subject || ""))
  );
  if (containsMatch) return containsMatch;

  // Token overlap match
  const nameTokens = new Set(normalizedName.split(" ").filter(Boolean));
  let bestMatch = null;
  let bestScore = 0;

  for (const event of events) {
    const eventTokens = normalizeText(event.subject || "")
      .split(" ")
      .filter(Boolean);
    const score = eventTokens.filter((token) => nameTokens.has(token)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = event;
    }
  }

  return bestScore >= 2 ? bestMatch : null;
}

function normalizeTaskReference(text = "") {
  return normalizeText(text)
    .replace(/\btask\b/g, "")
    .replace(/\bnumber\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findTaskMatch(tasks, reference) {
  const normalizedReference = normalizeTaskReference(reference);
  if (!normalizedReference) return null;

  const ordinalMap = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
  };

  const digitMatch = normalizedReference.match(/\b([1-9]\d*)\b/);
  if (digitMatch) {
    const index = Number(digitMatch[1]) - 1;
    return tasks[index] || null;
  }

  for (const [word, value] of Object.entries(ordinalMap)) {
    if (normalizedReference.includes(word)) {
      return tasks[value - 1] || null;
    }
  }

  const exactMatch = tasks.find((task) => normalizeText(task.title || "") === normalizedReference);
  if (exactMatch) return exactMatch;

  const containsMatch = tasks.find((task) =>
    normalizeText(task.title || "").includes(normalizedReference) ||
    normalizedReference.includes(normalizeText(task.title || ""))
  );
  if (containsMatch) return containsMatch;

  const referenceTokens = new Set(normalizedReference.split(" ").filter(Boolean));
  let bestMatch = null;
  let bestScore = 0;

  for (const task of tasks) {
    const taskTokens = normalizeText(task.title || "").split(" ").filter(Boolean);
    const score = taskTokens.filter((token) => referenceTokens.has(token)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = task;
    }
  }

  return bestScore >= 2 ? bestMatch : null;
}

function extractDueDate(title) {
  const now = new Date();
  const cleanedTitle = String(title || "");

  if (/\btoday\b/i.test(cleanedTitle)) {
    const due = new Date(now);
    due.setHours(18, 0, 0, 0);
    return {
      dueDate: due.toISOString(),
      cleanedTitle: cleanedTitle.replace(/\b(?:by|for|on)?\s*today\b/gi, "").replace(/\s+/g, " ").trim(),
      dueLabel: "today",
    };
  }

  if (/\btomorrow\b/i.test(cleanedTitle)) {
    const due = new Date(now);
    due.setDate(due.getDate() + 1);
    due.setHours(18, 0, 0, 0);
    return {
      dueDate: due.toISOString(),
      cleanedTitle: cleanedTitle.replace(/\b(?:by|for|on)?\s*tomorrow\b/gi, "").replace(/\s+/g, " ").trim(),
      dueLabel: "tomorrow",
    };
  }

  const dateMatch = cleanedTitle.match(/\b(?:by|on)\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (dateMatch?.[1]) {
    const due = new Date(`${dateMatch[1]}T18:00:00`);
    if (!Number.isNaN(due.getTime())) {
      return {
        dueDate: due.toISOString(),
        cleanedTitle: cleanedTitle.replace(dateMatch[0], "").replace(/\s+/g, " ").trim(),
        dueLabel: dateMatch[1],
      };
    }
  }

  return {
    dueDate: null,
    cleanedTitle: cleanedTitle.trim(),
    dueLabel: null,
  };
}

function detectIntent(transcript) {
  const normalized = normalizeText(transcript);
  const tokens = tokenize(transcript);
  const hasMeetingWord = tokens.some((token) => token.startsWith("meeting"));
  const asksForToday = tokens.includes("today") || tokens.includes("todays") || normalized.includes("today s");
  const asksForMeetings =
    hasMeetingWord &&
    (asksForToday ||
      hasAnyPhrase(normalized, [
        "what are my meetings",
        "what meetings do i have",
        "tell me my meetings",
        "show my meetings",
        "list my meetings",
      ]));

  if (!normalized) return { type: "empty" };

  if (
    normalized === "hello" ||
    normalized === "hi" ||
    normalized === "hey" ||
    normalized === "hello dispatch" ||
    normalized === "hi dispatch" ||
    normalized === "hey dispatch" ||
    normalized.includes("good morning") ||
    normalized.includes("good afternoon") ||
    normalized.includes("good evening")
  ) {
    return { type: "greeting" };
  }

  if (
    normalized.includes("next meeting") ||
    normalized.includes("my next call") ||
    normalized.includes("upcoming meeting")
  ) {
    return { type: "next_meeting" };
  }

  if (
    asksForMeetings ||
    normalized.includes("meetings today") ||
    normalized.includes("today meetings") ||
    normalized.includes("my meetings today") ||
    normalized.includes("today s meetings") ||
    normalized.includes("todays meetings") ||
    normalized.includes("today s meeting") ||
    normalized.includes("todays meeting") ||
    normalized.includes("today meeting") ||
    normalized.includes("today meeting s") ||
    normalized.includes("meeting today") ||
    normalized.includes("meetings for today") ||
    normalized.includes("meeting for today") ||
    normalized.includes("what are my meetings") ||
    normalized.includes("what meetings do i have") ||
    normalized.includes("tell me today s meetings") ||
    normalized.includes("tell me today meeting")
  ) {
    return { type: "meetings_today", limit: extractRequestedCount(transcript) };
  }

  if (
    normalized.includes("what do i have today") ||
    normalized.includes("my schedule today") ||
    normalized.includes("today summary") ||
    normalized.includes("brief my day")
  ) {
    return { type: "day_summary" };
  }

  if (
    normalized.includes("pending approval") ||
    normalized.includes("pending approvals") ||
    normalized.includes("approval pending") ||
    normalized.includes("approvals today")
  ) {
    return { type: "pending_approvals" };
  }

  if (
    normalized.includes("due reminder") ||
    normalized.includes("due reminders") ||
    normalized.includes("my reminders") ||
    normalized.includes("reminders today")
  ) {
    return { type: "due_reminders" };
  }

  if (
    normalized.includes("top priorities") ||
    normalized.includes("my priorities") ||
    normalized.includes("priorities today") ||
    normalized.includes("priority today")
  ) {
    return { type: "priorities" };
  }

  if (
    normalized.includes("agenda") ||
    normalized.includes("meeting agenda") ||
    normalized.includes("agenda for my next meeting")
  ) {
    return { type: "brief_agenda" };
  }

  if (
    normalized.includes("current status") ||
    normalized.includes("project status") ||
    normalized.includes("where do things stand") ||
    normalized.includes("status for my next meeting")
  ) {
    return { type: "brief_status" };
  }

  if (
    normalized.includes("follow up") ||
    normalized.includes("follow ups") ||
    normalized.includes("action items from last meeting") ||
    normalized.includes("pending from last meeting")
  ) {
    return { type: "brief_followups" };
  }

  if (
    normalized.includes("key context") ||
    normalized.includes("background for my meeting") ||
    normalized.includes("meeting context")
  ) {
    return { type: "brief_context" };
  }

  if (
    normalized.includes("pre call brief") ||
    normalized.includes("precall brief") ||
    normalized.includes("free call brief") ||
    normalized.includes("free call") ||
    normalized.includes("brief me for my next meeting") ||
    normalized.includes("what should i know for my next meeting") ||
    normalized.includes("prepare me for my next meeting")
  ) {
    return { type: "brief_summary" };
  }

  if (
    normalized.includes("pre call for") ||
    normalized.includes("precall for") ||
    normalized.includes("free call for") ||
    normalized.includes("pre call about") ||
    normalized.includes("precall about") ||
    normalized.includes("free call about") ||
    normalized.includes("brief for") ||
    normalized.includes("brief me for")
  ) {
    const meetingName = extractMeetingForBrief(transcript);
    if (meetingName) {
      return { type: "brief_for_meeting", meetingName };
    }
    return { type: "brief_summary" };
  }

  if (
    /\b(?:pre.?call|free call)\b/i.test(transcript) &&
    !normalized.includes("pre call brief") &&
    !normalized.includes("precall brief") &&
    !normalized.includes("free call brief")
  ) {
    const meetingName = extractMeetingForBrief(transcript);
    if (meetingName) {
      return { type: "brief_for_meeting", meetingName };
    }
    return { type: "brief_summary" };
  }

  if (
    /^(update|edit|rename|change)\s+(task\s+)?/i.test(transcript)
  ) {
    return { type: "update_task" };
  }

  if (
    /^(remove|delete)\s+(task\s+)?/i.test(transcript)
  ) {
    return { type: "remove_task" };
  }

  if (
    /^(complete|finish|mark done|mark)\s+(task\s+)?/i.test(transcript) ||
    /\b(as done|done|complete|completed)\b/i.test(transcript)
  ) {
    return { type: "complete_task" };
  }

  if (
    normalized.includes("my tasks") ||
    normalized.includes("open tasks") ||
    normalized.includes("pending task") ||
    normalized.includes("pending tasks") ||
    normalized.includes("tasks for today") ||
    normalized.includes("today tasks") ||
    normalized.includes("todays tasks") ||
    normalized.includes("to do") ||
    normalized.includes("todo")
  ) {
    return { type: "tasks" };
  }

  if (
    /^(add|create|make)\s+(a\s+)?task\b/i.test(transcript) ||
    /^remind me to\b/i.test(transcript) ||
    /\badd .+ to(?: my)? tasks?\b/i.test(transcript)
  ) {
    return { type: "create_task" };
  }

  return { type: "unknown" };
}

app.http("voiceCommand", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "voice-command",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken } = extractAuth(req);
      const body = await req.json();
      const transcript = String(body?.transcript || "").trim();
      const timeZone = body?.timeZone || "Asia/Kolkata";
      const dailyContext = body?.dailyContext || {};
      const preCallBrief = body?.preCallBrief || null;
      const preCallMeeting = body?.preCallMeeting || null;

      if (!transcript) {
        return errorResponse("transcript is required", 400);
      }

      const intent = detectIntent(transcript);
      context.log(`[VoiceCommand] Intent ${intent.type} for transcript: ${transcript}`);

      if (intent.type === "empty") {
        return errorResponse("Please say a command.", 400);
      }

      if (intent.type === "create_task") {
        const extracted = extractTaskTitle(transcript);
        const { cleanedTitle, dueDate, dueLabel } = extractDueDate(extracted);

        if (!cleanedTitle) {
          return jsonResponse({
            success: true,
            intent: intent.type,
            answer: "I heard a task command, but I still need the task title.",
            transcript,
          });
        }

        const list = await graphService.getOrCreateDispatchList(accessToken);
        const task = await graphService.createTask(accessToken, list.id, {
          title: cleanedTitle,
          notes: `Created from voice command: ${transcript}`,
          dueDate,
        });

        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: dueLabel
            ? `Done. I added the task ${cleanedTitle}, due ${dueLabel}.`
            : `Done. I added the task ${cleanedTitle}.`,
          task: {
            id: task?.id,
            title: task?.title || cleanedTitle,
            dueDate,
          },
        });
      }

      const [eventsResult, tasksResult, profile, list] = await Promise.all([
        graphService.getTodayEvents(accessToken).catch(() => ({ value: [] })),
        graphService.getDispatchTasks(accessToken).catch(() => ({ value: [] })),
        graphService.getMyProfile(accessToken).catch(() => null),
        graphService.getOrCreateDispatchList(accessToken).catch(() => null),
      ]);

      const events = eventsResult?.value || [];
      const tasks = tasksResult?.value || [];
      const topPriorities = dailyContext?.priorities?.topPriorities || [];
      const pendingApprovalCount = Number(dailyContext?.rawData?.pendingApprovalCount || 0);
      const dueReminders = dailyContext?.rawData?.dueReminders || [];
      const todayKey = getDateKey(new Date(), timeZone);
      const todaysEvents = events.filter((event) => {
        if (!event.start?.dateTime) return false;
        return getDateKey(event.start.dateTime, timeZone) === todayKey;
      });

      if (intent.type === "update_task") {
        const update = extractTaskUpdate(transcript);
        const matchedTask = findTaskMatch(tasks, update?.target || "");
        if (!update?.newTitle) {
          return jsonResponse({
            success: true,
            intent: intent.type,
            transcript,
            answer: "Tell me which task to update and the new title. For example: update task 2 to send launch summary.",
          });
        }
        if (!matchedTask || !list?.id) {
          return jsonResponse({
            success: true,
            intent: intent.type,
            transcript,
            answer: buildTaskNotFoundAnswer("update", tasks),
          });
        }

        await graphService.updateTask(accessToken, list.id, matchedTask.id, {
          title: update.newTitle,
        });

        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: `Done. I updated ${matchedTask.title || "that task"} to ${update.newTitle}.`,
        });
      }

      if (intent.type === "remove_task") {
        const target = extractTaskRemovalTarget(transcript);
        const matchedTask = findTaskMatch(tasks, target);
        if (!matchedTask || !list?.id) {
          return jsonResponse({
            success: true,
            intent: intent.type,
            transcript,
            answer: buildTaskNotFoundAnswer("remove", tasks),
          });
        }

        await graphService.deleteTask(accessToken, list.id, matchedTask.id);

        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: `Done. I removed ${matchedTask.title || "that task"}.`,
        });
      }

      if (intent.type === "complete_task") {
        const target = extractTaskCompletionTarget(transcript);
        const matchedTask = findTaskMatch(tasks, target);
        if (!matchedTask || !list?.id) {
          return jsonResponse({
            success: true,
            intent: intent.type,
            transcript,
            answer: buildTaskNotFoundAnswer("complete", tasks),
          });
        }

        await graphService.updateTask(accessToken, list.id, matchedTask.id, {
          status: "completed",
        });

        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: `Done. I marked ${matchedTask.title || "that task"} as completed.`,
        });
      }

      if (intent.type === "meetings_today") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildMeetingsTodayAnswer(todaysEvents, timeZone, intent.limit),
          meetings: todaysEvents.slice(0, 8).map((event) => ({
            id: event.id,
            subject: event.subject,
            start: event.start?.dateTime,
            attendeeCount: event.attendees?.length || 0,
          })),
        });
      }

      if (intent.type === "next_meeting") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildNextMeetingAnswer(events, timeZone),
        });
      }

      if (intent.type === "tasks") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildTasksAnswer(tasks),
          tasks: tasks.slice(0, 8).map((task) => ({
            id: task.id,
            title: task.title,
            dueDate: task.dueDateTime?.dateTime || null,
          })),
        });
      }

      if (intent.type === "day_summary") {
        const meetingsAnswer = buildMeetingsTodayAnswer(todaysEvents, timeZone);
        const tasksAnswer = buildTasksAnswer(tasks);
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: `${meetingsAnswer} ${tasksAnswer}`,
        });
      }

      if (intent.type === "pending_approvals") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildPendingApprovalsAnswer(pendingApprovalCount),
        });
      }

      if (intent.type === "due_reminders") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildDueRemindersAnswer(dueReminders),
        });
      }

      if (intent.type === "priorities") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildPrioritiesAnswer(topPriorities),
        });
      }

      if (intent.type === "brief_summary") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildBriefSummaryAnswer(preCallBrief, preCallMeeting),
        });
      }

      if (intent.type === "brief_agenda") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildBriefAgendaAnswer(preCallBrief, preCallMeeting),
        });
      }

      if (intent.type === "brief_status") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildBriefStatusAnswer(preCallBrief, preCallMeeting),
        });
      }

      if (intent.type === "brief_context") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildBriefContextAnswer(preCallBrief, preCallMeeting),
        });
      }

      if (intent.type === "brief_followups") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildBriefFollowUpsAnswer(preCallBrief, preCallMeeting),
        });
      }

      if (intent.type === "brief_for_meeting") {
        const meetingName = intent.meetingName;
        const targetMeeting = findMeetingByName(events, meetingName);

        if (!targetMeeting) {
          const meetingList = events.slice(0, 3).map((e) => e.subject || "Untitled").join(", ") || "no meetings";
          return jsonResponse({
            success: true,
            intent: intent.type,
            transcript,
            answer: `I could not find a meeting for "${meetingName}". Today you have ${meetingList}. Please try with the full meeting name.`,
          });
        }

        // Check if the target meeting matches the pre-call meeting we have loaded
        const isSameMeeting = preCallMeeting?.id === targetMeeting.id ||
          (preCallMeeting?.subject && targetMeeting.subject && 
           normalizeText(preCallMeeting.subject) === normalizeText(targetMeeting.subject));

        if (isSameMeeting && preCallBrief && Object.keys(preCallBrief).length > 0) {
          return jsonResponse({
            success: true,
            intent: intent.type,
            transcript,
            answer: buildBriefSummaryAnswer(preCallBrief, targetMeeting),
            meeting: {
              id: targetMeeting.id,
              subject: targetMeeting.subject,
              start: targetMeeting.start?.dateTime,
            },
            brief: preCallBrief,
          });
        }

        // Meeting found but brief not available - provide helpful context
        if (preCallBrief && preCallMeeting?.subject) {
          return jsonResponse({
            success: true,
            intent: intent.type,
            transcript,
            answer: `I found "${targetMeeting.subject}" but I have a detailed pre-call brief ready for your next meeting "${preCallMeeting.subject}". Would you like to hear that instead?`,
            meeting: {
              id: targetMeeting.id,
              subject: targetMeeting.subject,
              start: targetMeeting.start?.dateTime,
            },
          });
        }

        // No brief data available at all
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: `I found the meeting "${targetMeeting.subject}" scheduled for ${formatMeetingTime(targetMeeting.start?.dateTime, timeZone)}. A detailed pre-call brief will be available soon. Try asking about your next meeting for a full brief.`,
          meeting: {
            id: targetMeeting.id,
            subject: targetMeeting.subject,
            time: formatMeetingTime(targetMeeting.start?.dateTime, timeZone),
            start: targetMeeting.start?.dateTime,
          },
        });
      }

      if (intent.type === "greeting") {
        return jsonResponse({
          success: true,
          intent: intent.type,
          transcript,
          answer: buildGreetingAnswer(profile, todaysEvents, tasks, timeZone),
        });
      }

      return jsonResponse({
        success: true,
        intent: intent.type,
        transcript,
        answer: buildUnknownAnswer(transcript, todaysEvents, tasks, timeZone),
      });
    } catch (err) {
      context.error("[VoiceCommand] Error:", err.stack || err.message);
      return errorResponse(err.message);
    }
  },
});
