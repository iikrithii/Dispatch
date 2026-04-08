function normalizeAttendees(attendees = []) {
  return (attendees || [])
    .map((attendee) => {
      if (!attendee) return null;
      if (typeof attendee === "string") {
        return { name: attendee, email: null };
      }

      return {
        name:
          attendee.name ||
          attendee.displayName ||
          attendee.emailAddress?.name ||
          attendee.email ||
          attendee.emailAddress?.address ||
          null,
        email: attendee.email || attendee.emailAddress?.address || null,
      };
    })
    .filter(Boolean);
}

function simplifyEvent(event = {}) {
  if (!event) return null;

  return {
    id: event.id || null,
    subject: event.subject || "Untitled meeting",
    start: event.start?.dateTime || event.start || null,
    end: event.end?.dateTime || event.end || null,
    attendees: normalizeAttendees(event.attendees || []),
    bodyPreview: event.bodyPreview || event.description || "",
    joinUrl: event.joinUrl || event.onlineMeeting?.joinUrl || event.joinWebUrl || null,
  };
}

function simplifyTask(task = {}) {
  return {
    title: task.title || task.subject || "Untitled task",
    dueDate: task.dueDateTime?.dateTime || task.dueDate || null,
    importance: task.importance || "normal",
    status: task.status || "notStarted",
  };
}

function simplifyEmail(email = {}) {
  return {
    subject: email.subject || "(No subject)",
    from:
      email.from?.emailAddress?.name ||
      email.from?.emailAddress?.address ||
      "Unknown sender",
    receivedDateTime: email.receivedDateTime || null,
    bodyPreview: email.bodyPreview || "",
  };
}

function toAgendaStrings(items = []) {
  return (items || [])
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") return item;
      return item.text || item.item || item.title || null;
    })
    .filter(Boolean);
}

function buildLiveContext({
  currentMeeting = null,
  brief = null,
  profile = null,
  calendarEvents = [],
  tasks = [],
  inboxMessages = [],
  user = null,
} = {}) {
  const meeting = simplifyEvent(currentMeeting || {});
  const displayName =
    user?.name ||
    profile?.displayName ||
    profile?.mail ||
    profile?.userPrincipalName ||
    "You";

  return {
    user: {
      name: displayName,
      email: user?.email || profile?.mail || profile?.userPrincipalName || null,
      jobTitle: profile?.jobTitle || null,
    },
    meeting,
    brief: {
      meetingTitle: brief?.meetingTitle || meeting.subject,
      currentStatus: brief?.currentStatus || "",
      keyContext: brief?.keyContext || "",
      openPoints: brief?.openPoints || [],
      agenda: toAgendaStrings(brief?.agenda || brief?.agendaForToday || []),
      followUps: {
        items: (brief?.followUps?.items || []).map((item) => ({
          owner: item.owner || "Unknown",
          task: item.task || "Follow up",
          status: item.status || "pending",
          evidence: item.evidence || null,
        })),
        nextMeetingPoints: toAgendaStrings(brief?.followUps?.nextMeetingPoints || []),
      },
      executionContext: {
        title: brief?.executionContext?.title || null,
        statusLine: brief?.executionContext?.statusLine || null,
        blockers: brief?.executionContext?.blockers || [],
      },
      preMeetingChecks: (brief?.preMeetingChecks || []).map((check) => check.text || check),
    },
    calendar: (calendarEvents || []).map(simplifyEvent).filter(Boolean).slice(0, 10),
    tasks: (tasks || []).map(simplifyTask).slice(0, 10),
    inbox: (inboxMessages || []).map(simplifyEmail).slice(0, 8),
  };
}

function formatDateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAttendeeList(attendees = []) {
  const names = normalizeAttendees(attendees)
    .map((attendee) => attendee.name || attendee.email)
    .filter(Boolean);
  return names.length > 0 ? names.join(", ") : "Not available";
}

function buildAgendaText(liveContext = {}) {
  const agenda = liveContext?.brief?.agenda || [];
  const followUps = liveContext?.brief?.followUps?.nextMeetingPoints || [];
  const blockers = liveContext?.brief?.executionContext?.blockers || [];
  const merged = [...agenda, ...followUps, ...blockers].filter(Boolean);

  if (merged.length === 0) {
    return "1. Clarify the current priorities\n2. Review open items\n3. Confirm next steps";
  }

  return merged.slice(0, 6).map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function buildMeetingContextText(liveContext = {}) {
  const lines = [
    `Meeting: ${liveContext?.meeting?.subject || liveContext?.brief?.meetingTitle || "Live meeting"}`,
    `Participants: ${formatAttendeeList(liveContext?.meeting?.attendees || [])}`,
  ];

  if (liveContext?.brief?.currentStatus) {
    lines.push(`Current status: ${liveContext.brief.currentStatus}`);
  }
  if (liveContext?.brief?.keyContext) {
    lines.push(`Key context: ${liveContext.brief.keyContext}`);
  }

  const followUps = liveContext?.brief?.followUps?.items || [];
  if (followUps.length > 0) {
    lines.push("Open follow-ups:");
    followUps.slice(0, 5).forEach((item) => {
      lines.push(`- ${item.owner}: ${item.task} (${item.status})`);
    });
  }

  const blockers = liveContext?.brief?.executionContext?.blockers || [];
  if (blockers.length > 0) {
    lines.push("Known blockers:");
    blockers.slice(0, 4).forEach((blocker) => lines.push(`- ${blocker}`));
  }

  const inbox = liveContext?.inbox || [];
  if (inbox.length > 0) {
    lines.push("Recent email context:");
    inbox.slice(0, 4).forEach((mail) => {
      lines.push(`- ${mail.from}: ${mail.subject}`);
    });
  }

  return lines.join("\n");
}

function buildCommitmentContextText(liveContext = {}) {
  const lines = [
    buildMeetingContextText(liveContext),
    "",
    "Calendar load for the next few days:",
  ];

  const calendar = liveContext?.calendar || [];
  if (calendar.length === 0) {
    lines.push("- No upcoming calendar load found.");
  } else {
    calendar.slice(0, 8).forEach((event) => {
      lines.push(`- ${formatDateTime(event.start)}: ${event.subject}`);
    });
  }

  lines.push("", "Pending tasks and workload:");
  const tasks = liveContext?.tasks || [];
  if (tasks.length === 0) {
    lines.push("- No pending tasks found.");
  } else {
    tasks.slice(0, 8).forEach((task) => {
      const due = task.dueDate ? ` due ${formatDateTime(task.dueDate)}` : "";
      lines.push(`- ${task.title}${due} (${task.importance})`);
    });
  }

  return lines.join("\n");
}

module.exports = {
  buildLiveContext,
  buildAgendaText,
  buildMeetingContextText,
  buildCommitmentContextText,
};
