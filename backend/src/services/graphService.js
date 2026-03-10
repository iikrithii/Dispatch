// services/graphService.js
// All Microsoft Graph API calls live here.
// The `accessToken` is the delegated token from the user (passed via Authorization header).

const fetch = require("node-fetch");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphGet(accessToken, path, params = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
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
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
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

// /**
//  * Get all calendar events for today and the next 7 days.
//  */
// async function getTodayEvents(accessToken) {
//   const now = new Date();
//   const end = new Date(now);
//   end.setDate(end.getDate() + 7);

//   // return graphGet(accessToken, "/me/calendarView", {
//   //   startDateTime: now.toISOString(),
//   //   endDateTime: end.toISOString(),
//   //   $select:
//   //     "id,subject,start,end,attendees,bodyPreview,onlineMeeting,joinWebUrl",
//   //   $orderby: "start/dateTime",
//   //   $top: "20",
//   // });

//   return graphGet(accessToken, "/me/calendarView", {
//     startDateTime: now.toISOString(),
//     endDateTime: end.toISOString(),
//     $select: "id,subject,start,end,attendees,bodyPreview,onlineMeeting",
//     $orderby: "start/dateTime",
//     $top: "20",
//   });
// }

async function getTodayEvents(accessToken) {
  // Get today's start and end in local time, not UTC
  // Adding Prefer header tells Graph to return times in IST
  const now = new Date();
  
  // Start of today IST
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  
  // End of 7 days from now IST
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  end.setHours(23, 59, 59, 0);

  const url = new URL(`${GRAPH_BASE}/me/calendarView`);
  url.searchParams.append("startDateTime", startOfDay.toISOString());
  url.searchParams.append("endDateTime", end.toISOString());
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
/**
 * Get a single calendar event by ID.
 */
async function getEvent(accessToken, eventId) {
  return graphGet(accessToken, `/me/events/${eventId}`);
}

// ─────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────

/**
 * Get recent emails involving specific email addresses.
 * Used to find context emails before a meeting.
 */
// async function getEmailsFromAttendees(accessToken, attendeeEmails, limit = 30) {
//   if (!attendeeEmails || attendeeEmails.length === 0) return { value: [] };

//   // Build filter: messages from or to any attendee
//   const senderFilters = attendeeEmails
//     .slice(0, 5) // Graph filter limit
//     .map((e) => `from/emailAddress/address eq '${e}'`)
//     .join(" or ");

//   const sevenDaysAgo = new Date();
//   sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

//   return graphGet(accessToken, "/me/messages", {
//     $filter: `(${senderFilters}) and receivedDateTime ge ${sevenDaysAgo.toISOString()}`,
//     $select: "subject,bodyPreview,from,receivedDateTime,conversationId",
//     $orderby: "receivedDateTime desc",
//     $top: String(limit),
//   });
// }

async function getEmailsFromAttendees(accessToken, attendeeEmails, limit = 30) {
  if (!attendeeEmails || attendeeEmails.length === 0) return { value: [] };

  // Personal accounts don't support complex OR filters
  // Just fetch recent messages and let the AI work with them
  return graphGet(accessToken, "/me/messages", {
    $select: "subject,bodyPreview,from,receivedDateTime,conversationId",
    $orderby: "receivedDateTime desc",
    $top: String(Math.min(limit, 20)),
  });
}

/**
 * Get a full email thread (conversation) by conversationId.
 */
// async function getEmailThread(accessToken, conversationId) {
//   return graphGet(accessToken, "/me/messages", {
//     $filter: `conversationId eq '${conversationId}'`,
//     $select: "subject,body,from,receivedDateTime,toRecipients",
//     $orderby: "receivedDateTime asc",
//     $top: "50",
//   });
// }

async function getEmailThread(accessToken, conversationId) {
  // Personal accounts don't support filtering by conversationId directly
  // Fetch recent messages and filter client-side
  const result = await graphGet(accessToken, "/me/messages", {
    $select: "subject,body,bodyPreview,from,receivedDateTime,toRecipients,conversationId",
    $orderby: "receivedDateTime desc",
    $top: "50",
  });

  // Filter client-side by conversationId
  const filtered = (result.value || []).filter(
    (m) => m.conversationId === conversationId
  );

  return { value: filtered.length > 0 ? filtered : result.value.slice(0, 10) };
}

/**
 * Get recent inbox messages for daily to-do view.
 */
async function getRecentInboxMessages(accessToken, limit = 20) {
  return graphGet(accessToken, "/me/mailFolders/inbox/messages", {
    $select: "subject,bodyPreview,from,receivedDateTime,conversationId,isRead",
    $orderby: "receivedDateTime desc",
    $top: String(limit),
  });
}

/**
 * Get full body of a single email.
 */
async function getEmailById(accessToken, messageId) {
  return graphGet(accessToken, `/me/messages/${messageId}`, {
    $select: "subject,body,from,receivedDateTime,toRecipients,conversationId",
  });
}

/**
 * Send an email draft (creates a draft, does NOT auto-send — user must approve).
 * Returns the draft message object.
 */
async function createDraftEmail(accessToken, { toEmails, subject, body }) {
  return graphPost(accessToken, "/me/messages", {
    subject,
    body: { contentType: "Text", content: body },
    toRecipients: toEmails.map((e) => ({
      emailAddress: { address: e },
    })),
  });
}

// ─────────────────────────────────────────────
// TEAMS MEETINGS & TRANSCRIPTS
// ─────────────────────────────────────────────

/**
 * Get recent online meetings for the user.
 * Note: requires OnlineMeetings.Read permission.
 */
async function getRecentOnlineMeetings(accessToken, limit = 10) {
  try {
    return await graphGet(accessToken, "/me/onlineMeetings", {
      $top: String(limit),
      $select: "id,subject,startDateTime,endDateTime,participants",
      $orderby: "startDateTime desc",
    });
  } catch {
    // Transcript APIs require specific licensing (Teams Premium).
    // Fallback for demo: return empty so UI handles gracefully.
    return { value: [] };
  }
}

/**
 * Get transcripts for a specific meeting.
 * Requires Teams Premium or specific licensing.
 */
async function getMeetingTranscripts(accessToken, meetingId) {
  try {
    const transcripts = await graphGet(
      accessToken,
      `/me/onlineMeetings/${meetingId}/transcripts`
    );
    if (!transcripts.value || transcripts.value.length === 0) return null;

    // Fetch the actual transcript content (VTT format)
    const transcriptId = transcripts.value[0].id;
    const content = await fetch(
      `${GRAPH_BASE}/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    return content.ok ? content.text() : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// MICROSOFT TO-DO
// ─────────────────────────────────────────────

/**
 * Get all To-Do task lists for the user.
 */
async function getTaskLists(accessToken) {
  return graphGet(accessToken, "/me/todo/lists");
}

/**
 * Get a specific task list (or create the Dispatch list).
 */
// async function getOrCreateDispatchList(accessToken) {
//   const lists = await getTaskLists(accessToken);
//   const existing = lists.value?.find((l) => l.displayName === "Dispatch");
//   if (existing) return existing;

//   return graphPost(accessToken, "/me/todo/lists", {
//     displayName: "Dispatch",
//   });
// }
async function getOrCreateDispatchList(accessToken) {
  const lists = await getTaskLists(accessToken);
  const existing = lists.value?.find((l) => l.displayName === "Dispatch");
  if (existing) return existing;

  try {
    return await graphPost(accessToken, "/me/todo/lists", {
      displayName: "Dispatch",
    });
  } catch {
    // Return first available list as fallback
    return lists.value?.[0];
  }
}

/**
 * Create a task in Microsoft To-Do.
 * Only called after explicit user approval.
 */
async function createTask(accessToken, listId, { title, notes, dueDate }) {
  const body = {
    title,
    importance: "normal",
  };
  if (notes) {
    body.body = { content: notes, contentType: "text" };
  }
  if (dueDate) {
    body.dueDateTime = {
      dateTime: new Date(dueDate).toISOString(),
      timeZone: "UTC",
    };
  }

  return graphPost(accessToken, `/me/todo/lists/${listId}/tasks`, body);
}

/**
 * Get pending tasks from the Dispatch list.
 */
async function getDispatchTasks(accessToken) {
  try {
    const list = await getOrCreateDispatchList(accessToken);
    return graphGet(accessToken, `/me/todo/lists/${list.id}/tasks`, {
      $filter: "status ne 'completed'",
      $orderby: "importance desc",
    });
  } catch {
    return { value: [] };
  }
}

// ─────────────────────────────────────────────
// CALENDAR — CREATE INVITE
// ─────────────────────────────────────────────

/**
 * Create a draft calendar event. Returns event object.
 * User must explicitly confirm before this is sent.
 */
async function createCalendarEvent(
  accessToken,
  { subject, body, start, end, attendeeEmails }
) {
  return graphPost(accessToken, "/me/events", {
    subject,
    body: { contentType: "Text", content: body },
    start: { dateTime: start, timeZone: "UTC" },
    end: { dateTime: end, timeZone: "UTC" },
    attendees: attendeeEmails.map((e) => ({
      emailAddress: { address: e },
      type: "required",
    })),
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