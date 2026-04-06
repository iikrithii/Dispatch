const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const cosmosService = require("../services/cosmosService");
const jiraService = require("../services/jiraService");
const openaiService = require("../services/openaiService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

const DAY_MS = 24 * 60 * 60 * 1000;

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "from", "this", "that",
  "have", "will", "been", "your", "meeting", "call", "sync", "review", "weekly",
  "update", "prep", "follow", "project", "team", "status", "note", "notes",
  "action", "item", "items", "task", "tasks", "today", "tomorrow",
]);

const ASK_PATTERNS = [
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bplease\b/i,
  /\bneed(?:s)? to\b/i,
  /\bshare\b/i,
  /\bsend\b/i,
  /\breview\b/i,
  /\bconfirm\b/i,
  /\bupdate\b/i,
  /\bprepare\b/i,
  /\bfollow[- ]?up\b/i,
  /\bETA\b/i,
];

const WAITING_PATTERN = /\b(waiting on|waiting for|blocked by|blocked on|pending from|held by|need(?:s)? approval|once .+ approves|once .+ reviews|after .+ responds)\b/i;
const BLOCKER_PATTERN = /\b(blocked|blocker|stuck|cannot proceed|can't proceed|on hold)\b/i;
const HIGH_URGENCY_PATTERN = /\b(asap|urgent|immediately|today|eod|end of day|critical|blocker|right away)\b/i;
const MEDIUM_URGENCY_PATTERN = /\b(this week|soon|review|confirm|share|send|follow[- ]?up|before friday|before monday)\b/i;
const MEETING_WORDS_PATTERN = /\b(weekly|daily|monthly|sync|meeting|review|call|standup|stand-up|checkpoint|status|update|prep|follow up|follow-up)\b/gi;

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function toMillis(value) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTokens(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function uniq(values = []) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function overlapScore(text = "", candidate = "") {
  const source = new Set(normalizeTokens(text));
  if (source.size === 0) return 0;
  let score = 0;
  for (const token of normalizeTokens(candidate)) {
    if (source.has(token)) score += 1;
  }
  return score;
}

function compactPreview(text = "", limit = 180) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit).trim()}...`;
}

function cleanProjectLabel(text = "") {
  const raw = String(text || "").replace(/^(re|fwd?):\s*/i, "").trim();
  if (!raw) return "General";

  const segments = raw
    .split(/\s+[|:-]\s+|\s+[|:-]$|^[|:-]\s+/)
    .map((segment) =>
      segment
        .replace(MEETING_WORDS_PATTERN, " ")
        .replace(/\b(action required|follow up|follow-up|reply needed|dispatch|todo|to do)\b/gi, " ")
        .replace(/\s+/g, " ")
        .replace(/^[-:| ]+|[-:| ]+$/g, "")
        .trim()
    )
    .filter(Boolean)
    .sort((a, b) => normalizeTokens(b).length - normalizeTokens(a).length || b.length - a.length);

  const stripped = segments[0] || raw
    .replace(MEETING_WORDS_PATTERN, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-:| ]+|[-:| ]+$/g, "")
    .trim();

  if (normalizeTokens(stripped).length >= 2 && stripped.length >= 4) return stripped;
  return raw;
}

function parseAttendee(attendee) {
  if (!attendee) return null;

  if (typeof attendee === "string") {
    const match = attendee.match(/^(.+?)\s*<(.+?)>$/);
    if (match) {
      return {
        name: match[1].trim(),
        address: match[2].trim().toLowerCase(),
      };
    }

    return {
      name: attendee.trim(),
      address: attendee.includes("@") ? attendee.trim().toLowerCase() : "",
    };
  }

  if (attendee.emailAddress?.address) {
    return {
      name: attendee.emailAddress.name || attendee.emailAddress.address,
      address: String(attendee.emailAddress.address || "").trim().toLowerCase(),
    };
  }

  if (attendee.address || attendee.email) {
    return {
      name: attendee.name || attendee.address || attendee.email,
      address: String(attendee.address || attendee.email || "").trim().toLowerCase(),
    };
  }

  return null;
}

function buildUserHints(profile = {}, fallbackEmail = "") {
  const email = String(profile.mail || profile.userPrincipalName || fallbackEmail || "").trim().toLowerCase();
  const displayName = String(profile.displayName || "").trim().toLowerCase();
  const localPart = email.includes("@") ? email.split("@")[0] : "";
  const firstName = displayName.split(/\s+/)[0] || "";

  return uniq([email, displayName, localPart, firstName]);
}

function matchesUser(value = "", userHints = []) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;

  return (userHints || []).some((hint) => {
    if (!hint) return false;
    if (text === hint) return true;
    if (text.includes(hint)) return true;
    return false;
  });
}

function groupInboxThreads(messages = []) {
  const map = new Map();

  for (const message of messages || []) {
    const key = message.conversationId || message.id;
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        conversationId: key,
        subject: message.subject || "(No subject)",
        latestFrom: message.from?.emailAddress || null,
        latestDate: message.receivedDateTime || null,
        isRead: message.isRead ?? true,
        messageCount: 0,
        bodyPreview: message.bodyPreview || "",
        participantNames: new Set(),
      });
    }

    const thread = map.get(key);
    thread.messageCount += 1;
    const fromName = message.from?.emailAddress?.name || message.from?.emailAddress?.address || "";
    if (fromName) thread.participantNames.add(fromName);

    if (!thread.latestDate || toMillis(message.receivedDateTime) >= toMillis(thread.latestDate)) {
      thread.latestFrom = message.from?.emailAddress || null;
      thread.latestDate = message.receivedDateTime || null;
      thread.subject = message.subject || thread.subject;
      thread.bodyPreview = message.bodyPreview || thread.bodyPreview;
      if (message.isRead === false) thread.isRead = false;
    }
  }

  return Array.from(map.values())
    .map((thread) => ({
      ...thread,
      participantNames: Array.from(thread.participantNames || []),
    }))
    .sort((a, b) => toMillis(b.latestDate) - toMillis(a.latestDate));
}

function threadSearchText(thread = {}) {
  return [
    thread.subject || "",
    thread.bodyPreview || "",
    thread.latestFrom?.name || "",
    thread.latestFrom?.address || "",
  ].join(" ");
}

function meetingSearchText(meeting = {}) {
  return [
    meeting.subject || "",
    meeting.summary || "",
    ...(meeting.keywords || []),
    ...(meeting.actionItems || []).map((item) => `${item.owner || ""} ${item.task || ""}`),
  ].join(" ");
}

function issueSearchText(issue = {}) {
  return [
    issue.key || "",
    issue.title || "",
    issue.projectLabel || "",
    issue.spaceName || "",
    issue.assignee || "",
    issue.status || "",
    ...(issue.labels || []),
  ].join(" ");
}

function pickBestThread({ text = "", preferredConversationId = "", threads = [] }) {
  if (preferredConversationId) {
    const direct = (threads || []).find((thread) => thread.conversationId === preferredConversationId);
    if (direct) return direct;
  }

  let best = null;
  let bestScore = 0;

  for (const thread of threads || []) {
    const score = overlapScore(text, threadSearchText(thread));
    if (score > bestScore) {
      best = thread;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

function pickBestMeeting({ text = "", preferredMeetingId = "", meetings = [] }) {
  if (preferredMeetingId) {
    const direct = (meetings || []).find((meeting) =>
      meeting.meetingId === preferredMeetingId ||
      meeting.id === preferredMeetingId ||
      `meeting_${preferredMeetingId}` === meeting.id
    );
    if (direct) return direct;
  }

  let best = null;
  let bestScore = 0;

  for (const meeting of meetings || []) {
    const score = overlapScore(text, meetingSearchText(meeting));
    if (score > bestScore) {
      best = meeting;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

function pickBestIssue({ text = "", projectName = "", issues = [] }) {
  let best = null;
  let bestScore = 0;

  for (const issue of issues || []) {
    const score =
      overlapScore(text, issueSearchText(issue)) +
      (projectName && overlapScore(projectName, issueSearchText(issue)) > 0 ? 2 : 0);

    if (score > bestScore) {
      best = issue;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

function nextWeekday(baseDate, weekday) {
  const target = new Date(baseDate);
  const delta = (weekday - target.getDay() + 7) % 7 || 7;
  target.setDate(target.getDate() + delta);
  target.setHours(18, 0, 0, 0);
  return target.toISOString();
}

function inferDueDate(text = "", baseIso = null) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const base = baseIso ? new Date(baseIso) : new Date();

  if (!Number.isFinite(base.getTime())) return null;

  const isoMatch = raw.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoMatch) {
    const value = new Date(`${isoMatch[0]}T18:00:00`);
    if (Number.isFinite(value.getTime())) return value.toISOString();
  }

  const longDate = raw.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i);
  if (longDate) {
    const value = new Date(`${longDate[0]} ${base.getFullYear()} 18:00`);
    if (Number.isFinite(value.getTime())) return value.toISOString();
  }

  if (/\b(today|eod|end of day)\b/i.test(lower)) {
    const value = new Date(base);
    value.setHours(18, 0, 0, 0);
    return value.toISOString();
  }

  if (/\btomorrow\b/i.test(lower)) {
    const value = new Date(base.getTime() + DAY_MS);
    value.setHours(18, 0, 0, 0);
    return value.toISOString();
  }

  if (/\bthis week\b/i.test(lower)) {
    const daysUntilFriday = (5 - base.getDay() + 7) % 7;
    const value = new Date(base.getTime() + (daysUntilFriday || 1) * DAY_MS);
    value.setHours(18, 0, 0, 0);
    return value.toISOString();
  }

  for (const [weekdayName, weekdayIndex] of Object.entries(WEEKDAY_INDEX)) {
    if (lower.includes(weekdayName)) return nextWeekday(base, weekdayIndex);
  }

  return null;
}

function inferUrgency(text = "", dueDate = null, fallback = "low") {
  const now = Date.now();
  const dueMs = toMillis(dueDate);

  if (dueMs && dueMs < now) return "high";
  if (dueMs && dueMs - now <= DAY_MS) return "high";
  if (HIGH_URGENCY_PATTERN.test(text)) return "high";
  if (dueMs && dueMs - now <= 7 * DAY_MS) return "medium";
  if (MEDIUM_URGENCY_PATTERN.test(text)) return "medium";
  return fallback;
}

function inferLane({ dueDate = null, blocked = false, waitingOnOthers = false, dependencyUnresolved = false, urgency = "low" }) {
  const now = Date.now();
  const dueMs = toMillis(dueDate);

  if (waitingOnOthers) return "waiting";
  if (blocked || (dueMs && dueMs < now)) return "critical";
  if ((dueMs && dueMs - now <= DAY_MS) || dependencyUnresolved || urgency === "high") return "attention";
  if ((dueMs && dueMs - now <= 7 * DAY_MS) || urgency === "medium") return "watch";
  return "on_track";
}

function compactThread(thread = null) {
  if (!thread) return null;
  return {
    conversationId: thread.conversationId,
    subject: thread.subject || "(No subject)",
    preview: compactPreview(thread.bodyPreview || "", 160),
    latestFrom: thread.latestFrom?.name || thread.latestFrom?.address || "Unknown",
    latestDate: thread.latestDate || null,
    messageCount: thread.messageCount || 0,
    isRead: thread.isRead ?? true,
    participants: uniq([
      ...(thread.participantNames || []),
      thread.latestFrom?.name,
      thread.latestFrom?.address,
    ]).slice(0, 8),
  };
}

function compactMeeting(meeting = null) {
  if (!meeting) return null;
  return {
    id: meeting.id || null,
    meetingId: meeting.meetingId || null,
    subject: meeting.subject || "(Untitled meeting)",
    date: meeting.startTime || meeting.date || meeting.savedAt || null,
    summary: compactPreview(meeting.summary || "", 200),
    attendeeCount: Array.isArray(meeting.attendees) ? meeting.attendees.length : 0,
    attendees: (meeting.attendees || []).slice(0, 8),
    actionItems: (meeting.actionItems || []).slice(0, 6).map((item) => ({
      owner: item.owner || "",
      task: item.task || "",
      status: item.status || "pending",
      deadline: item.deadline || null,
      urgency: item.urgency || null,
    })),
  };
}

function compactIssue(issue = null) {
  if (!issue) return null;
  return {
    key: issue.key || null,
    title: issue.title || null,
    status: issue.status || null,
    assignee: issue.assignee || null,
    priority: issue.priority || null,
    dueDate: issue.dueDate || null,
    url: issue.url || null,
    isBlocked: Boolean(issue.isBlocked),
    projectLabel: issue.projectLabel || issue.spaceName || null,
  };
}

function compactProjectRef(project = null) {
  if (!project) return null;
  return {
    name: project.name || "General",
    summary: project.summary || "",
    priority: project.priority || "medium",
    threadId: project.threadId || null,
    nextMeeting: project.nextMeeting || null,
    nextMeetingId: project.nextMeetingId || null,
    nextMeetingDate: project.nextMeetingDate || null,
  };
}

function compactUpcomingMeeting(event = null) {
  if (!event) return null;
  return {
    id: event.id || null,
    meetingId: event.id || null,
    subject: event.subject || "(Untitled meeting)",
    date: event.start?.dateTime || event.start || null,
    summary: event.bodyPreview ? compactPreview(event.bodyPreview, 200) : null,
    attendeeCount: Array.isArray(event.attendees) ? event.attendees.length : 0,
    attendees: (event.attendees || []).map((attendee) =>
      attendee?.emailAddress?.name ||
      attendee?.emailAddress?.address ||
      attendee?.name ||
      attendee?.email ||
      ""
    ).filter(Boolean),
    isUpcoming: true,
  };
}

function deriveProjectName({ meeting = null, thread = null, issue = null, fallbackText = "" }) {
  const candidates = [
    issue?.projectLabel,
    issue?.spaceName,
    meeting?.subject,
    thread?.subject,
    fallbackText,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const cleaned = cleanProjectLabel(candidate);
    if (cleaned && cleaned !== "General") return cleaned;
  }

  return "General";
}

function scoreProjectForTask(task = {}, project = {}) {
  const seedText = [
    task.title,
    task.description,
    task.contextSnippet,
    task.ownerName,
    task.context?.meeting?.subject,
    task.context?.thread?.subject,
    task.context?.jira?.title,
    task.context?.jira?.projectLabel,
  ].filter(Boolean).join(" ");

  let score = overlapScore(seedText, `${project.name || ""} ${project.summary || ""} ${project.keyTask || ""}`);
  if (task.context?.thread?.conversationId && task.context.thread.conversationId === project.threadId) score += 20;
  if (task.context?.meeting?.meetingId && task.context.meeting.meetingId === project.nextMeetingId) score += 12;
  if (task.context?.meeting?.id && task.context.meeting.id === project.nextMeetingId) score += 12;
  if (task.context?.meeting?.subject && overlapScore(task.context.meeting.subject, project.name || "") > 0) score += 5;
  if (task.context?.thread?.subject && overlapScore(task.context.thread.subject, project.name || "") > 0) score += 4;
  if (task.context?.jira?.projectLabel && overlapScore(task.context.jira.projectLabel, project.name || "") > 0) score += 4;
  return score;
}

function assignProjectsFromSummary(tasks = [], projectSummaries = []) {
  return tasks.map((task) => {
    let best = null;
    let bestScore = 0;

    for (const project of projectSummaries || []) {
      const score = scoreProjectForTask(task, project);
      if (score > bestScore) {
        best = project;
        bestScore = score;
      }
    }

    if (!best || bestScore < 5) {
      return {
        ...task,
        projectName: "General",
        context: {
          ...task.context,
          projectRef: null,
        },
      };
    }

    return {
      ...task,
      projectName: best.name,
      context: {
        ...task.context,
        projectRef: compactProjectRef(best),
      },
    };
  });
}

function buildTaskRecord(input = {}) {
  const textForInference = [
    input.title || "",
    input.description || "",
    input.context?.meeting?.summary || "",
    input.context?.thread?.preview || "",
    input.context?.jira?.title || "",
  ].join(" ");

  const dueDate = input.dueDate || inferDueDate(textForInference, input.referenceDate || input.createdAt || null);
  const urgency = input.urgency || inferUrgency(textForInference, dueDate, input.defaultUrgency || "low");
  const waitingOnOthers = Boolean(input.waitingOnOthers);
  const blocked = Boolean(input.blocked);
  const dependencyUnresolved = Boolean(input.dependencyUnresolved);
  const lane = inferLane({ dueDate, blocked, waitingOnOthers, dependencyUnresolved, urgency });

  return {
    id: input.id,
    sourceKey: input.sourceKey,
    sourceLabel: input.sourceLabel,
    title: input.title,
    description: input.description || "",
    projectName: input.projectName || "General",
    ownerName: input.ownerName || null,
    fromDisplay: input.fromDisplay || input.sourceLabel,
    dueDate: dueDate || null,
    urgency,
    lane,
    blocked,
    waitingOnOthers,
    dependencyUnresolved,
    isMine: Boolean(input.isMine),
    statusText: input.statusText || "Open",
    createdAt: input.createdAt || null,
    contextSnippet: compactPreview(input.contextSnippet || input.description || "", 160),
    context: input.context || {},
  };
}

function emailTaskTitle(thread = {}) {
  const subject = String(thread.subject || "Email follow-up").replace(/^(re|fwd?):\s*/i, "").trim();
  const preview = String(thread.bodyPreview || "").replace(/\s+/g, " ").trim();

  const specificMatch = preview.match(/(?:can you|could you|please|need(?:s)? to)\s+([^.!?]{8,120})/i);
  if (specificMatch?.[1]) {
    return specificMatch[1].replace(/\s+/g, " ").trim().replace(/^[a-z]/, (c) => c.toUpperCase());
  }

  if (thread.isRead === false) return `Respond on: ${subject}`;
  return `Track: ${subject}`;
}

function shouldSurfaceEmailThread(thread = {}) {
  const combined = `${thread.subject || ""} ${thread.bodyPreview || ""}`;
  if (thread.isRead === false) return true;
  if (ASK_PATTERNS.some((pattern) => pattern.test(combined))) return true;
  if (HIGH_URGENCY_PATTERN.test(combined) || MEDIUM_URGENCY_PATTERN.test(combined)) return true;
  return Boolean(inferDueDate(combined, thread.latestDate));
}

function extractMeetingIdFromReminder(reminder = {}) {
  const value = String(reminder.meetingId || "");
  const match = value.match(/^pending_(.+)_\d{10,}$/);
  return match ? match[1] : value || "";
}

function countBy(items = [], field) {
  return (items || []).reduce((acc, item) => {
    const key = item?.[field];
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function canonicalProjectKey(name = "") {
  const tokens = normalizeTokens(cleanProjectLabel(name))
    .filter((token) => !["send", "book", "respond", "track", "microsoft", "todo", "dispatch", "general", "email", "meeting", "jira"].includes(token))
    .slice(0, 4);

  return tokens.join(" ");
}

function makeProjectId(name = "") {
  const canonical = canonicalProjectKey(name);
  if (canonical) return canonical.replace(/\s+/g, "_");

  const fallback = cleanProjectLabel(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return fallback || "general";
}

function pickCanonicalProjectNames(tasks = []) {
  const buckets = new Map();

  for (const task of tasks || []) {
    const label = cleanProjectLabel(task.projectName || "");
    const key = canonicalProjectKey(label) || label.toLowerCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(label);
  }

  const aliasMap = new Map();
  for (const [key, labels] of buckets.entries()) {
    const best = [...labels].sort((a, b) => normalizeTokens(b).length - normalizeTokens(a).length || b.length - a.length)[0] || "General";
    aliasMap.set(key, best);
  }

  return aliasMap;
}

function isProbablyPerson(value = "", currentProject = "") {
  const text = String(value || "").trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  if (["dispatch", "microsoft to do", "jira", "meeting", "email", "general", "you", "unknown"].includes(lower)) return false;
  if (lower === String(currentProject || "").trim().toLowerCase()) return false;
  if (/[A-Z]{2,10}-\d+/.test(text)) return false;
  if (/\b(project|launch|review|sync|status|follow[- ]?up|agenda|action|thread|ticket|issue|roadmap|planning)\b/i.test(text) && !text.includes("@")) return false;
  if (/[0-9]/.test(text) && !text.includes("@")) return false;
  if (text.includes("@")) return true;

  return /^[A-Za-z][A-Za-z.'-]{1,}(?:\s+[A-Za-z][A-Za-z.'-]{1,}){0,3}$/.test(text);
}

function pushPerson(acc = new Map(), candidate = "", role = "", currentProject = "") {
  const parsed = parseAttendee(candidate);
  const label = parsed?.name || parsed?.address || String(candidate || "").trim();
  const address = parsed?.address || "";

  if (!isProbablyPerson(label || address, currentProject)) return acc;

  const key = (address || label).toLowerCase();
  if (!acc.has(key)) {
    acc.set(key, {
      id: key,
      name: label,
      email: address || null,
      roles: [],
    });
  }

  if (role && !acc.get(key).roles.includes(role)) acc.get(key).roles.push(role);
  return acc;
}

function pickRelatedThreads({ task, threads = [], limit = 2 }) {
  const directId = task.context?.thread?.conversationId || task.context?.projectRef?.threadId || "";
  const taskTitle = [task.title, task.description].filter(Boolean).join(" ");
  const projectSeed = [task.projectName, task.context?.projectRef?.summary].filter(Boolean).join(" ");
  const meetingSeed = [
    task.context?.meeting?.subject,
    task.context?.meeting?.summary,
    ...(task.context?.meeting?.actionItems || []).map((item) => `${item.owner || ""} ${item.task || ""}`),
  ].filter(Boolean).join(" ");
  const jiraSeed = [task.context?.jira?.key, task.context?.jira?.title, task.context?.jira?.projectLabel].filter(Boolean).join(" ");
  const contextSeed = [task.contextSnippet, task.fromDisplay].filter(Boolean).join(" ");

  const scored = (threads || [])
    .map((thread) => ({
      thread,
      isDirect: Boolean(directId && thread.conversationId === directId),
      score:
        (directId && thread.conversationId === directId ? 100 : 0) +
        overlapScore(taskTitle, threadSearchText(thread)) * 4 +
        overlapScore(projectSeed, threadSearchText(thread)) * 3 +
        overlapScore(meetingSeed, threadSearchText(thread)) * 3 +
        overlapScore(jiraSeed, threadSearchText(thread)) * 2 +
        overlapScore(contextSeed, threadSearchText(thread)),
    }))
    .filter((item) => item.isDirect || item.score >= 8)
    .sort((a, b) => b.score - a.score || toMillis(b.thread.latestDate) - toMillis(a.thread.latestDate))
    .filter((item, index) => {
      if (index === 0) return true;
      if (item.isDirect) return true;
      return item.score >= 10;
    })
    .slice(0, limit)
    .map((item) => compactThread(item.thread));

  if (scored.length === 0 && task.context?.thread) return [task.context.thread];
  return scored;
}

function collectTaskPeople(task = {}) {
  const map = new Map();
  const projectName = task.projectName || "";

  pushPerson(map, task.ownerName, task.waitingOnOthers ? "owner_blocking" : "owner", projectName);
  pushPerson(map, task.context?.jira?.assignee, "jira_assignee", projectName);

  const threads = uniq([
    ...(task.context?.thread ? [task.context.thread] : []),
    ...(task.context?.threads || []),
  ]);

  for (const thread of threads) {
    pushPerson(map, thread.latestFrom, "thread_participant", projectName);
    for (const participant of thread.participants || []) {
      pushPerson(map, participant, "thread_participant", projectName);
    }
  }

  const meetingAttendees = task.context?.meeting?.attendees || [];
  for (const attendee of meetingAttendees.slice(0, 6)) {
    pushPerson(map, attendee, "meeting_attendee", projectName);
  }

  return Array.from(map.values());
}

function buildTaskPeople(task, meName = "") {
  const people = collectTaskPeople(task)
    .filter((person) => person.name && String(person.name).toLowerCase() !== String(meName || "").toLowerCase())
    .slice(0, 6);

  return people;
}

function buildProjectCatalog(projectSummaries = [], tasks = [], unresolvedIssues = []) {
  const map = new Map();

  for (const project of projectSummaries || []) {
    const key = project.name || "General";
    map.set(key, {
      name: key,
      summary: project.summary || "",
      priority: project.priority || "medium",
      threadId: project.threadId || null,
      nextMeeting: project.nextMeeting || null,
      nextMeetingId: project.nextMeetingId || null,
      status: "on track",
      unresolvedIssues: [],
      keyPeople: [],
      taskIds: [],
    });
  }

  for (const task of tasks || []) {
    const key = task.projectName || "General";
    if (!map.has(key)) {
      map.set(key, {
        name: key,
        summary: "",
        status: "on track",
        unresolvedIssues: [],
        keyPeople: [],
        taskIds: [],
      });
    }

      const entry = map.get(key);
    entry.taskIds.push(task.id);
    const lanes = entry._lanes || [];
    lanes.push(task.lane);
    entry._lanes = lanes;

    const snippets = entry._snippets || [];
    if (task.context?.meeting?.summary) snippets.push(task.context.meeting.summary);
    if (task.context?.threads?.[0]?.preview) snippets.push(task.context.threads[0].preview);
    if (task.contextSnippet) snippets.push(task.contextSnippet);
    entry._snippets = snippets;

    const people = entry._people || [];
    people.push(...collectTaskPeople(task));
    entry._people = people;

    if (!entry.threadId && task.context?.projectRef?.threadId) entry.threadId = task.context.projectRef.threadId;
    if (!entry.nextMeetingId && task.context?.projectRef?.nextMeetingId) entry.nextMeetingId = task.context.projectRef.nextMeetingId;
    if (!entry.nextMeeting && task.context?.projectRef?.nextMeeting) entry.nextMeeting = task.context.projectRef.nextMeeting;
    if (!entry.nextMeetingDate && task.context?.projectRef?.nextMeetingDate) entry.nextMeetingDate = task.context.projectRef.nextMeetingDate;
  }

  for (const issue of unresolvedIssues || []) {
    for (const project of issue.affectedProjects || []) {
      const match = Array.from(map.keys()).find((name) =>
        canonicalProjectKey(name) && canonicalProjectKey(name) === canonicalProjectKey(project)
      );
      if (!match) continue;
      map.get(match).unresolvedIssues.push(issue);
    }
  }

  for (const entry of map.values()) {
    const laneCounts = countBy((entry._lanes || []).map((lane) => ({ lane })), "lane");
    entry.status =
      laneCounts.critical > 0 ? "blocked" :
      laneCounts.attention > 0 ? "at risk" :
      laneCounts.watch > 0 ? "watching" :
      laneCounts.waiting > 0 ? "waiting" :
      "on track";

    const summarySource = entry.summary || (entry._snippets || []).find(Boolean);
    entry.summary = summarySource
      ? compactPreview(summarySource, 220)
      : `${entry.name} has ${entry.taskIds.length} active task${entry.taskIds.length !== 1 ? "s" : ""} in focus right now.`;

    const peopleMap = new Map();
    for (const person of entry._people || []) {
      if (!person?.id) continue;
      if (!peopleMap.has(person.id)) peopleMap.set(person.id, { ...person, impact: 0 });
      peopleMap.get(person.id).impact += 1;
    }
    entry.keyPeople = Array.from(peopleMap.values())
      .sort((a, b) => b.impact - a.impact || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map(({ impact, ...person }) => person);

    delete entry._lanes;
    delete entry._snippets;
    delete entry._people;
  }

  return Object.fromEntries(Array.from(map.entries()));
}

function findRelatedMeeting(task = {}, meetings = [], projectCatalog = {}) {
  if (task.context?.meeting?.subject || task.context?.meeting?.meetingId || task.context?.meeting?.id) {
    return {
      ...task.context.meeting,
      attendees: task.context.meeting.attendees || [],
      actionItems: task.context.meeting.actionItems || [],
    };
  }

  const matchedMeeting = pickBestMeeting({
    text: [
      task.title,
      task.description,
      task.projectName,
      task.contextSnippet,
      task.context?.thread?.subject,
      task.context?.jira?.title,
    ].filter(Boolean).join(" "),
    meetings,
  });

  if (matchedMeeting) return compactMeeting(matchedMeeting);

  const project = projectCatalog[task.projectName];
  if (project?.nextMeeting || project?.nextMeetingId) {
    return compactUpcomingMeeting({
      id: project.nextMeetingId || null,
      subject: project.nextMeeting || `${project.name} meeting`,
      start: project.nextMeetingDate || null,
      attendees: [],
    });
  }

  return null;
}

function enrichTasksForGraph(tasks = [], { threads = [], meetings = [], projectCatalog = {}, meName = "" } = {}) {
  return tasks.map((task) => {
    const relatedThreads = pickRelatedThreads({ task, threads });
    const meeting = findRelatedMeeting(task, meetings, projectCatalog);
    const project = projectCatalog[task.projectName] || null;

    const enriched = {
      ...task,
      context: {
        ...task.context,
        threads: relatedThreads,
        meeting,
        project,
        projectRef: task.context?.projectRef || compactProjectRef(project),
      },
    };

    enriched.context.people = buildTaskPeople(enriched, meName);
    return enriched;
  });
}

async function collectJiraIssues({ userEmail, upcomingEvents = [], meetings = [], threads = [] }) {
  const contexts = [];
  const seenSubjects = new Set();

  for (const event of upcomingEvents.slice(0, 2)) {
    const subjectKey = cleanProjectLabel(event.subject || "");
    if (seenSubjects.has(subjectKey)) continue;
    seenSubjects.add(subjectKey);

    const thread = pickBestThread({ text: `${event.subject || ""} ${event.bodyPreview || ""}`, threads });
    contexts.push({
      event,
      pastMeeting: null,
      emails: [],
      emailThread: thread
        ? {
            subject: thread.subject,
            messages: [{ subject: thread.subject, preview: thread.bodyPreview, date: thread.latestDate }],
          }
        : null,
      attendeeEmails: (event.attendees || []).map((attendee) => attendee.emailAddress?.address).filter(Boolean),
      attendeeNames: (event.attendees || []).map((attendee) => attendee.emailAddress?.name).filter(Boolean),
      userEmail,
    });
  }

  for (const meeting of meetings.slice(0, 3)) {
    const subjectKey = cleanProjectLabel(meeting.subject || "");
    if (seenSubjects.has(subjectKey)) continue;
    seenSubjects.add(subjectKey);

    const normalizedAttendees = (meeting.attendees || []).map(parseAttendee).filter(Boolean);
    const thread = pickBestThread({ text: meetingSearchText(meeting), threads });
    contexts.push({
      event: {
        subject: meeting.subject || "",
        bodyPreview: meeting.summary || "",
        attendees: normalizedAttendees.map((attendee) => ({
          emailAddress: {
            address: attendee.address,
            name: attendee.name,
          },
        })),
      },
      pastMeeting: meeting,
      emails: [],
      emailThread: thread
        ? {
            subject: thread.subject,
            messages: [{ subject: thread.subject, preview: thread.bodyPreview, date: thread.latestDate }],
          }
        : null,
      attendeeEmails: normalizedAttendees.map((attendee) => attendee.address).filter(Boolean),
      attendeeNames: normalizedAttendees.map((attendee) => attendee.name).filter(Boolean),
      userEmail,
    });
  }

  if (contexts.length === 0) return [];

  const results = await Promise.allSettled(
    contexts.map((context) => jiraService.buildPreCallExecutionContext(context))
  );

  const map = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const issue of result.value?.issues || []) {
      if (!issue?.key) continue;
      const existing = map.get(issue.key);
      if (!existing || toMillis(issue.updatedAt) > toMillis(existing.updatedAt)) {
        map.set(issue.key, issue);
      }
    }
  }

  return Array.from(map.values());
}

function buildMeetingActionTasks({ meetings = [], threads = [], issues = [], userHints = [] }) {
  const tasks = [];

  for (const meeting of meetings || []) {
    const baseThread = pickBestThread({ text: meetingSearchText(meeting), threads });

    for (let index = 0; index < (meeting.actionItems || []).length; index += 1) {
      const actionItem = meeting.actionItems[index] || {};
      const issue = pickBestIssue({
        text: `${actionItem.task || ""} ${meeting.subject || ""} ${meeting.summary || ""}`,
        projectName: meeting.subject || "",
        issues,
      });
      const thread = baseThread || pickBestThread({ text: `${actionItem.task || ""} ${meeting.subject || ""}`, threads });
      const projectName = deriveProjectName({ meeting, thread, issue, fallbackText: meeting.subject || actionItem.task || "" });
      const ownerName = actionItem.owner || null;
      const isMine = matchesUser(ownerName, userHints);
      const waitingOnOthers = Boolean(ownerName) && !isMine;
      const description = actionItem.task || "Follow up from meeting";

      tasks.push(buildTaskRecord({
        id: `meeting_action:${meeting.id || meeting.meetingId || "meeting"}:${actionItem.id || index}`,
        sourceKey: "meeting_action_item",
        sourceLabel: "Meeting action item",
        title: description,
        description,
        projectName,
        ownerName,
        fromDisplay: meeting.subject || "Meeting",
        dueDate: actionItem.deadline || issue?.dueDate || null,
        urgency: actionItem.urgency || null,
        waitingOnOthers,
        blocked: Boolean(issue?.isBlocked) || BLOCKER_PATTERN.test(description),
        dependencyUnresolved: WAITING_PATTERN.test(description),
        isMine,
        statusText: actionItem.status || "Pending",
        createdAt: meeting.startTime || meeting.savedAt || null,
        referenceDate: meeting.startTime || meeting.savedAt || null,
        contextSnippet: meeting.summary || description,
        context: {
          meeting: compactMeeting(meeting),
          thread: compactThread(thread),
          jira: compactIssue(issue),
        },
      }));
    }
  }

  return tasks;
}

function buildPendingBatchTasks({ batches = [], meetings = [], threads = [], issues = [], userHints = [], userName = "" }) {
  const tasks = [];

  for (const batch of batches || []) {
    const pendingItems = (batch.items || []).filter((item) => item.status === "pending");
    if (pendingItems.length === 0) continue;

    const meeting = pickBestMeeting({ preferredMeetingId: batch.meetingId, meetings });
    const baseThread = pickBestThread({
      text: `${meeting?.subject || ""} ${pendingItems.map((item) => item.label || "").join(" ")}`,
      threads,
    });

    for (const item of pendingItems) {
      const rawText = [
        item.label || "",
        item.data?.subject || "",
        item.data?.body || "",
        item.data?.commitment || "",
        item.data?.suggestedAgenda || "",
      ].join(" ");

      const issue = pickBestIssue({ text: rawText, projectName: meeting?.subject || "", issues });
      const thread = baseThread || pickBestThread({ text: rawText, threads });
      const projectName = deriveProjectName({ meeting, thread, issue, fallbackText: meeting?.subject || item.label || "" });

      let sourceKey = "pending_follow_up";
      let sourceLabel = "Pending follow-up";
      let title = item.label || "Dispatch follow-up";
      let ownerName = userName || "You";
      let fromDisplay = meeting?.subject || "Dispatch";
      let waitingOnOthers = false;
      let isMine = true;
      let dueDate = null;
      let defaultUrgency = "medium";

      if (item.type === "email") {
        sourceKey = "email_follow_up";
        sourceLabel = "Email follow-up";
        title = item.data?.subject ? `Send: ${item.data.subject}` : (item.label || "Send follow-up email");
        dueDate = inferDueDate(rawText, batch.createdAt || meeting?.startTime || null);
      } else if (item.type === "calendar") {
        sourceKey = "calendar_follow_up";
        sourceLabel = "Follow-up meeting";
        title = item.data?.suggestedAgenda ? `Book: ${item.data.suggestedAgenda}` : (item.label || "Book follow-up meeting");
        dueDate = inferDueDate(item.data?.suggestedTimeframe || rawText, batch.createdAt || meeting?.startTime || null);
      } else if (item.type === "reminder") {
        sourceKey = "soft_commitment";
        sourceLabel = "Soft commitment";
        title = item.data?.commitment || item.label || "Reminder";
        ownerName = item.data?.person || userName || "You";
        isMine = matchesUser(ownerName, userHints);
        waitingOnOthers = Boolean(ownerName) && !isMine;
        dueDate = item.data?.estimatedDeadline || inferDueDate(rawText, batch.createdAt || meeting?.startTime || null);
      } else if (item.type === "task") {
        sourceKey = "dispatch_task";
        sourceLabel = "Dispatch task";
        title = item.data?.title || item.label || "Dispatch task";
        ownerName = item.data?.owner || userName || "You";
        isMine = matchesUser(ownerName, userHints);
        waitingOnOthers = Boolean(ownerName) && !isMine;
        dueDate = item.data?.deadline || inferDueDate(rawText, batch.createdAt || meeting?.startTime || null);
      }

      tasks.push(buildTaskRecord({
        id: `pending:${batch.id}:${item.id}`,
        sourceKey,
        sourceLabel,
        title,
        description: rawText,
        projectName,
        ownerName,
        fromDisplay,
        dueDate: dueDate || issue?.dueDate || null,
        waitingOnOthers,
        blocked: Boolean(issue?.isBlocked) || BLOCKER_PATTERN.test(rawText),
        dependencyUnresolved: WAITING_PATTERN.test(rawText),
        isMine,
        statusText: "Needs approval",
        createdAt: batch.createdAt || meeting?.startTime || null,
        referenceDate: batch.createdAt || meeting?.startTime || null,
        defaultUrgency,
        contextSnippet: rawText || title,
        context: {
          meeting: compactMeeting(meeting),
          thread: compactThread(thread),
          jira: compactIssue(issue),
        },
      }));
    }
  }

  return tasks;
}

function buildReminderTasks({ reminders = [], meetings = [], threads = [], issues = [], userHints = [] }) {
  const tasks = [];

  for (const reminder of reminders || []) {
    const meetingId = extractMeetingIdFromReminder(reminder);
    const meeting = pickBestMeeting({ preferredMeetingId: meetingId, meetings });
    const thread = pickBestThread({ text: `${reminder.text || ""} ${meeting?.subject || ""}`, threads });
    const issue = pickBestIssue({ text: `${reminder.text || ""} ${meeting?.subject || ""}`, projectName: meeting?.subject || "", issues });
    const ownerName = reminder.owner || null;
    const isMine = matchesUser(ownerName, userHints);
    const waitingOnOthers = Boolean(ownerName) && !isMine;
    const projectName = deriveProjectName({ meeting, thread, issue, fallbackText: meeting?.subject || reminder.text || "" });

    tasks.push(buildTaskRecord({
      id: `reminder:${reminder.id}`,
      sourceKey: "soft_commitment",
      sourceLabel: "Soft commitment",
      title: reminder.text || "Reminder",
      description: reminder.text || "",
      projectName,
      ownerName,
      fromDisplay: meeting?.subject || "Reminder",
      dueDate: reminder.dueDate || issue?.dueDate || null,
      waitingOnOthers,
      blocked: Boolean(issue?.isBlocked) || BLOCKER_PATTERN.test(reminder.text || ""),
      dependencyUnresolved: WAITING_PATTERN.test(reminder.text || ""),
      isMine,
      statusText: "Active reminder",
      createdAt: reminder.createdAt || null,
      referenceDate: reminder.createdAt || null,
      defaultUrgency: "medium",
      contextSnippet: reminder.text || "",
      context: {
        meeting: compactMeeting(meeting),
        thread: compactThread(thread),
        jira: compactIssue(issue),
      },
    }));
  }

  return tasks;
}

function buildTodoTasks({ todoTasks = [], meetings = [], threads = [], issues = [], userHints = [], userName = "" }) {
  const tasks = [];

  for (const todo of todoTasks || []) {
    const notes = todo.body?.content || "";
    const combined = `${todo.title || ""} ${notes}`;
    const meeting = pickBestMeeting({ text: combined, meetings });
    const thread = pickBestThread({ text: combined, threads });
    const issue = pickBestIssue({ text: combined, projectName: meeting?.subject || thread?.subject || "", issues });
    const ownerMatch = notes.match(/Owner:\s*([^\n]+)/i);
    const ownerName = ownerMatch?.[1]?.trim() || userName || "You";
    const waitingOnOthers = WAITING_PATTERN.test(combined) && !matchesUser(ownerName, userHints);
    const isMine = !waitingOnOthers;
    const projectName = deriveProjectName({ meeting, thread, issue, fallbackText: thread?.subject || meeting?.subject || todo.title || "" });

    tasks.push(buildTaskRecord({
      id: `todo:${todo.id}`,
      sourceKey: "todo",
      sourceLabel: "Microsoft To Do",
      title: todo.title || "To Do item",
      description: notes || todo.title || "",
      projectName,
      ownerName,
      fromDisplay: "Microsoft To Do",
      dueDate: todo.dueDateTime?.dateTime || issue?.dueDate || null,
      urgency: todo.importance === "high" ? "high" : null,
      waitingOnOthers,
      blocked: Boolean(issue?.isBlocked) || BLOCKER_PATTERN.test(combined),
      dependencyUnresolved: WAITING_PATTERN.test(combined),
      isMine,
      statusText: todo.status || "Open",
      createdAt: todo.createdDateTime || null,
      referenceDate: todo.createdDateTime || null,
      defaultUrgency: todo.importance === "high" ? "high" : "low",
      contextSnippet: notes || todo.title || "",
      context: {
        meeting: compactMeeting(meeting),
        thread: compactThread(thread),
        jira: compactIssue(issue),
      },
    }));
  }

  return tasks;
}

function buildEmailCommitmentTasks({ threads = [], meetings = [], issues = [], userName = "" }) {
  const tasks = [];

  for (const thread of (threads || []).slice(0, 24)) {
    if (!shouldSurfaceEmailThread(thread)) continue;

    const combined = `${thread.subject || ""} ${thread.bodyPreview || ""}`;
    const meeting = pickBestMeeting({ text: combined, meetings });
    const issue = pickBestIssue({ text: combined, projectName: meeting?.subject || thread.subject || "", issues });
    const projectName = deriveProjectName({ meeting, thread, issue, fallbackText: thread.subject || "" });
    const waitingOnOthers = WAITING_PATTERN.test(combined) && thread.isRead !== false;

    tasks.push(buildTaskRecord({
      id: `email:${thread.conversationId}`,
      sourceKey: "email_commitment",
      sourceLabel: "Email commitment",
      title: emailTaskTitle(thread),
      description: thread.bodyPreview || thread.subject || "",
      projectName,
      ownerName: userName || "You",
      fromDisplay: thread.latestFrom?.name || thread.latestFrom?.address || "Email",
      dueDate: issue?.dueDate || inferDueDate(combined, thread.latestDate || null),
      waitingOnOthers,
      blocked: Boolean(issue?.isBlocked) || BLOCKER_PATTERN.test(combined),
      dependencyUnresolved: WAITING_PATTERN.test(combined),
      isMine: !waitingOnOthers,
      statusText: thread.isRead === false ? "Unread" : "Tracking",
      createdAt: thread.latestDate || null,
      referenceDate: thread.latestDate || null,
      defaultUrgency: thread.isRead === false ? "medium" : "low",
      contextSnippet: thread.bodyPreview || thread.subject || "",
      context: {
        meeting: compactMeeting(meeting),
        thread: compactThread(thread),
        jira: compactIssue(issue),
      },
    }));
  }

  return tasks;
}

function buildJiraTasks({ issues = [], meetings = [], threads = [], userHints = [] }) {
  const tasks = [];

  for (const issue of issues || []) {
    const combined = issueSearchText(issue);
    const meeting = pickBestMeeting({ text: combined, meetings });
    const thread = pickBestThread({ text: combined, threads });
    const projectName = deriveProjectName({ meeting, thread, issue, fallbackText: issue.projectLabel || issue.title || "" });
    const ownerName = issue.assignee || null;
    const isMine = matchesUser(issue.assigneeEmail || ownerName, userHints);
    const waitingOnOthers = !isMine && !jiraService.isDoneStatus(issue.status);

    tasks.push(buildTaskRecord({
      id: `jira:${issue.key}`,
      sourceKey: "jira",
      sourceLabel: "Jira",
      title: `${issue.key}: ${issue.title}`,
      description: issue.title || issue.key,
      projectName,
      ownerName,
      fromDisplay: issue.spaceName || issue.projectLabel || "Jira",
      dueDate: issue.dueDate || null,
      urgency: /highest|high/i.test(issue.priority || "") ? "high" : null,
      waitingOnOthers,
      blocked: Boolean(issue.isBlocked),
      dependencyUnresolved: Boolean(issue.isBlocked),
      isMine,
      statusText: issue.status || "Open",
      createdAt: issue.updatedAt || null,
      referenceDate: issue.updatedAt || null,
      defaultUrgency: issue.isBlocked ? "high" : "medium",
      contextSnippet: issue.title || issue.key,
      context: {
        meeting: compactMeeting(meeting),
        thread: compactThread(thread),
        jira: compactIssue(issue),
      },
    }));
  }

  return tasks;
}

function sortTasks(tasks = []) {
  const laneWeight = {
    critical: 0,
    attention: 1,
    watch: 2,
    waiting: 3,
    on_track: 4,
  };

  return [...tasks].sort((a, b) => {
    const laneDiff = (laneWeight[a.lane] ?? 99) - (laneWeight[b.lane] ?? 99);
    if (laneDiff !== 0) return laneDiff;

    const dueA = toMillis(a.dueDate);
    const dueB = toMillis(b.dueDate);
    if (dueA && dueB && dueA !== dueB) return dueA - dueB;
    if (dueA && !dueB) return -1;
    if (!dueA && dueB) return 1;

    return toMillis(b.createdAt) - toMillis(a.createdAt);
  });
}

app.http("getFocusGraph", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "focus-graph",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken, userId, userEmail } = extractAuth(req);
      context.log(`[FocusGraph] Building task-first view for user ${userId}`);

      const [
        profileResult,
        eventsResult,
        todoResult,
        inboxResult,
        pendingResult,
        remindersResult,
        meetingsResult,
      ] = await Promise.allSettled([
        graphService.getMyProfile(accessToken),
        graphService.getTodayEvents(accessToken),
        graphService.getDispatchTasks(accessToken),
        graphService.getRecentInboxMessages(accessToken, 60),
        cosmosService.getPendingItems(userId),
        cosmosService.getActiveReminders(userId),
        cosmosService.getRecentMeetingRecords(userId, 30),
      ]);

      const profile =
        profileResult.status === "fulfilled"
          ? profileResult.value
          : { displayName: "", mail: userEmail, userPrincipalName: userEmail };

      const upcomingEvents =
        eventsResult.status === "fulfilled"
          ? (eventsResult.value.value || []).slice(0, 8)
          : [];

      const todoTasks =
        todoResult.status === "fulfilled"
          ? (todoResult.value.value || []).slice(0, 20)
          : [];

      const inboxMessages =
        inboxResult.status === "fulfilled"
          ? (inboxResult.value.value || []).slice(0, 60)
          : [];

      const pendingBatches =
        pendingResult.status === "fulfilled"
          ? pendingResult.value || []
          : [];

      const reminders =
        remindersResult.status === "fulfilled"
          ? remindersResult.value || []
          : [];

      const recentMeetings =
        meetingsResult.status === "fulfilled"
          ? (meetingsResult.value || []).filter((meeting) =>
              meeting?.subject || meeting?.summary || (meeting?.actionItems || []).length > 0
            )
          : [];

      const threads = groupInboxThreads(inboxMessages);
      const userHints = buildUserHints(profile, userEmail);
      const userName = profile.displayName || profile.mail || profile.userPrincipalName || userEmail || "You";

      let projectSummaries = [];
      try {
        const summaryInputThreads = threads.slice(0, 25).map((thread) => ({
          conversationId: thread.conversationId,
          subject: thread.subject,
          participantNames: thread.participantNames || [],
          latestDate: thread.latestDate,
          bodyPreview: thread.bodyPreview,
        }));
        const summaryInputEvents = upcomingEvents.map((event) => ({
          id: event.id,
          subject: event.subject,
          start: event.start?.dateTime || event.start || null,
          attendees: (event.attendees || []).map((attendee) =>
            attendee?.emailAddress?.name ||
            attendee?.emailAddress?.address ||
            attendee?.name ||
            attendee?.email ||
            ""
          ).filter(Boolean),
        }));

        const projectSummaryResult = await openaiService.generateProjectsSummary(summaryInputThreads, summaryInputEvents);
        const eventById = new Map(upcomingEvents.map((event) => [event.id, event]));
        projectSummaries = (projectSummaryResult.projects || []).map((project) => {
          const event = eventById.get(project.nextMeetingId);
          return {
            ...project,
            nextMeetingDate: event?.start?.dateTime || event?.start || null,
          };
        });
      } catch (projectSummaryError) {
        context.log(`[FocusGraph] Project summary fallback: ${projectSummaryError.message}`);
        projectSummaries = [];
      }

      let issues = [];
      try {
        issues = await collectJiraIssues({
          userEmail,
          upcomingEvents,
          meetings: recentMeetings,
          threads,
        });
      } catch (jiraError) {
        context.log(`[FocusGraph] Jira skipped: ${jiraError.message}`);
        issues = [];
      }

      let unresolvedIssues = [];
      try {
        const richMeetings = recentMeetings.filter(
          (meeting) => meeting.summary || (meeting.actionItems && meeting.actionItems.length > 0) || meeting.transcript
        );
        if (richMeetings.length >= 2) {
          const unresolvedResult = await openaiService.detectUnresolvedIssues(richMeetings.slice(0, 10));
          unresolvedIssues = unresolvedResult.issues || [];
        }
      } catch (unresolvedError) {
        context.log(`[FocusGraph] Unresolved analysis skipped: ${unresolvedError.message}`);
        unresolvedIssues = [];
      }

      const rawTasks = sortTasks([
        ...buildMeetingActionTasks({ meetings: recentMeetings, threads, issues, userHints }),
        ...buildPendingBatchTasks({ batches: pendingBatches, meetings: recentMeetings, threads, issues, userHints, userName }),
        ...buildReminderTasks({ reminders, meetings: recentMeetings, threads, issues, userHints }),
        ...buildTodoTasks({ todoTasks, meetings: recentMeetings, threads, issues, userHints, userName }),
        ...buildEmailCommitmentTasks({ threads, meetings: recentMeetings, issues, userName }),
        ...buildJiraTasks({ issues, meetings: recentMeetings, threads, userHints }),
      ]).slice(0, 80);

      const summaryMappedTasks = projectSummaries.length > 0
        ? assignProjectsFromSummary(rawTasks, projectSummaries)
        : rawTasks;

      const canonicalNames = pickCanonicalProjectNames(summaryMappedTasks);
      const remappedTasks = summaryMappedTasks.map((task) => {
        if (task.context?.projectRef?.name) {
          return { ...task, projectName: task.context.projectRef.name };
        }
        const key = canonicalProjectKey(task.projectName || "") || String(task.projectName || "").toLowerCase();
        const projectName = canonicalNames.get(key) || task.projectName || "General";
        return { ...task, projectName };
      });

      const projectCatalog = buildProjectCatalog(projectSummaries, remappedTasks, unresolvedIssues);
      const tasks = enrichTasksForGraph(remappedTasks, {
        threads,
        meetings: recentMeetings,
        projectCatalog,
        meName: userName,
      }).map((task) => {
        const projectName = task.projectName || "General";
        const projectId = makeProjectId(projectName);
        const project = task.context?.project
          ? { ...task.context.project, id: makeProjectId(task.context.project.name || projectName) }
          : null;
        const projectRef = task.context?.projectRef
          ? { ...task.context.projectRef, id: makeProjectId(task.context.projectRef.name || projectName) }
          : null;

        return {
          ...task,
          projectId,
          context: {
            ...task.context,
            project,
            projectRef,
          },
        };
      });

      const people = uniq(
        tasks.flatMap((task) => (task.context?.people || []).map((person) => person.name)).filter(Boolean)
      ).sort((a, b) => a.localeCompare(b));

      const projectOptions = Object.values(projectCatalog || {})
        .filter((project) => project?.name && project.name !== "General")
        .map((project) => {
          const projectTasks = tasks.filter((task) => task.projectName === project.name);
          return {
            id: makeProjectId(project.name),
            name: project.name,
            status: project.status || "on track",
            summary: project.summary || "",
            threadId: project.threadId || null,
            nextMeetingId: project.nextMeetingId || null,
            counts: {
              tasks: projectTasks.length,
              people: uniq(projectTasks.flatMap((task) => (task.context?.people || []).map((person) => person.name))).length,
            },
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const projects = projectOptions.map((project) => project.name);
      const sources = uniq(tasks.map((task) => task.sourceLabel).filter(Boolean)).sort((a, b) => a.localeCompare(b));

      return jsonResponse({
        success: true,
        tasks,
        meta: {
          generatedAt: new Date().toISOString(),
          me: {
            name: userName,
            email: profile.mail || profile.userPrincipalName || userEmail || "",
          },
          counts: {
            total: tasks.length,
            byLane: countBy(tasks, "lane"),
            bySource: countBy(tasks, "sourceKey"),
          },
          projects: projectCatalog,
          projectOptions,
          filters: {
            projects,
            people,
            sources,
            urgencies: ["high", "medium", "low"],
          },
        },
      });
    } catch (err) {
      context.error("[FocusGraph] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});
