const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const openaiService = require("../services/openaiService");
const cosmosService = require("../services/cosmosService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

const STOP_WORDS = new Set([
  "with", "from", "this", "that", "have", "will", "been", "your",
  "meeting", "call", "sync", "review", "weekly", "update", "prep",
  "follow", "yesterday", "today", "about", "just", "also", "here",
  "some", "what", "when", "then", "only", "over", "very", "into",
  "more", "were", "they", "them", "their", "would", "could",
]);

function normalizeTokens(text = "") {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
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

/**
 * Group emails into threads. Prefer conversationId; fallback to normalized subject.
 * Returns an array of threads: { threadId, subject, messages: [ { id, fromName, fromAddr, date, subject, preview } ] }
 */
function groupEmailsIntoThreads(emails = []) {
  const threads = new Map();

  for (const e of emails) {
    const conv = e.conversationId || "";
    // fallback key: subject normalized (not perfect but OK)
    const subjKey = (e.subject || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().slice(0, 80) || "__nosubj__";
    const key = conv || subjKey;

    if (!threads.has(key)) {
      threads.set(key, {
        threadId: key,
        subject: e.subject || "(no subject)",
        messages: [],
      });
    }

    threads.get(key).messages.push({
      id: e.id || null,
      fromName: (e.from?.emailAddress?.name || "").trim(),
      fromAddr: (e.from?.emailAddress?.address || "").toLowerCase(),
      date: e.receivedDateTime || e.createdDateTime || null,
      subject: e.subject || "",
      preview: e.bodyPreview || "",
      raw: e,
    });
  }

  // sort messages in each thread ascending by date
  const out = Array.from(threads.values()).map((t) => {
    t.messages.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    });
    return t;
  });

  // sort threads by latest message desc
  out.sort((a, b) => {
    const la = a.messages[a.messages.length - 1]?.date || 0;
    const lb = b.messages[b.messages.length - 1]?.date || 0;
    return new Date(lb) - new Date(la);
  });

  return out;
}

/**
 * For a given meeting action item and a thread, extract if someone asked the owner
 * and whether the owner responded. Returns an array of events for that thread.
 */
function extractThreadEventsForTask(thread, owner, taskTokens) {
  const events = [];

  for (const msg of thread.messages) {
    const from = msg.fromName || msg.fromAddr || "unknown";
    const isOwner = ownerMatchesEmail(owner, msg.raw);

    // If sender is not owner and message mentions task tokens => it's a request/ask
    if (!isOwner && emailMatchesTokens(msg.raw, taskTokens)) {
      events.push({
        type: "asked",
        by: from,
        to: owner,
        date: msg.date,
        subject: msg.subject,
        snippet: (msg.preview || "").slice(0, 240),
        emailId: msg.id,
      });
    }

    // If sender is owner and message mentions task tokens => it's a response
    if (isOwner && emailMatchesTokens(msg.raw, taskTokens)) {
      events.push({
        type: "responded",
        by: from,
        to: null,
        date: msg.date,
        subject: msg.subject,
        snippet: (msg.preview || "").slice(0, 240),
        emailId: msg.id,
      });
    }
  }

  return events;
}

/**
 * Merge chronological items from meeting + email events.
 * Meeting item uses date = meeting date (if present) or savedAt; emails have their dates.
 */
function buildCombinedTimeline(meetingItem, emailThreadEvents) {
  const timeline = [];

  // meeting item event (when the action was assigned in the meeting)
  timeline.push({
    type: "meeting",
    date: meetingItem.date || null,
    actor: meetingItem.owner || null,
    description: meetingItem.task || null,
    source: "meeting",
  });

  // add email events (already have dates)
  for (const ev of emailThreadEvents) {
    timeline.push({
      type: ev.type, // asked | responded
      date: ev.date || null,
      actor: ev.by,
      description: ev.snippet || ev.subject || "",
      source: "email",
      emailId: ev.emailId || null,
      subject: ev.subject || null,
    });
  }

  // sort by date ascending (null dates go last)
  timeline.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(a.date) - new Date(b.date);
  });

  return timeline;
}

app.http("preMeetingBrief", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "pre-meeting-brief",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken, userId } = extractAuth(req);
      const eventId = req.query.get("eventId");
      if (!eventId) return errorResponse("eventId query parameter is required", 400);

      context.log(`[PreMeetingBrief] userId: ${userId} | event: ${eventId}`);

      // 1. Fetch event (graphService.getEvent should request IST)
      const event = await graphService.getEvent(accessToken, eventId);

      // 2. Attendees + upcoming keywords
      const attendeeEmails = (event.attendees || [])
        .map((a) => a.emailAddress?.address)
        .filter(Boolean);

      const attendeeNames = (event.attendees || [])
        .map((a) => (a.emailAddress?.name || a.emailAddress?.address || "").toLowerCase().split(" ")[0])
        .filter((n) => n.length > 2);

      const upcomingKeywords = normalizeTokens(event.subject);

      context.log(`[PreMeetingBrief] attendees: ${attendeeEmails.join(", ")} | keywords: ${upcomingKeywords.join(", ")}`);

      // 3. Fetch emails + previous meetings (cosmos returns at most 1 relevant meeting)
      const [recentEmailsResult, previousMeetings] = await Promise.all([
        graphService.getEmailsFromAttendees(accessToken, attendeeEmails, 40),
        cosmosService.getPreviousMeetings(userId, attendeeEmails, upcomingKeywords, 1),
      ]);

      const allEmails = recentEmailsResult.value || [];

      context.log(`[PreMeetingBrief] emails fetched: ${allEmails.length} | previousMeetings: ${previousMeetings.length}`);

      const bestPastMeeting = previousMeetings && previousMeetings.length > 0 ? previousMeetings[0] : null;

      // 4. Build keywords for filtering
      const pastMeetingKeywords = bestPastMeeting ? normalizeTokens(bestPastMeeting.subject) : [];
      const allKeywords = [...new Set([...upcomingKeywords, ...pastMeetingKeywords])];

      // 5. Filter emails: require attendee + topic tokens
      const strictRelevantEmails = allEmails.filter((e) => {
        const subject = (e.subject || "").toLowerCase();
        const preview = (e.bodyPreview || "").toLowerCase();
        const fromAddr = (e.from?.emailAddress?.address || "").toLowerCase();
        const fromName = (e.from?.emailAddress?.name || "").toLowerCase();

        const isFromAttendee = attendeeEmails.map((a) => a.toLowerCase()).includes(fromAddr) ||
          attendeeNames.some((n) => fromName.includes(n));

        const tokens = normalizeTokens(subject + " " + preview);
        const isAbout = tokens.some((t) => allKeywords.includes(t));
        return isFromAttendee && isAbout;
      });

      const emailsToAnalyze = strictRelevantEmails.length > 0
        ? strictRelevantEmails.slice(0, 20)
        : allEmails
            .filter((e) => {
              const subject = (e.subject || "").toLowerCase();
              const preview = (e.bodyPreview || "").toLowerCase();
              const tokens = normalizeTokens(subject + " " + preview);
              return tokens.some((t) => allKeywords.includes(t));
            })
            .slice(0, 15);

      context.log(`[PreMeetingBrief] emailsToAnalyze: ${emailsToAnalyze.length}`);

      // 6. Build deterministic pastMeetingContext and new, detailed followUps structure
      let deterministicFollowUps = null;
      let pastMeetingContext = [];

      if (bestPastMeeting) {
        // copy meeting
        const meeting = {
          subject: bestPastMeeting.subject,
          date: bestPastMeeting.startTime || bestPastMeeting.savedAt || null,
          summary: bestPastMeeting.summary || null,
          transcript: bestPastMeeting.transcript ? bestPastMeeting.transcript.slice(0, 4000) : null,
          actionItems: (bestPastMeeting.actionItems || []).map((a) => ({ ...a })),
          plannedForNextMeeting: bestPastMeeting.plannedForNextMeeting || [],
        };

        // deterministic label for each action item (done/pending + evidence)
        const analyzedPool = emailsToAnalyze.concat(allEmails); // prefer filtered but allow broader inbox
        meeting.actionItems = meeting.actionItems.map((item) => {
          const owner = item.owner || "";
          const task = item.task || "";
          const taskTokens = normalizeTokens(task);

          // prefer emails from owner
          const ownerEmails = analyzedPool.filter((e) => ownerMatchesEmail(owner, e));

          let matched = ownerEmails.find((e) => emailMatchesTokens(e, taskTokens));
          if (!matched) {
            matched = analyzedPool.find((e) => emailMatchesTokens(e, taskTokens));
          }

          if (matched) {
            return {
              owner,
              task,
              status: "done",
              evidence: makeEvidence(owner, matched),
              emailId: matched.id || null,
              emailSubject: matched.subject || null,
            };
          }
          return {
            owner,
            task,
            status: "pending",
            evidence: null,
            emailId: null,
            emailSubject: null,
          };
        });

        pastMeetingContext = [meeting];

        // 7. Build email threads and extract per-thread events related to meeting tasks
        const threads = groupEmailsIntoThreads(emailsToAnalyze);

        const emailThreads = threads.map((t) => {
          // for thread-level, gather events per action item
          const threadEvents = [];

          for (const ai of meeting.actionItems) {
            const taskTokens = normalizeTokens(ai.task || "");
            const evs = extractThreadEventsForTask(t, ai.owner || "", taskTokens);
            // attach which action item these events relate to
            evs.forEach((x) => (x.relatedTask = ai.task));
            threadEvents.push(...evs);
          }

          // Also include general messages (non-task) as context (first 3 messages)
          const contextMessages = t.messages.slice(0, 3).map((m) => ({
            date: m.date,
            from: m.fromName || m.fromAddr,
            subject: m.subject,
            snippet: (m.preview || "").slice(0, 180),
            emailId: m.id || null,
          }));

          return {
            threadId: t.threadId,
            subject: t.subject,
            latestMessage: t.messages[t.messages.length - 1]?.date || null,
            messagesCount: t.messages.length,
            contextMessages,
            events: threadEvents, // asked/responded items
          };
        });

        // 8. Build combined timeline per action item (meeting assignment → email events)
        const combinedPerItem = meeting.actionItems.map((ai) => {
          // collect all thread events relevant to this task
          const itemEvents = [];
          for (const thr of emailThreads) {
            for (const ev of thr.events) {
              if (ev.relatedTask === ai.task) itemEvents.push(ev);
            }
          }
          const timeline = buildCombinedTimeline(
            { owner: ai.owner, task: ai.task, date: meeting.date },
            itemEvents
          );
          return {
            owner: ai.owner,
            task: ai.task,
            status: ai.status,
            evidence: ai.evidence,
            emailId: ai.emailId,
            emailSubject: ai.emailSubject,
            timeline,
          };
        });

        // 9. Build a clear narrative summary (multi-sentence) — more than before
        const meetingNarrativeParts = [];

        // sentence: what happened in meeting (use summary if available)
        if (meeting.summary) {
          meetingNarrativeParts.push(meeting.summary.split("\n")[0].trim());
        } else {
          meetingNarrativeParts.push(`In the previous meeting titled "${meeting.subject}", the 3-2-1 format and concrete next steps were defined.`);
        }

        // sentence: high-level statement of owner commitments
        if (meeting.actionItems.length > 0) {
          const commits = meeting.actionItems.map((a) => `${a.owner} → ${a.task}`).slice(0, 3);
          meetingNarrativeParts.push(`Owners were assigned: ${commits.join("; ")}.`);
        }

        // sentence: what emails show so far
        const doneCount = meeting.actionItems.filter((a) => a.status === "done").length;
        const pendingCount = meeting.actionItems.filter((a) => a.status === "pending").length;
        if (doneCount > 0) {
          meetingNarrativeParts.push(`${doneCount} tracked action(s) show confirmation via email evidence.`);
        }
        if (pendingCount > 0) {
          meetingNarrativeParts.push(`${pendingCount} tracked action(s) remain pending.`);
        }

        deterministicFollowUps = {
          meeting: {
            subject: meeting.subject,
            date: meeting.date,
            summary: meeting.summary,
            actionItems: meeting.actionItems,
            plannedForNextMeeting: meeting.plannedForNextMeeting.slice(0, 4),
            narrative: meetingNarrativeParts.join(" "),
          },
          emailThreads, // array of threads with context + events
          items: combinedPerItem, // per-action-item combined timeline + status
          combinedTimeline: [].concat(...combinedPerItem.map((c) => c.timeline)).sort((a,b) => {
            if (!a.date && !b.date) return 0;
            if (!a.date) return 1;
            if (!b.date) return -1;
            return new Date(a.date) - new Date(b.date);
          }),
        };
      }

      // 10. Call LLM for the rest of the brief (agenda, open points, richer phrasing)
      const llmBrief = await openaiService.generatePreCallBrief({
        event,
        recentEmails: emailsToAnalyze,
        pastMeetings: pastMeetingContext,
      });

      // 11. Merge deterministicFollowUps with LLM output (deterministic data wins for items/threads)
      let finalBrief = llmBrief && typeof llmBrief === "object" ? { ...llmBrief } : {};

      if (!finalBrief.followUps) finalBrief.followUps = null;

      if (deterministicFollowUps) {
        // Ensure followUps exists
        finalBrief.followUps = finalBrief.followUps || {};

        // meeting block
        finalBrief.followUps.meeting = finalBrief.followUps.meeting || deterministicFollowUps.meeting;

        // items: prefer deterministic items (clear status & timelines)
        finalBrief.followUps.items = deterministicFollowUps.items;

        // keep LLM nextMeetingPoints if present, else fallback
        finalBrief.followUps.nextMeetingPoints = finalBrief.followUps.nextMeetingPoints && finalBrief.followUps.nextMeetingPoints.length > 0
          ? finalBrief.followUps.nextMeetingPoints
          : deterministicFollowUps.meeting.plannedForNextMeeting;

        // attach detailed emailThreads for frontend consumption
        finalBrief.followUps.emailThreads = deterministicFollowUps.emailThreads;
        finalBrief.followUps.combinedTimeline = deterministicFollowUps.combinedTimeline;
        finalBrief.followUps.narrative = finalBrief.followUps.narrative || deterministicFollowUps.meeting.narrative;
      }

      // 12. Save event record
      await cosmosService.saveMeetingRecord(userId, eventId, {
        subject: event.subject,
        attendees: attendeeEmails,
        keywords: upcomingKeywords,
        startTime: event.start?.dateTime,
        briefGenerated: true,
        briefGeneratedAt: new Date().toISOString(),
      });

      // 13. Return
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
          emailsAnalyzed: emailsToAnalyze.length,
          previousMeetingsFound: bestPastMeeting ? 1 : 0,
          hasPreviousMeetingContext: Boolean(bestPastMeeting),
        },
      });
    } catch (err) {
      context.error("[PreMeetingBrief] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});