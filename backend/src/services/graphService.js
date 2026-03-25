// services/graphService.js
// All Microsoft Graph API calls live here.
// Change from Jira branch: getEmailsFromAttendees now fetches toRecipients + ccRecipients
// and raises the fetch limit to 50, enabling user-sent email detection in preMeetingBrief.

const fetch = require("node-fetch");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphGet(accessToken, path, params = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API error [${res.status}] ${path}: ${err}`);
  }
  return res.json();
}

async function graphPost(accessToken, path, body) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API error [${res.status}] POST ${path}: ${err}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────

async function getTodayEvents(accessToken) {
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setDate(end.getDate() + 7); end.setHours(23, 59, 59, 0);

  const url = new URL(`${GRAPH_BASE}/me/calendarView`);
  url.searchParams.append("startDateTime", startOfDay.toISOString());
  url.searchParams.append("endDateTime",   end.toISOString());
  url.searchParams.append("$select", "id,subject,start,end,attendees,bodyPreview,onlineMeeting");
  url.searchParams.append("$orderby", "start/dateTime");
  url.searchParams.append("$top", "20");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Prefer": `outlook.timezone="India Standard Time"`,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API error [${res.status}] /me/calendarView: ${err}`);
  }
  return res.json();
}

async function getEvent(accessToken, eventId) {
  return graphGet(accessToken, `/me/events/${eventId}`);
}

// ─────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────

/**
 * Fetch recent messages.
 * CHANGED: now selects toRecipients + ccRecipients (needed for user-sent email detection)
 * and raises limit to 50 so the pre-call brief has enough signal.
 */
async function getEmailsFromAttendees(accessToken, attendeeEmails, limit = 30) {
  if (!attendeeEmails || attendeeEmails.length === 0) return { value: [] };
  return graphGet(accessToken, "/me/messages", {
    $select:  "id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,conversationId",
    $orderby: "receivedDateTime desc",
    $top:     String(Math.min(limit, 50)),
  });
}

async function getEmailThread(accessToken, conversationId) {
  const result = await graphGet(accessToken, "/me/messages", {
    $select:  "subject,body,bodyPreview,from,receivedDateTime,toRecipients,conversationId",
    $orderby: "receivedDateTime desc",
    $top:     "50",
  });
  const filtered = (result.value || []).filter((m) => m.conversationId === conversationId);
  return { value: filtered.length > 0 ? filtered : result.value.slice(0, 10) };
}

async function getRecentInboxMessages(accessToken, limit = 20) {
  return graphGet(accessToken, "/me/mailFolders/inbox/messages", {
    $select:  "subject,bodyPreview,from,receivedDateTime,conversationId,isRead",
    $orderby: "receivedDateTime desc",
    $top:     String(limit),
  });
}

async function getEmailById(accessToken, messageId) {
  return graphGet(accessToken, `/me/messages/${messageId}`, {
    $select: "subject,body,from,receivedDateTime,toRecipients,conversationId",
  });
}

async function createDraftEmail(accessToken, { toEmails, subject, body }) {
  return graphPost(accessToken, "/me/messages", {
    subject,
    body: { contentType: "Text", content: body },
    toRecipients: toEmails.map((e) => ({ emailAddress: { address: e } })),
  });
}

// ─────────────────────────────────────────────
// TEAMS MEETINGS & TRANSCRIPTS
// ─────────────────────────────────────────────

async function getRecentOnlineMeetings(accessToken, limit = 10) {
  try {
    return await graphGet(accessToken, "/me/onlineMeetings", {
      $top: String(limit),
      $select: "id,subject,startDateTime,endDateTime,participants",
      $orderby: "startDateTime desc",
    });
  } catch {
    return { value: [] };
  }
}

async function getMeetingTranscripts(accessToken, meetingId) {
  try {
    const transcripts = await graphGet(accessToken, `/me/onlineMeetings/${meetingId}/transcripts`);
    if (!transcripts.value || transcripts.value.length === 0) return null;
    const transcriptId = transcripts.value[0].id;
    const content = await fetch(
      `${GRAPH_BASE}/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return content.ok ? content.text() : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// MICROSOFT TO-DO
// ─────────────────────────────────────────────

async function getTaskLists(accessToken) {
  return graphGet(accessToken, "/me/todo/lists");
}

async function getOrCreateDispatchList(accessToken) {
  const lists   = await getTaskLists(accessToken);
  const existing = lists.value?.find((l) => l.displayName === "Dispatch");
  if (existing) return existing;
  try {
    return await graphPost(accessToken, "/me/todo/lists", { displayName: "Dispatch" });
  } catch {
    return lists.value?.[0];
  }
}

async function createTask(accessToken, listId, { title, notes, dueDate }) {
  const body = { title, importance: "normal" };
  if (notes)   body.body        = { content: notes, contentType: "text" };
  if (dueDate) body.dueDateTime = { dateTime: new Date(dueDate).toISOString(), timeZone: "UTC" };
  return graphPost(accessToken, `/me/todo/lists/${listId}/tasks`, body);
}

async function getDispatchTasks(accessToken) {
  try {
    const list = await getOrCreateDispatchList(accessToken);
    return graphGet(accessToken, `/me/todo/lists/${list.id}/tasks`, {
      $filter:  "status ne 'completed'",
      $orderby: "importance desc",
    });
  } catch {
    return { value: [] };
  }
}

// ─────────────────────────────────────────────
// CALENDAR — CREATE INVITE
// ─────────────────────────────────────────────

async function createCalendarEvent(accessToken, { subject, body, start, end, attendeeEmails }) {
  return graphPost(accessToken, "/me/events", {
    subject,
    body:      { contentType: "Text", content: body },
    start:     { dateTime: start, timeZone: "UTC" },
    end:       { dateTime: end,   timeZone: "UTC" },
    attendees: attendeeEmails.map((e) => ({ emailAddress: { address: e }, type: "required" })),
  });
}

// ─────────────────────────────────────────────
// USER PROFILE
// ─────────────────────────────────────────────

async function getMyProfile(accessToken) {
  return graphGet(accessToken, "/me", {
    $select: "displayName,mail,userPrincipalName,jobTitle",
  });
}

module.exports = {
  getTodayEvents,
  getEvent,
  getEmailsFromAttendees,
  getEmailThread,
  getRecentInboxMessages,
  getEmailById,
  createDraftEmail,
  getRecentOnlineMeetings,
  getMeetingTranscripts,
  getOrCreateDispatchList,
  createTask,
  getDispatchTasks,
  createCalendarEvent,
  getMyProfile,
};