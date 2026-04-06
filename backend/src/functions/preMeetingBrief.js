const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const openaiService = require("../services/openaiService");
const cosmosService = require("../services/cosmosService");
const jiraService = require("../services/jiraService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

const STOP_WORDS = new Set([
  "with", "from", "this", "that", "have", "will", "been", "your",
  "meeting", "call", "sync", "review", "weekly", "update", "prep",
  "follow", "yesterday", "today", "about", "just", "also", "here",
  "some", "what", "when", "then", "only", "over", "very", "into",
  "more", "were", "they", "them", "their", "would", "could", "please",
  "thanks", "regards", "best", "everyone", "team", "soon", "shortly",
]);

const GENERIC_IDENTITY_TOKENS = new Set(["dispatch", "owner", "user", "mail", "email"]);

const DEMO_MEETING_PROFILES = {
  "website go live final review": {
    tokens: ["payment", "gateway", "checkout", "homepage", "banner", "marketing", "traffic"],
    phrases: ["payment gateway", "homepage banner", "checkout fix"],
  },
  "retail logistics sync": {
    tokens: ["packaging", "retail", "batch", "boxes", "vendor", "contract", "exception", "pallets", "shipment"],
    phrases: ["packaging exception", "retail batch", "standard boxes", "vendor contract"],
  },
  "launch funding compliance sync": {
    tokens: ["compliance", "funds", "investor", "document", "countersigned", "clauses", "approval", "marketing", "clearance"],
    phrases: ["marketing funds", "compliance document", "final clauses", "countersigned compliance"],
  },
  "marketing funding compliance sync": {
    tokens: ["compliance", "funds", "funding", "investor", "document", "countersigned", "clauses", "approval", "marketing", "clearance"],
    phrases: ["marketing funds", "marketing funding", "compliance document", "final clauses", "countersigned compliance"],
  },
};

function normalizeTokens(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function normalizeText(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getMeetingProfile(subject = "") {
  return DEMO_MEETING_PROFILES[normalizeText(subject)];
}

function unique(items = []) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function cleanHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function firstName(text = "") {
  return String(text || "").trim().toLowerCase().split(/\s+/)[0] || "";
}

function toMillis(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function userIdentityHints(userEmail = "") {
  const normalizedEmail = String(userEmail || "").toLowerCase();
  const local = normalizedEmail.split("@")[0] || "";
  const localParts = local.split(/[._-]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  return unique([
    normalizedEmail,
    local,
    ...localParts.filter((part) => part.length > 2 && !GENERIC_IDENTITY_TOKENS.has(part)),
  ]);
}

function emailRecipientAddresses(email = {}) {
  return []
    .concat(email.toRecipients || [])
    .concat(email.ccRecipients || [])
    .map((recipient) => (recipient?.emailAddress?.address || "").toLowerCase())
    .filter(Boolean);
}

function emailFromUser(email, userHints = []) {
  const fromAddress = (email?.from?.emailAddress?.address || "").toLowerCase();
  const fromName = (email?.from?.emailAddress?.name || "").toLowerCase();
  return userHints.some((hint) => {
    if (!hint) return false;
    if (hint.includes("@")) return fromAddress === hint;
    if (hint.includes(".")) return fromAddress.startsWith(`${hint}@`);
    return fromName.includes(hint);
  });
}

function ownerMatchesEmail(owner = "", email = {}) {
  const ownerHint = firstName(owner);
  if (!ownerHint) return false;
  const fromName = (email?.from?.emailAddress?.name || "").toLowerCase();
  const fromAddress = (email?.from?.emailAddress?.address || "").toLowerCase();
  return fromName.includes(ownerHint) || fromAddress.includes(ownerHint);
}

function makeEvidence(owner = "", email = {}) {
  const when = email?.receivedDateTime ? email.receivedDateTime.slice(0, 10) : null;
  const subject = email?.subject || email?.bodyPreview || "(no subject)";
  return when
    ? `${owner} replied on ${when} - "${subject.slice(0, 120)}"`
    : `${owner} replied - "${subject.slice(0, 120)}"`;
}

function issueAssignedToUser(issue = {}, userHints = []) {
  const assigneeEmail = (issue.assigneeEmail || "").toLowerCase();
  const assignee = (issue.assignee || "").toLowerCase();
  return userHints.some((hint) => hint && (assigneeEmail === hint || assignee.includes(hint)));
}

function emailMatchesTokens(email = {}, tokens = []) {
  const emailTokens = normalizeTokens(`${email.subject || ""} ${email.bodyPreview || ""}`);
  return overlapCount(emailTokens, tokens) > 0;
}

function issueMatchScore(text = "", issue = {}) {
  if (!text || !issue) return 0;
  const normalizedText = String(text || "").toLowerCase();
  if (issue.key && normalizedText.includes(String(issue.key).toLowerCase())) return 100;

  const textTokens = normalizeTokens(text);
  const issueTokens = normalizeTokens([
    issue.key,
    issue.title,
    issue.projectLabel,
    issue.spaceName,
    ...(issue.labels || []),
  ].join(" "));

  return overlapCount(textTokens, issueTokens);
}

function findBestIssueMatch(text = "", issues = []) {
  let bestIssue = null;
  let bestScore = 0;

  for (const issue of issues || []) {
    const score = issueMatchScore(text, issue);
    if (score > bestScore) {
      bestScore = score;
      bestIssue = issue;
    }
  }

  return bestScore > 0 ? bestIssue : null;
}

function textHasCompletionSignal(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/(cannot|can't|blocked|blocker|pending|still shows|until|waiting|hold tight)/.test(lower)) {
    return false;
  }
  return /(resolved|fixed|complete|completed|done|finished|tested|processing smoothly|fully wrapped up)/.test(lower);
}

function textHasApprovalSignal(text = "") {
  const lower = String(text || "").toLowerCase();
  return /(approve|approved|approval|sign off|sign-off|countersigned|clearance|review and approve|hit approve)/.test(lower);
}

function textHasPromiseSignal(text = "") {
  const lower = String(text || "").toLowerCase();
  return /(i'll|i will|will approve|will review|reviewing|momentarily|on my screen|i am reviewing|i'm reviewing|will have|on it)/.test(lower);
}

function senderMatchesIssueOwner(issue = {}, email = {}) {
  const senderName = (email.from?.emailAddress?.name || "").toLowerCase();
  const senderAddress = (email.from?.emailAddress?.address || "").toLowerCase();
  const assigneeName = firstName(issue.assignee || "");
  const assigneeEmail = (issue.assigneeEmail || "").toLowerCase();

  if (assigneeEmail && senderAddress === assigneeEmail) return true;
  return assigneeName && (senderName.includes(assigneeName) || senderAddress.includes(assigneeName));
}

function threadKey(email = {}) {
  if (email.conversationId) return email.conversationId;
  return normalizeText(email.subject || "").slice(0, 120) || `email_${email.id || Date.now()}`;
}

function groupEmailsIntoThreads(emails = []) {
  const grouped = new Map();
  for (const email of emails || []) {
    const key = threadKey(email);
    if (!grouped.has(key)) {
      grouped.set(key, {
        threadId: key,
        subject: email.subject || "(no subject)",
        messages: [],
      });
    }
    grouped.get(key).messages.push({
      id: email.id || null,
      date: email.receivedDateTime || null,
      subject: email.subject || "",
      preview: email.bodyPreview || "",
      fromName: email.from?.emailAddress?.name || "",
      fromAddr: (email.from?.emailAddress?.address || "").toLowerCase(),
      raw: email,
    });
  }

  return Array.from(grouped.values())
    .map((thread) => {
      thread.messages.sort((a, b) => toMillis(a.date) - toMillis(b.date));
      return thread;
    })
    .sort((a, b) => {
      const lastA = a.messages[a.messages.length - 1]?.date;
      const lastB = b.messages[b.messages.length - 1]?.date;
      return toMillis(lastB) - toMillis(lastA);
    });
}

function overlapCount(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function scoreEmailForMeeting(email, { attendeeSet, attendeeNames, userHints, eventTokens }) {
  const subject = email.subject || "";
  const preview = email.bodyPreview || "";
  const tokens = normalizeTokens(`${subject} ${preview}`);
  const fromAddress = (email.from?.emailAddress?.address || "").toLowerCase();
  const fromName = (email.from?.emailAddress?.name || "").toLowerCase();
  const recipients = emailRecipientAddresses(email);

  let score = overlapCount(tokens, eventTokens) * 5;

  if (attendeeSet.has(fromAddress)) score += 5;
  if (attendeeNames.some((name) => name && fromName.includes(name))) score += 4;
  if (recipients.some((address) => attendeeSet.has(address))) score += 3;
  if (emailFromUser(email, userHints) && recipients.some((address) => attendeeSet.has(address))) score += 4;
  if ((email.conversationId || "").length > 0) score += 1;

  return score;
}

function threadParticipantStats(thread, attendeeSet = new Set(), userHints = []) {
  const participants = new Set();

  for (const message of thread.messages || []) {
    const fromAddress = (message.raw?.from?.emailAddress?.address || "").toLowerCase();
    if (fromAddress && !userHints.some((hint) => hint && (fromAddress === hint || fromAddress.startsWith(`${hint}@`)))) {
      participants.add(fromAddress);
    }

    for (const address of emailRecipientAddresses(message.raw || {})) {
      if (address && !userHints.some((hint) => hint && (address === hint || address.startsWith(`${hint}@`)))) {
        participants.add(address);
      }
    }
  }

  let coverage = 0;
  let outsiders = 0;
  for (const participant of participants) {
    if (attendeeSet.has(participant)) coverage += 1;
    else outsiders += 1;
  }

  return { coverage, outsiders };
}

function scoreThreadForMeeting(thread, context) {
  let score = 0;
  for (const message of thread.messages || []) {
    score += scoreEmailForMeeting(message.raw || {}, context);
  }

  const subjectTokens = normalizeTokens(thread.subject || "");
  score += overlapCount(subjectTokens, context.eventTokens) * 6;
  const stats = threadParticipantStats(thread, context.attendeeSet, context.userHints);
  score += stats.coverage * 30;
  score -= stats.outsiders * 20;
  score += profileScoreForThread(thread, context.meetingProfile);
  return score;
}

function profileScoreForThread(thread, meetingProfile = null) {
  if (!meetingProfile) return 0;

  const joinedText = [
    thread.subject || "",
    ...(thread.messages || []).flatMap((message) => [message.subject || "", message.preview || ""]),
  ].join(" ").toLowerCase();

  let score = 0;
  for (const phrase of meetingProfile.phrases || []) {
    if (joinedText.includes(phrase)) score += 40;
  }

  const threadTokens = normalizeTokens(joinedText);
  score += overlapCount(threadTokens, meetingProfile.tokens || []) * 12;
  return score;
}

function selectEmailsForPreMeeting({ allEmails = [], event, attendeeEmails = [], userEmail = "" }) {
  const attendeeSet = new Set((attendeeEmails || []).map((email) => String(email || "").toLowerCase()));
  const attendeeNames = (event.attendees || [])
    .map((attendee) => firstName(attendee?.emailAddress?.name || attendee?.emailAddress?.address || ""))
    .filter(Boolean);
  const userHints = userIdentityHints(userEmail);
  const eventTokens = unique(normalizeTokens(`${event.subject || ""} ${cleanHtml(event.body?.content || "")}`));
  const meetingProfile = getMeetingProfile(event.subject || "");
  const threads = groupEmailsIntoThreads(allEmails);

  let scored = threads
    .map((thread) => {
      const stats = threadParticipantStats(thread, attendeeSet, userHints);
      return {
        thread,
        coverage: stats.coverage,
        outsiders: stats.outsiders,
        profileScore: profileScoreForThread(thread, meetingProfile),
        score: scoreThreadForMeeting(thread, { attendeeSet, attendeeNames, userHints, eventTokens, meetingProfile }),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.profileScore !== a.profileScore) return b.profileScore - a.profileScore;
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      if (a.outsiders !== b.outsiders) return a.outsiders - b.outsiders;
      if (b.score !== a.score) return b.score - a.score;
      const lastA = itemLastDate(a.thread);
      const lastB = itemLastDate(b.thread);
      return lastB - lastA;
    });

  if (meetingProfile) {
    const profileMatched = scored.filter((item) => item.profileScore > 0);
    if (profileMatched.length > 0) {
      scored = profileMatched;
    }
  }

  const bestThread = scored.length > 0 ? scored[0].thread : (threads[0] || null);
  const relevantEmails = (bestThread ? bestThread.messages.map((message) => message.raw) : [])
    .sort((a, b) => toMillis(b.receivedDateTime) - toMillis(a.receivedDateTime));

  return {
    thread: bestThread,
    emails: relevantEmails,
    candidateThreads: scored.map((item) => ({
      threadId: item.thread.threadId,
      subject: item.thread.subject,
      coverage: item.coverage,
      outsiders: item.outsiders,
      profileScore: item.profileScore,
      score: item.score,
      messageCount: item.thread.messages.length,
    })),
    eventTokens,
  };
}

function itemLastDate(thread) {
  return toMillis(thread?.messages?.[thread.messages.length - 1]?.date);
}

function buildEmailThreadsForLlm(threads = []) {
  return (threads || []).slice(0, 4).map((thread) => ({
    threadId: thread.threadId,
    subject: thread.subject,
    messagesCount: thread.messages.length,
    conversationLog: thread.messages
      .map((message) => {
        const sender = message.fromName || message.fromAddr || "Unknown";
        const date = message.date ? message.date.slice(0, 16).replace("T", " ") : "unknown";
        const preview = (message.preview || "").replace(/\s+/g, " ").trim();
        return `[${date}] ${sender}: ${preview}`;
      })
      .join("\n"),
  }));
}

function buildDeterministicFollowUps(bestPastMeeting, emails = []) {
  if (!bestPastMeeting) return null;

  const actionItems = (bestPastMeeting.actionItems || []).map((item) => ({ ...item }));
  const normalized = emails || [];

  const enrichedItems = actionItems.map((item) => {
    const taskTokens = normalizeTokens(item.task || "");
    const ownerEmails = normalized.filter((email) => ownerMatchesEmail(item.owner, email));
    let matched = ownerEmails.find((email) => overlapCount(normalizeTokens(`${email.subject || ""} ${email.bodyPreview || ""}`), taskTokens) > 0);
    if (!matched) {
      matched = normalized.find((email) => overlapCount(normalizeTokens(`${email.subject || ""} ${email.bodyPreview || ""}`), taskTokens) > 1);
    }

    return {
      owner: item.owner || "Unknown",
      task: item.task || "Follow up",
      status: matched ? "done" : "pending",
      evidence: matched ? makeEvidence(item.owner || "Owner", matched) : null,
      emailId: matched?.id || null,
      emailSubject: matched?.subject || null,
    };
  });

  const completed = enrichedItems.filter((item) => item.status === "done").length;
  const pending = enrichedItems.filter((item) => item.status === "pending").length;

  let narrative = bestPastMeeting.summary || `The previous meeting "${bestPastMeeting.subject}" assigned follow-up actions.`;
  if (completed > 0 || pending > 0) {
    const parts = [];
    if (completed > 0) parts.push(`${completed} follow-up item(s) show email confirmation`);
    if (pending > 0) parts.push(`${pending} item(s) still look open`);
    narrative = `${narrative} ${parts.join(", ")}.`;
  }

  return {
    date: bestPastMeeting.startTime || bestPastMeeting.savedAt || null,
    subject: bestPastMeeting.subject || null,
    narrative,
    conversationStory: null,
    items: enrichedItems,
    nextMeetingPoints: (bestPastMeeting.plannedForNextMeeting || []).slice(0, 4),
  };
}

function buildPreMeetingChecks({ followUps = null, issues = [], emails = [], userEmail = "" }) {
  const checks = [];
  const userHints = userIdentityHints(userEmail);
  const addedIssueKeys = new Set();

  for (const item of followUps?.items || []) {
    const owner = String(item.owner || "").toLowerCase();
    const ownedByUser = userHints.some((hint) => hint && owner.includes(hint));
    if (ownedByUser && item.status !== "done") {
      checks.push({ text: `You still own "${item.task}" from the previous meeting. Be ready to close it or explain the blocker.` });
    }
  }

  const activeIssues = (issues || []).filter((issue) => !jiraService.isDoneStatus(issue.status));
  const sortedEmails = (emails || []).slice().sort((a, b) => toMillis(b.receivedDateTime) - toMillis(a.receivedDateTime));

  for (const email of sortedEmails) {
    const emailText = email.bodyPreview || `${email.subject || ""} ${email.bodyPreview || ""}`;
    if (!emailText) continue;

    if (textHasCompletionSignal(emailText)) {
      const candidateIssue = findBestIssueMatch(
        emailText,
        activeIssues.filter((issue) => senderMatchesIssueOwner(issue, email))
      );

      if (candidateIssue && !addedIssueKeys.has(candidateIssue.key)) {
        const card = jiraService.buildIssueCard(candidateIssue);
        const assignedToUser = issueAssignedToUser(candidateIssue, userHints);
        checks.push({
          text: assignedToUser
            ? `${candidateIssue.key} sounds complete in the email thread, but Jira still shows it as ${candidateIssue.status}. Update it before the meeting so the team sees the real status.`
            : `${candidateIssue.assignee || "The owner"} said ${candidateIssue.key} may be complete in the email thread, but Jira still shows it as ${candidateIssue.status}. Ask them for a quick update before the meeting so you know what is still pending.`,
          issue: card,
          issues: [card],
        });
        addedIssueKeys.add(candidateIssue.key);
      }
    }

    if (emailFromUser(email, userHints) && (textHasApprovalSignal(emailText) || textHasPromiseSignal(emailText))) {
      const candidateIssue = findBestIssueMatch(
        emailText,
        activeIssues.filter((issue) => issueAssignedToUser(issue, userHints))
      );

      if (candidateIssue && !addedIssueKeys.has(candidateIssue.key)) {
        const card = jiraService.buildIssueCard(candidateIssue);
        checks.push({
          text: `You committed to move ${candidateIssue.key} forward in the thread, but Jira still shows it as ${candidateIssue.status}. Update it before you join.`,
          issue: card,
          issues: [card],
        });
        addedIssueKeys.add(candidateIssue.key);
      }
    }
  }

  return checks.slice(0, 4);
}

function buildAgendaItems(llmBrief = {}, followUps = null, jiraExecutionContext = null, issues=[]) {
  const rawItems = [];

  for (const item of llmBrief.agendaForToday || []) rawItems.push({ text: item });
  for (const item of llmBrief.openPoints || []) rawItems.push({ text: item });
  for (const item of followUps?.nextMeetingPoints || []) rawItems.push({ text: item });
  for (const item of followUps?.items || []) {
    if (item.status === "pending") rawItems.push({ text: `${item.owner} needs to ${String(item.task || "").replace(/^[A-Z]/, (c) => c.toLowerCase())}.` });
  }
  for (const item of jiraExecutionContext?.discussionPoints || []) rawItems.push({ text: item });

  const seen = new Set();
  const agenda = [];
  for (const item of rawItems) {
    const text = String(item?.text || "").trim();
    const key = normalizeText(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);

    const matchedIssue = findBestIssueMatch(text, issues);  // ← add this
    agenda.push({
      text,
      issue: matchedIssue ? jiraService.buildIssueCard(matchedIssue) : null,  // ← and this
    });
    if (agenda.length >= 5) break;
  }
  return agenda;
}

function buildFallbackBrief(event, emails = [], followUps = null, jiraExecutionContext = null) {
  const emailSubjects = unique(emails.map((email) => email.subject).filter(Boolean)).slice(0, 3);
  const pendingItems = (followUps?.items || []).filter((item) => item.status === "pending");
  const completedItems = (followUps?.items || []).filter((item) => item.status === "done");

  let currentStatus = "Recent emails were analyzed to prepare this brief.";
  if (emailSubjects.length > 0) {
    currentStatus = `Recent discussion is centered on ${emailSubjects.join("; ")}.`;
  }

  if (pendingItems.length > 0) {
    currentStatus += ` ${pendingItems.length} follow-up item(s) still appear open.`;
  } else if (completedItems.length > 0) {
    currentStatus += ` ${completedItems.length} follow-up item(s) already show progress in email.`;
  }

  const openPoints = pendingItems.map((item) => `${item.owner} still needs to ${item.task}.`).slice(0, 3);
  if (openPoints.length === 0) {
    openPoints.push(...(jiraExecutionContext?.blockers || []).slice(0, 3));
  }

  return {
    meetingTitle: event.subject || "Upcoming meeting",
    currentStatus,
    followUps,
    openPoints,
    agendaForToday: (followUps?.nextMeetingPoints || []).slice(0, 4),
    keyContext: `This brief was prepared from your upcoming meeting details${emails.length ? ` and ${emails.length} related email(s)` : ""}.`,
  };
}

function buildAssignedToMe(issues = [], effectiveUserEmail = "") {
  const userHints = userIdentityHints(effectiveUserEmail);
  return (issues || [])
    .filter((issue) => issueAssignedToUser(issue, userHints))
    .filter((issue) => jiraService.isActiveStatus(issue.status))
    .slice(0, 5)
    .map((issue) => jiraService.buildIssueCard(issue));
}

app.http("preMeetingBrief", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "pre-meeting-brief",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken, userId, userEmail: tokenEmail } = extractAuth(req);
      const eventId = req.query.get("eventId");

      if (!eventId) return errorResponse("eventId query parameter is required", 400);

      const [event, profile] = await Promise.all([
        graphService.getEvent(accessToken, eventId),
        graphService.getMyProfile(accessToken).catch(() => null),
      ]);

      const effectiveUserEmail = profile?.mail || profile?.userPrincipalName || tokenEmail;
      const attendeeEmails = (event.attendees || []).map((attendee) => attendee.emailAddress?.address).filter(Boolean);

      const [recentEmailsResult, previousMeetings] = await Promise.all([
        graphService.getEmailsFromAttendees(accessToken, attendeeEmails, 200),
        cosmosService.getPreviousMeetings(userId, attendeeEmails, normalizeTokens(event.subject || ""), 1).catch(() => []),
      ]);

      const allEmails = recentEmailsResult?.value || [];
      const selection = selectEmailsForPreMeeting({
        allEmails,
        event,
        attendeeEmails,
        userEmail: effectiveUserEmail,
      });
      const selectedThread = selection.thread;
      const emails = selection.emails;
      const emailThreads = buildEmailThreadsForLlm(selectedThread ? [selectedThread] : []);
      const bestPastMeeting = previousMeetings?.[0] || null;
      const deterministicFollowUps = buildDeterministicFollowUps(bestPastMeeting, emails);

      let jiraResult = {
        executionContext: null,
        issues: [],
        meta: { enabled: false, matchedIssueCount: 0 },
      };

      try {
        jiraResult = await jiraService.buildPreCallExecutionContext({
          event,
          pastMeeting: bestPastMeeting,
          emails,
          emailThread: selectedThread,
          attendeeEmails,
          attendeeNames: (event.attendees || []).map((attendee) => attendee.emailAddress?.name || attendee.emailAddress?.address).filter(Boolean),
          userEmail: effectiveUserEmail,
        });
      } catch (error) {
        context.log(`[PreMeetingBrief] Jira step skipped: ${error.message}`);
      }

      const enrichedEvent = {
        ...event,
        description: cleanHtml(event.body?.content || event.description || ""),
      };

      let llmBrief = null;
      try {
        llmBrief = await openaiService.generatePreCallBrief({
          event: enrichedEvent,
          recentEmails: emails,
          emailThreads,
          pastMeetings: bestPastMeeting ? [{
            subject: bestPastMeeting.subject,
            date: bestPastMeeting.startTime || bestPastMeeting.savedAt || null,
            summary: bestPastMeeting.summary || null,
            transcript: bestPastMeeting.transcript ? bestPastMeeting.transcript.slice(0, 4000) : null,
            actionItems: bestPastMeeting.actionItems || [],
            plannedForNextMeeting: bestPastMeeting.plannedForNextMeeting || [],
          }] : [],
          jiraExecutionContext: jiraResult.executionContext,
        });
      } catch (error) {
        context.log(`[PreMeetingBrief] LLM step skipped: ${error.message}`);
      }

      const finalBrief = llmBrief && typeof llmBrief === "object"
        ? { ...llmBrief }
        : buildFallbackBrief(event, emails, deterministicFollowUps, jiraResult.executionContext);

      if (!finalBrief.followUps && deterministicFollowUps) {
        finalBrief.followUps = deterministicFollowUps;
      }

      if (jiraResult.executionContext) {
        finalBrief.executionContext = {
          title: jiraResult.executionContext.title,
          spaceName: jiraResult.executionContext.spaceName,
          statusLine: jiraResult.executionContext.statusLine,
          blockers: jiraResult.executionContext.blockers || [],
        };
      }

      finalBrief.agenda = buildAgendaItems(finalBrief, finalBrief.followUps, jiraResult.executionContext, jiraResult.issues);      
      finalBrief.agendaForToday = finalBrief.agenda;
      finalBrief.assignedToMe = buildAssignedToMe(jiraResult.issues, effectiveUserEmail);
      finalBrief.preMeetingChecks = buildPreMeetingChecks({
        followUps: finalBrief.followUps,
        issues: jiraResult.issues,
        emails,
        userEmail: effectiveUserEmail,
      });

      try {
        await cosmosService.saveMeetingRecord(userId, eventId, {
          subject: event.subject,
          attendees: attendeeEmails,
          keywords: normalizeTokens(event.subject || ""),
          startTime: event.start?.dateTime || event.start || null,
          briefGenerated: true,
          briefGeneratedAt: new Date().toISOString(),
        });
      } catch (error) {
        context.log(`[PreMeetingBrief] saveMeetingRecord skipped: ${error.message}`);
      }

      return jsonResponse({
        success: true,
        event: {
          id: event.id,
          subject: event.subject,
          start: event.start,
          end: event.end,
          attendees: event.attendees,
          joinUrl: event.onlineMeeting?.joinUrl,
        },
        brief: finalBrief,
        meta: {
          emailsAnalyzed: emails.length,
          previousMeetingsFound: bestPastMeeting ? 1 : 0,
          hasPreviousMeetingContext: Boolean(bestPastMeeting),
          enabled: Boolean(jiraResult.meta?.enabled),
          matchedIssueCount: jiraResult.meta?.matchedIssueCount || 0,
        },
      });
    } catch (error) {
      context.error("[PreMeetingBrief] Error:", error.stack || error.message || error);
      return errorResponse(error.message);
    }
  },
});
