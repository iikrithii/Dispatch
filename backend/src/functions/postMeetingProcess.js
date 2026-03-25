// functions/postMeetingProcess.js
// HTTP Trigger: POST /api/post-meeting-process
// Body: { meetingId, transcript (optional), eventId }
// Returns email drafts, reminders, meeting effectiveness, and engagement analysis.
// Tasks removed — Microsoft 365 handles task management natively.

const { app } = require("@azure/functions");
const graphService   = require("../services/graphService");
const openaiService  = require("../services/openaiService");
const cosmosService  = require("../services/cosmosService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

app.http("postMeetingProcess", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "post-meeting-process",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken, userId } = extractAuth(req);
      const body = await req.json();
      const { meetingId, eventId, transcript: providedTranscript } = body;

      if (!meetingId && !eventId) {
        return errorResponse("meetingId or eventId is required", 400);
      }

      context.log(`[PostMeeting] Processing: ${meetingId || eventId}`);

      // 1. Get the calendar event
      let event = null;
      if (eventId) {
        event = await graphService.getEvent(accessToken, eventId);
      }

      // 2. Try Teams transcript
      let transcript = providedTranscript;
      if (!transcript && meetingId) {
        transcript = await graphService.getMeetingTranscripts(accessToken, meetingId);
      }

      // 3. Fallback: use recent emails as simulated transcript
      if (!transcript && event) {
        const attendeeEmails = (event.attendees || [])
          .map((a) => a.emailAddress?.address)
          .filter(Boolean);
        const emails = await graphService.getEmailsFromAttendees(accessToken, attendeeEmails, 10);
        transcript = emails.value
          ?.map((e) => `${e.from?.emailAddress?.name}: [via email] ${e.subject}\n${e.bodyPreview}`)
          .join("\n\n");
      }

      if (!transcript) {
        return errorResponse(
          "No transcript or meeting content available. Teams transcript requires Teams Premium.",
          404
        );
      }

      // 4. Pull prior meeting from Cosmos for effectiveness analysis
      const attendeeEmails = (event?.attendees || [])
        .map((a) => a.emailAddress?.address)
        .filter(Boolean);
      const subjectKeywords = (event?.subject || "")
        .toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);

      let priorMeeting = null;
      try {
        const prior = await cosmosService.getPreviousMeetings(userId, attendeeEmails, subjectKeywords, 1);
        if (prior && prior.length > 0) priorMeeting = prior[0];
      } catch {
        // non-fatal — effectiveness just won't have prior context
      }

      // 5. Meeting info for AI
      const meetingInfo = {
        subject:   event?.subject || "Team Meeting",
        date:      event?.start?.dateTime || new Date().toISOString(),
        attendees: event?.attendees?.map(
          (a) => `${a.emailAddress?.name} <${a.emailAddress?.address}>`
        ) || [],
      };

      // 6. Process with AI — includes effectiveness + engagement now
      const processed = await openaiService.processPostCall(
        transcript,
        meetingInfo,
        priorMeeting
      );

      // 7. Build approval queue — emails and reminders only (no tasks)
      const pendingItems = [];

      // Draft emails
      (processed.followUpEmails || []).forEach((email) => {
        pendingItems.push({
          id:    email.id || `email_${Date.now()}_${Math.random()}`,
          type:  "email",
          label: `Send email: "${email.subject}"`,
          data:  email,
        });
      });

      // Follow-up meeting
      if (processed.suggestedFollowUpMeeting?.needed) {
        pendingItems.push({
          id:    `cal_${Date.now()}`,
          type:  "calendar",
          label: `Schedule follow-up: ${processed.suggestedFollowUpMeeting.suggestedAgenda}`,
          data:  processed.suggestedFollowUpMeeting,
        });
      }

      // Soft commitments → Reminders
      (processed.softCommitments || []).forEach((commitment) => {
        pendingItems.push({
          id:    `remind_${Date.now()}_${Math.random()}`,
          type:  "reminder",
          label: `Reminder: ${commitment.person} — "${commitment.commitment}"`,
          data:  commitment,
        });
      });

      // 8. Save approval queue
      const saved = await cosmosService.savePendingItems(
        userId,
        meetingId || eventId,
        pendingItems
      );

      // 9. Save meeting record for future pre-call context
      await cosmosService.saveMeetingRecord(userId, meetingId || eventId, {
        subject:      meetingInfo.subject,
        attendees:    meetingInfo.attendees,
        date:         meetingInfo.date,
        summary:      processed.summary,
        keyDecisions: processed.keyDecisions,
        actionItems:  processed.actionItems || [],
        transcript:   transcript.slice(0, 5000),
      });

      return jsonResponse({
        success: true,
        processed,
        pendingItems: saved.items,
        batchId:      saved.id,
        meta: {
          emailDraftCount:    processed.followUpEmails?.length || 0,
          hasFollowUpMeeting: processed.suggestedFollowUpMeeting?.needed || false,
          hasEffectiveness:   !!processed.meetingEffectiveness,
          hasEngagement:      !!processed.meetingEngagement,
        },
      });
    } catch (err) {
      context.error("[PostMeeting] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});