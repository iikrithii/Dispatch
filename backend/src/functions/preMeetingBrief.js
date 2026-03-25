// functions/preMeetingBrief.js
const { app } = require("@azure/functions");
const graphService   = require("../services/graphService");
const openaiService  = require("../services/openaiService");
const cosmosService  = require("../services/cosmosService");
const jiraService    = require("../services/jiraService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "with","from","this","that","have","will","been","your",
  "meeting","call","sync","review","weekly","update","prep",
  "follow","yesterday","today","about","just","also","here",
  "some","what","when","then","only","over","very","into",
  "more","were","they","them","their","would","could",
]);

function normalizeTokens(text = "") {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

function normalizeText(text = "") {
  return (text || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function toMillis(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function firstName(str = "") {
  return (str || "").toLowerCase().split(/\s+/)[0] || "";
}

function ownerMatchesEmail(owner = "", email) {
  if (!owner || !email) return false;
  const ownerLow = firstName(owner);
  const fromName = (email.from?.emailAddress?.name || "").toLowerCase();
  const fromAddr = (email.from?.emailAddress?.address || "").toLowerCase();
  return (fromName && fromName.includes(ownerLow)) || (fromAddr && fromAddr.includes(ownerLow));
}

function emailMatchesTokens(email, tokens = []) {
  if (!email || !tokens || tokens.length === 0) return false;
  const subject = (email.subject || "").toLowerCase();
  const preview = (email.bodyPreview || "").toLowerCase();
  const t = normalizeTokens(subject + " " + preview);
  return tokens.some((tok) => t.includes(tok));
}

function makeEvidence(owner, email) {
  if (!email) return null;
  const when = email.receivedDateTime ? email.receivedDateTime.slice(0, 10) : null;
  const subj = email.subject || email.bodyPreview || "(no subject)";
  if (when) return `${owner} replied on ${when} — "${subj.slice(0, 120)}"`;
  return `${owner} replied — "${subj.slice(0, 120)}"`;
}

function emailRecipientAddresses(email = {}) {
  return []
    .concat(email.toRecipients || [])
    .concat(email.ccRecipients || [])
    .map((r) => (r?.emailAddress?.address || "").toLowerCase())
    .filter(Boolean);
}

function userIdentityHints(userEmail = "") {
  const local = (userEmail || "").split("@")[0] || "";
  const localParts = local.replace(/[._-]+/g, " ").trim();
  return Array.from(new Set(
    [userEmail.toLowerCase(), local.toLowerCase(), localParts.toLowerCase(), firstName(localParts)]
      .concat(localParts.split(/\s+/).map((p) => (p || "").toLowerCase()))
      .filter(Boolean)
  ));
}

function emailFromUser(email, hints = []) {
  const fromAddress = (email.from?.emailAddress?.address || "").toLowerCase();
  const fromName    = (email.from?.emailAddress?.name    || "").toLowerCase();
  return hints.some((hint) => {
    if (!hint) return false;
    return fromAddress === hint || fromAddress.includes(hint) || fromName.includes(hint);
  });
}

function ownerMatchesUser(owner = "", hints = []) {
  const ownerLower = (owner || "").toLowerCase();
  return hints.some((hint) => hint && ownerLower.includes(hint));
}

function textHasCommitmentSignal(text = "") {
  const lower = (text || "").toLowerCase();
  return (
    /\bi\b/.test(lower) &&
    /(i'll|i will|i have|i've|i can|i finalized|i confirmed|i updated|i shared|i sent|i added|i completed|i finished)/.test(lower)
  ) || /(completed|finalized|confirmed|shared|sent|updated|added the comment|left a comment)/.test(lower);
}

function textHasAskSignal(text = "") {
  const lower = (text || "").toLowerCase();
  return /(can you|could you|please|need you|let me know|confirm|share|send|review|take this|pick this up|follow up)/.test(lower);
}

function textHasPromiseSignal(text = "") {
  const lower = (text || "").toLowerCase();
  return /(i'll|i will|will do|i can take|i can do|i'm on it|on it|will send|will update|will confirm|i'll handle|i'll take|i can own)/.test(lower);
}

function textHasCompletionSignal(text = "") {
  const lower = (text || "").toLowerCase();
  return /(done|complete|completed|finish|finished|finalized|confirmed|shipped|ready)/.test(lower);
}

function textHasCommentSignal(text = "") {
  const lower = (text || "").toLowerCase();
  return /(comment|note|update jira|update the issue|leave the note|leave a note|leave a comment|add the comment|add a comment)/.test(lower);
}

function textHasOwnerSignal(text = "") {
  const lower = (text || "").toLowerCase();
  return /(assign|owner|handoff|hand off|reassign|take this|own this|pick this up)/.test(lower);
}

function issueMatchScore(text = "", issue = {}) {
  if (!text || !issue) return 0;
  const lower = (text || "").toLowerCase();
  if (issue.key && lower.includes(issue.key.toLowerCase())) return 100;
  const textTokens  = normalizeTokens(text);
  const issueTokens = normalizeTokens([issue.key, issue.title, issue.projectLabel, issue.spaceName, ...(issue.labels || [])].join(" "));
  return textTokens.filter((token) => issueTokens.includes(token)).length;
}

function findBestIssueMatch(text, issues = []) {
  let best = null;
  let bestScore = 0;
  for (const issue of issues) {
    const score = issueMatchScore(text, issue);
    if (score > bestScore) { best = issue; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

function isGenericDiscussionText(text = "") {
  const lower = (text || "").toLowerCase();
  return lower.includes("review the remaining open jira items") ||
         lower.includes("leave the meeting with a clear owner");
}

function pickPreferredText(current, next) {
  if (!current) return next;
  if (!next) return current;
  if (isGenericDiscussionText(current.text) && !isGenericDiscussionText(next.text)) return next;
  if (next.text.length > current.text.length + 12) return next;
  return current;
}

function uniqueIssues(issueList = []) {
  const seen = new Set();
  return (issueList || []).filter((issue) => {
    const key = issue?.key;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function issueAssignedToUser(issue, hints = []) {
  const assigneeEmail = (issue.assigneeEmail || "").toLowerCase();
  const assignee      = (issue.assignee || "").toLowerCase();
  return hints.some((hint) => {
    if (!hint) return false;
    return assigneeEmail === hint || assignee.includes(hint);
  });
}

function emailMentionsIssueKey(email, issue) {
  const text  = `${email?.subject || ""} ${email?.bodyPreview || ""}`;
  const lower = text.toLowerCase();
  return Boolean(issue?.key && lower.includes(issue.key.toLowerCase()));
}

function emailExplanationScore(email, issue) {
  const text  = `${email?.subject || ""} ${email?.bodyPreview || ""}`;
  const lower = text.toLowerCase();
  let score = 0;
  if (issue?.key && lower.includes(issue.key.toLowerCase())) score += 10;
  if (textHasCompletionSignal(text)) score += 6;
  if (textHasCommentSignal(text))    score += 5;
  if (textHasOwnerSignal(text))      score += 4;
  if (textHasCommitmentSignal(text)) score += 3;
  const titleTokens = normalizeTokens(issue?.title || "");
  const textTokens  = normalizeTokens(text);
  score += titleTokens.filter((t) => textTokens.includes(t)).length;
  return score;
}

function latestRelevantUserEmail(issue, emails = [], userHints = []) {
  let best = null; let bestScore = -1; let bestMs = 0;
  for (const email of emails) {
    if (!emailFromUser(email, userHints)) continue;
    if (!emailMentionsIssueKey(email, issue)) continue;
    const score = emailExplanationScore(email, issue);
    const ms    = toMillis(email.receivedDateTime);
    if (score > bestScore || (score === bestScore && ms && ms > bestMs)) {
      best = email; bestScore = score; bestMs = ms;
    }
  }
  return best;
}

function issueStateLabel(issue = {}) {
  const status = issue?.status || "open";
  return status === "Unknown" ? "open" : status;
}

function buildStaleIssueActionText(issue, emailText = "") {
  const key   = issue?.key || "This issue";
  const lower = (emailText || "").toLowerCase();
  if (textHasOwnerSignal(lower)) {
    if (issue.assignee === "Unassigned")
      return `${key} is still unassigned in Jira. If ownership changed, assign it before the call so the team has a clear owner.`;
    return `${key} still shows ${issue.assignee} as the owner in Jira. If you already handed it off, update the assignee before the meeting.`;
  }
  if (textHasCommentSignal(lower))
    return `You said you'd leave an update on ${key}, but Jira still looks unchanged. Add the note before the meeting so everyone sees the latest context.`;
  if (textHasCompletionSignal(lower))
    return `You said ${key} was complete, but Jira still shows it as ${issueStateLabel(issue)}. Mark it done or update the status before the meeting.`;
  return `${key} still looks stale in Jira compared with your latest email. Update the issue before the meeting so the team is working from the same picture.`;
}

function getStaleIssueCategory(issue, emailText = "") {
  const lower = (emailText || "").toLowerCase();
  if (textHasOwnerSignal(lower)) return "owner";
  if (textHasCommentSignal(lower)) return "comment";
  if (textHasCompletionSignal(lower) && !jiraService.isDoneStatus(issue?.status)) return "completion";
  return "stale";
}

function emailMatchesIssueOrTask(email, issue, task = "") {
  const text = `${email?.subject || ""} ${email?.bodyPreview || ""}`;
  if (issue && findBestIssueMatch(text, [issue])) return true;
  const taskTokens = normalizeTokens(task || "");
  if (taskTokens.length === 0) return false;
  return taskTokens.some((token) => normalizeTokens(text).includes(token));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section builders
// ─────────────────────────────────────────────────────────────────────────────

function createSectionItems(rawItems = [], issues = []) {
  const grouped = new Map();
  for (const item of rawItems) {
    if (!item || !item.text) continue;
    const text  = item.text.trim();
    if (!text) continue;
    const issue = item.issue || findBestIssueMatch(text, issues);
    const key   = issue?.key || normalizeText(text);
    const prev  = grouped.get(key);
    grouped.set(key, pickPreferredText(prev, { ...item, text, issue }));
  }
  return Array.from(grouped.values())
    .map((item) => ({ text: item.text, issue: item.issue ? jiraService.buildIssueCard(item.issue) : null }))
    .slice(0, 5);
}

function buildGroupedCheckText(category, groupedIssues = [], fallbackText = "") {
  const count = groupedIssues.length;
  if (count <= 1) return fallbackText;
  if (category === "completion") return "You said these issues were complete, but Jira still shows them as open. Mark them done or update their status before the meeting.";
  if (category === "comment")    return "You said you'd leave Jira updates on these issues, but they still look unchanged. Add the notes before the meeting so everyone sees the latest context.";
  if (category === "owner")      return "These issues still show stale ownership in Jira. Update the assignee before the meeting if ownership changed.";
  if (category === "delegated")  return "A few items you asked others to handle still look open in Jira. Be ready to check on them in the meeting.";
  return fallbackText;
}

function createGroupedCheckItems(rawItems = []) {
  const grouped = new Map();
  for (const item of rawItems) {
    if (!item || !item.text) continue;
    const key = item.category || normalizeText(item.text);
    if (!grouped.has(key)) grouped.set(key, { text: item.text.trim(), category: item.category || null, issues: [] });
    const group = grouped.get(key);
    if (item.issue) group.issues.push(item.issue);
  }
  return Array.from(grouped.values())
    .map((group) => {
      const issues = uniqueIssues(group.issues).slice(0, 4);
      return {
        text:   buildGroupedCheckText(group.category, issues, group.text),
        issues: issues.map((issue) => jiraService.buildIssueCard(issue)),
        issue:  issues.length === 1 ? jiraService.buildIssueCard(issues[0]) : null,
      };
    })
    .slice(0, 4);
}

function filterRedundantList(items = [], references = []) {
  const refTexts = references.map((item) => item.text || "");
  return (items || []).filter((item) => {
    const norm       = normalizeText(item);
    const itemTokens = normalizeTokens(item);
    return !refTexts.some((ref) => {
      if (normalizeText(ref) === norm) return true;
      const refTokens = normalizeTokens(ref);
      const overlap   = itemTokens.filter((token) => refTokens.includes(token)).length;
      return overlap >= Math.min(3, itemTokens.length);
    });
  });
}

function buildPreMeetingChecks({ followUps, issues, emails, userEmail, logger }) {
  const checks    = [];
  const userHints = userIdentityHints(userEmail);
  const log       = typeof logger === "function" ? logger : () => {};

  log(`[PreMeetingBrief] preMeetingChecks: issues=${issues.length} emails=${(emails || []).length} followUpItems=${(followUps?.items || []).length}`);

  for (const item of followUps?.items || []) {
    const issue      = findBestIssueMatch(`${item.task} ${item.evidence || ""}`, issues);
    const ownedByUser =
      ownerMatchesUser(item.owner, userHints) ||
      (issue && issueAssignedToUser(issue, userHints));

    if (item.status === "done" && ownedByUser && issue && !jiraService.isDoneStatus(issue.status)) {
      checks.push({ text: `${issue.key} still shows ${issue.status} in Jira, but your mail trail suggests "${item.task}" may already be done. Update it before the call if that work is actually complete.`, category: "completion", issue });
    }

    if (item.status === "pending" && !ownedByUser && issue) {
      const relevantEmails = (emails || []).filter((email) => emailMatchesIssueOrTask(email, issue, item.task));
      const userAsk        = relevantEmails.find((email) => emailFromUser(email, userHints) && textHasAskSignal(`${email.subject || ""} ${email.bodyPreview || ""}`));
      const ownerPromise   = relevantEmails.find((email) => !emailFromUser(email, userHints) && ownerMatchesEmail(item.owner, email) && textHasPromiseSignal(`${email.subject || ""} ${email.bodyPreview || ""}`));
      if (userAsk && ownerPromise && !jiraService.isDoneStatus(issue.status)) {
        checks.push({ text: `You asked ${item.owner} to handle "${item.task}", and they acknowledged it, but ${issue.key} still looks open in Jira. Be ready to check on it in the meeting.`, category: "delegated", issue });
      }
    }
  }

  for (const issue of issues) {
    const latestUserEmail = latestRelevantUserEmail(issue, emails, userHints);
    if (latestUserEmail) {
      const userEmailText   = `${latestUserEmail.subject || ""} ${latestUserEmail.bodyPreview || ""}`;
      const emailMs         = toMillis(latestUserEmail.receivedDateTime);
      const issueMs         = toMillis(issue.latestCommentAt || issue.updatedAt);
      const issueOwnedByUser      = issueAssignedToUser(issue, userHints);
      const explicitlyReferenced  = emailMentionsIssueKey(latestUserEmail, issue);
      if (issueOwnedByUser && explicitlyReferenced && textHasCommitmentSignal(userEmailText) && emailMs && issueMs && emailMs > issueMs + 5 * 60 * 1000 && !jiraService.isDoneStatus(issue.status)) {
        checks.push({ text: buildStaleIssueActionText(issue, userEmailText), category: getStaleIssueCategory(issue, userEmailText), issue });
      }
    }

    const issueEmailText = [latestUserEmail?.subject, latestUserEmail?.bodyPreview].join(" ").toLowerCase();
    if (latestUserEmail && emailMentionsIssueKey(latestUserEmail, issue) && textHasOwnerSignal(issueEmailText) && (issue.assignee === "Unassigned" || issueAssignedToUser(issue, userHints))) {
      checks.push({ text: buildStaleIssueActionText(issue, issueEmailText), category: "owner", issue });
    }
  }

  const filteredChecks = checks.filter((check) => {
    if (check.category === "delegated") return true;
    if (!check.issue) return false;
    if (issueAssignedToUser(check.issue, userHints)) return true;
    return check.category === "owner" && check.issue.assignee === "Unassigned";
  });

  return createGroupedCheckItems(filteredChecks);
}

function buildDiscussionItems({ llmBrief, followUps, executionContext, issues }) {
  const rawItems = [];
  for (const text of executionContext?.discussionPoints || []) rawItems.push({ text, source: "jira" });
  for (const text of followUps?.nextMeetingPoints || [])         rawItems.push({ text, source: "meeting" });
  for (const item of followUps?.items || []) {
    if (item.status === "pending") {
      rawItems.push({ text: `${item.owner} still needs to ${item.task.charAt(0).toLowerCase()}${item.task.slice(1)}.`, source: "followUp" });
    }
  }
  for (const text of llmBrief?.openPoints || []) rawItems.push({ text, source: "email" });
  return createSectionItems(rawItems, issues).slice(0, 4);
}

function buildAssignedToMe(issues = [], userEmail = "") {
  const userHints = userIdentityHints(userEmail);
  return issues
    .filter((issue) => issueAssignedToUser(issue, userHints))
    .filter((issue) => jiraService.isActiveStatus(issue.status))
    .slice(0, 5)
    .map((issue) => jiraService.buildIssueCard(issue));
}

function groupEmailsIntoThreads(emails = []) {
  const threads = new Map();
  for (const e of emails) {
    const conv    = e.conversationId || "";
    const subjKey = (e.subject || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().slice(0, 80) || "__nosubj__";
    const key     = conv || subjKey;
    if (!threads.has(key)) {
      threads.set(key, { threadId: key, subject: e.subject || "(no subject)", messages: [] });
    }
    threads.get(key).messages.push({
      id: e.id || null,
      fromName: (e.from?.emailAddress?.name || "").trim(),
      fromAddr: (e.from?.emailAddress?.address || "").toLowerCase(),
      date:    e.receivedDateTime || e.createdDateTime || null,
      subject: e.subject || "",
      preview: e.bodyPreview || "",
      raw: e,
    });
  }
  const out = Array.from(threads.values()).map((t) => {
    t.messages.sort((a, b) => {
      if (!a.date) return 1; if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    });
    return t;
  });
  out.sort((a, b) => {
    const la = a.messages[a.messages.length - 1]?.date || 0;
    const lb = b.messages[b.messages.length - 1]?.date || 0;
    return new Date(lb) - new Date(la);
  });
  return out;
}

function extractThreadEventsForTask(thread, owner, taskTokens) {
  const events = [];
  for (const msg of thread.messages) {
    const from    = msg.fromName || msg.fromAddr || "unknown";
    const isOwner = ownerMatchesEmail(owner, msg.raw);
    if (!isOwner && emailMatchesTokens(msg.raw, taskTokens)) {
      events.push({ type: "asked", by: from, to: owner, date: msg.date, subject: msg.subject, snippet: (msg.preview || "").slice(0, 240), emailId: msg.id });
    }
    if (isOwner && emailMatchesTokens(msg.raw, taskTokens)) {
      events.push({ type: "responded", by: from, to: null, date: msg.date, subject: msg.subject, snippet: (msg.preview || "").slice(0, 240), emailId: msg.id });
    }
  }
  return events;
}

function buildCombinedTimeline(meetingItem, emailThreadEvents) {
  const timeline = [];
  timeline.push({ type: "meeting", date: meetingItem.date || null, actor: meetingItem.owner || null, description: meetingItem.task || null, source: "meeting" });
  for (const ev of emailThreadEvents) {
    timeline.push({ type: ev.type, date: ev.date || null, actor: ev.by, description: ev.snippet || ev.subject || "", source: "email", emailId: ev.emailId || null, subject: ev.subject || null });
  }
  timeline.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1; if (!b.date) return -1;
    return new Date(a.date) - new Date(b.date);
  });
  return timeline;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Handler
// ─────────────────────────────────────────────────────────────────────────────

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

      context.log(`[PreMeetingBrief] userId: ${userId} | event: ${eventId}`);

      const [event, profile] = await Promise.all([
        graphService.getEvent(accessToken, eventId),
        graphService.getMyProfile(accessToken).catch(() => null),
      ]);

      const effectiveUserEmail =
        profile?.mail ||
        profile?.userPrincipalName ||
        tokenEmail;

      context.log(`[PreMeetingBrief] effectiveUserEmail: ${effectiveUserEmail}`);

      const attendeeEmails = (event.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean);
      const attendeeNames  = (event.attendees || []).map((a) => (a.emailAddress?.name || a.emailAddress?.address || "").toLowerCase().split(" ")[0]).filter((n) => n.length > 2);
      const upcomingKeywords = normalizeTokens(event.subject);

      context.log(`[PreMeetingBrief] attendees: ${attendeeEmails.join(", ")} | keywords: ${upcomingKeywords.join(", ")}`);

      const [recentEmailsResult, previousMeetings] = await Promise.all([
        graphService.getEmailsFromAttendees(accessToken, attendeeEmails, 40),
        cosmosService.getPreviousMeetings(userId, attendeeEmails, upcomingKeywords, 1),
      ]);

      const allEmails     = recentEmailsResult.value || [];
      const bestPastMeeting = previousMeetings?.length > 0 ? previousMeetings[0] : null;

      const pastMeetingKeywords = bestPastMeeting ? normalizeTokens(bestPastMeeting.subject) : [];
      const allKeywords  = [...new Set([...upcomingKeywords, ...pastMeetingKeywords])];
      const attendeeAddressSet = new Set(attendeeEmails.map((e) => (e || "").toLowerCase()));
      const userHints    = userIdentityHints(effectiveUserEmail);

      const strictRelevantEmails = allEmails.filter((e) => {
        const subject  = (e.subject || "").toLowerCase();
        const preview  = (e.bodyPreview || "").toLowerCase();
        const fromAddr = (e.from?.emailAddress?.address || "").toLowerCase();
        const fromName = (e.from?.emailAddress?.name    || "").toLowerCase();
        const recipients = emailRecipientAddresses(e);

        const isFromAttendee  = attendeeEmails.map((a) => a.toLowerCase()).includes(fromAddr) || attendeeNames.some((n) => fromName.includes(n));
        const isFromUser      = emailFromUser(e, userHints);
        const isSentToAttendee = recipients.some((addr) => attendeeAddressSet.has(addr));

        const tokens  = normalizeTokens(subject + " " + preview);
        const isAbout = tokens.some((t) => allKeywords.includes(t));
        return isAbout && (isFromAttendee || (isFromUser && isSentToAttendee));
      });

      let emailsToAnalyze = strictRelevantEmails.length > 0
        ? strictRelevantEmails.slice(0, 20)
        : allEmails.filter((e) => {
            const tokens = normalizeTokens(`${e.subject || ""} ${e.bodyPreview || ""}`);
            return tokens.some((t) => allKeywords.includes(t));
          }).slice(0, 15);

      const userRelevantEmails = strictRelevantEmails.filter((email) => emailFromUser(email, userHints)).slice(0, 5);
      if (userRelevantEmails.length > 0) {
        const byId = new Map();
        for (const email of userRelevantEmails.concat(emailsToAnalyze)) {
          const key = email.id || `${email.conversationId || ""}:${email.receivedDateTime || ""}:${email.subject || ""}`;
          if (!byId.has(key)) byId.set(key, email);
        }
        emailsToAnalyze = Array.from(byId.values()).slice(0, 20);
      }

      let deterministicFollowUps = null;
      let pastMeetingContext     = [];

      if (bestPastMeeting) {
        const meeting = {
          subject:               bestPastMeeting.subject,
          date:                  bestPastMeeting.startTime || bestPastMeeting.savedAt || null,
          summary:               bestPastMeeting.summary  || null,
          transcript:            bestPastMeeting.transcript ? bestPastMeeting.transcript.slice(0, 4000) : null,
          actionItems:           (bestPastMeeting.actionItems || []).map((a) => ({ ...a })),
          plannedForNextMeeting: bestPastMeeting.plannedForNextMeeting || [],
        };

        const analyzedPool = emailsToAnalyze.concat(allEmails);
        meeting.actionItems = meeting.actionItems.map((item) => {
          const owner      = item.owner || "";
          const task       = item.task  || "";
          const taskTokens = normalizeTokens(task);
          const ownerEmails = analyzedPool.filter((e) => ownerMatchesEmail(owner, e));
          let matched = ownerEmails.find((e) => emailMatchesTokens(e, taskTokens));
          if (!matched) matched = analyzedPool.find((e) => emailMatchesTokens(e, taskTokens));
          if (matched) {
            return { owner, task, status: "done", evidence: makeEvidence(owner, matched), emailId: matched.id || null, emailSubject: matched.subject || null };
          }
          return { owner, task, status: "pending", evidence: null, emailId: null, emailSubject: null };
        });

        pastMeetingContext = [meeting];

        const threads     = groupEmailsIntoThreads(emailsToAnalyze);
        const emailThreads = threads.map((t) => {
          const threadEvents = [];
          for (const ai of meeting.actionItems) {
            const taskTokens = normalizeTokens(ai.task || "");
            const evs = extractThreadEventsForTask(t, ai.owner || "", taskTokens);
            evs.forEach((x) => (x.relatedTask = ai.task));
            threadEvents.push(...evs);
          }
          const contextMessages = t.messages.slice(0, 3).map((m) => ({
            date: m.date, from: m.fromName || m.fromAddr, subject: m.subject,
            snippet: (m.preview || "").slice(0, 180), emailId: m.id || null,
          }));
          return {
            threadId: t.threadId, subject: t.subject,
            latestMessage: t.messages[t.messages.length - 1]?.date || null,
            messagesCount: t.messages.length, contextMessages, events: threadEvents,
          };
        });

        const combinedPerItem = meeting.actionItems.map((ai) => {
          const itemEvents = [];
          for (const thr of emailThreads) {
            for (const ev of thr.events) { if (ev.relatedTask === ai.task) itemEvents.push(ev); }
          }
          const timeline = buildCombinedTimeline({ owner: ai.owner, task: ai.task, date: meeting.date }, itemEvents);
          return { owner: ai.owner, task: ai.task, status: ai.status, evidence: ai.evidence, emailId: ai.emailId, emailSubject: ai.emailSubject, timeline };
        });

        const meetingNarrativeParts = [];
        if (meeting.summary) {
          meetingNarrativeParts.push(meeting.summary.split("\n")[0].trim());
        } else {
          meetingNarrativeParts.push(`In the previous meeting titled "${meeting.subject}", concrete next steps were defined.`);
        }
        if (meeting.actionItems.length > 0) {
          const commits = meeting.actionItems.map((a) => `${a.owner} → ${a.task}`).slice(0, 3);
          meetingNarrativeParts.push(`Owners were assigned: ${commits.join("; ")}.`);
        }
        const doneCount    = meeting.actionItems.filter((a) => a.status === "done").length;
        const pendingCount = meeting.actionItems.filter((a) => a.status === "pending").length;
        if (doneCount    > 0) meetingNarrativeParts.push(`${doneCount} tracked action(s) show confirmation via email evidence.`);
        if (pendingCount > 0) meetingNarrativeParts.push(`${pendingCount} tracked action(s) remain pending.`);

        deterministicFollowUps = {
          meeting: { subject: meeting.subject, date: meeting.date, summary: meeting.summary, actionItems: meeting.actionItems, plannedForNextMeeting: meeting.plannedForNextMeeting.slice(0, 4), narrative: meetingNarrativeParts.join(" ") },
          emailThreads,
          items: combinedPerItem,
          combinedTimeline: [].concat(...combinedPerItem.map((c) => c.timeline)).sort((a, b) => {
            if (!a.date && !b.date) return 0;
            if (!a.date) return 1; if (!b.date) return -1;
            return new Date(a.date) - new Date(b.date);
          }),
        };
      }

      let jiraResult;
      try {
        jiraResult = await jiraService.buildPreCallExecutionContext({
          event, pastMeeting: bestPastMeeting, emails: emailsToAnalyze,
          attendeeEmails, attendeeNames, userEmail: effectiveUserEmail,
        });
      } catch (err) {
        context.error("[PreMeetingBrief] Jira step failed:", err?.message);
        jiraResult = { executionContext: null, issues: [], meta: { enabled: false, matchedIssueCount: 0 } };
      }

      let llmBrief;
      try {
        function cleanHtml(html) {
          if (!html) return "";
          return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        }

        const enrichedEvent = {
            ...event,
          description: cleanHtml(
            event.body?.content || event.description || ""
          )
        };

        llmBrief = await openaiService.generatePreCallBrief({
          event: enrichedEvent,
          recentEmails:         emailsToAnalyze,
          pastMeetings:         pastMeetingContext,
          jiraExecutionContext: jiraResult.executionContext,
        });
      } catch (err) {
        context.error("[PreMeetingBrief] LLM step failed:", err?.message);
        throw err;
      }

      let finalBrief = llmBrief && typeof llmBrief === "object" ? { ...llmBrief } : {};
      if (!finalBrief.followUps) finalBrief.followUps = null;

      if (deterministicFollowUps) {
        finalBrief.followUps = finalBrief.followUps || {};
        finalBrief.followUps.meeting              = finalBrief.followUps.meeting || deterministicFollowUps.meeting;
        finalBrief.followUps.items                = deterministicFollowUps.items;
        finalBrief.followUps.nextMeetingPoints     = (finalBrief.followUps.nextMeetingPoints?.length > 0) ? finalBrief.followUps.nextMeetingPoints : deterministicFollowUps.meeting.plannedForNextMeeting;
        finalBrief.followUps.emailThreads          = deterministicFollowUps.emailThreads;
        finalBrief.followUps.combinedTimeline      = deterministicFollowUps.combinedTimeline;
        finalBrief.followUps.narrative             = finalBrief.followUps.narrative || deterministicFollowUps.meeting.narrative;
      }

      if (jiraResult.executionContext) {
        finalBrief.executionContext = {
          title:      jiraResult.executionContext.title,
          spaceName:  jiraResult.executionContext.spaceName,
          statusLine: jiraResult.executionContext.statusLine,
          blockers:   jiraResult.executionContext.blockers,
        };
      }

      try {
        // Consolidated rich agenda construction
        const mergedAgenda = buildDiscussionItems({
          llmBrief: finalBrief,
          followUps: finalBrief.followUps,
          executionContext: jiraResult.executionContext,
          issues: jiraResult.issues,
        });

        // Set properties for other files to pickup
        finalBrief.agenda = mergedAgenda;
        finalBrief.agendaForToday = mergedAgenda;
        
        // Remove openPoints as they are now part of the rich agenda
        finalBrief.openPoints = [];

        finalBrief.assignedToMe = buildAssignedToMe(jiraResult.issues, effectiveUserEmail);
        finalBrief.preMeetingChecks = buildPreMeetingChecks({
          followUps: finalBrief.followUps,
          issues:    jiraResult.issues,
          emails:    emailsToAnalyze,
          userEmail: effectiveUserEmail,
          logger:    (...args) => context.log(...args),
        });

      } catch (err) {
        context.error("[PreMeetingBrief] post-LLM assembly failed:", err?.message);
        throw err;
      }

      await cosmosService.saveMeetingRecord(userId, eventId, {
        subject:           event.subject,
        attendees:         attendeeEmails,
        keywords:           upcomingKeywords,
        startTime:         event.start?.dateTime,
        briefGenerated:    true,
        briefGeneratedAt:  new Date().toISOString(),
      });

      return jsonResponse({
        success: true,
        event: {
          id: event.id, subject: event.subject, start: event.start, end: event.end,
          attendees: event.attendees, joinUrl: event.onlineMeeting?.joinUrl,
        },
        brief: finalBrief,
        meta: {
          emailsAnalyzed:           emailsToAnalyze.length,
          previousMeetingsFound:    bestPastMeeting ? 1 : 0,
          hasPreviousMeetingContext: Boolean(bestPastMeeting),
          enabled:           jiraResult.meta.enabled,
          matchedIssueCount: jiraResult.meta.matchedIssueCount,
        },
      });
    } catch (err) {
      context.error("[PreMeetingBrief] Error:", err.stack || err.message || err);
      return errorResponse(err.message);
    }
  },
});