// functions/postMeetingProcess.js
// HTTP Trigger: POST /api/post-meeting-process
// Body: { meetingId, transcript (optional), eventId }
// Extracts action items, drafts emails, ranks urgency.
// Returns everything for user approval — nothing is sent automatically.

const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const openaiService = require("../services/openaiService");
const cosmosService = require("../services/cosmosService");
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

      context.log(`[PostMeeting] Processing meeting: ${meetingId || eventId}`);

      // 1. Get the calendar event for metadata
      let event = null;
      if (eventId) {
        event = await graphService.getEvent(accessToken, eventId);
      }

      // 2. Try to get Teams transcript (requires Teams Premium license)
      let transcript = providedTranscript;
      if (!transcript && meetingId) {
        transcript = await graphService.getMeetingTranscripts(
          accessToken,
          meetingId
        );
      }

      // 3. If no transcript, use email context as a fallback
      if (!transcript && event) {
        const attendeeEmails = (event.attendees || [])
          .map((a) => a.emailAddress?.address)
          .filter(Boolean);
        const emails = await graphService.getEmailsFromAttendees(
          accessToken,
          attendeeEmails,
          10
        );

        // Simulate transcript from recent emails (demo fallback)
        transcript = emails.value
          ?.map(
            (e) =>
              `${e.from?.emailAddress?.name}: [via email] ${e.subject}\n${e.bodyPreview}`
          )
          .join("\n\n");
      }

      if (!transcript) {
        return errorResponse(
          "No transcript or meeting content available. Teams transcript requires Teams Premium.",
          404
        );
      }

      // 4. Process with AI
      const meetingInfo = {
        subject: event?.subject || "Team Meeting",
        date: event?.start?.dateTime || new Date().toISOString(),
        attendees: event?.attendees?.map(
          (a) => `${a.emailAddress?.name} <${a.emailAddress?.address}>`
        ) || [],
      };

      const processed = await openaiService.processPostCall(
        transcript,
        meetingInfo
      );

      // 5. Build approval queue items
      const pendingItems = [];

      // Action items → To-Do tasks
      (processed.actionItems || []).forEach((item) => {
        pendingItems.push({
          id: item.id || `ai_${Date.now()}_${Math.random()}`,
          type: "task",
          label: `Add task: "${item.task}"`,
          data: {
            title: item.task,
            owner: item.owner,
            deadline: item.deadline,
            urgency: item.urgency,
          },
        });
      });

      // Draft emails
      (processed.followUpEmails || []).forEach((email) => {
        pendingItems.push({
          id: email.id || `email_${Date.now()}_${Math.random()}`,
          type: "email",
          label: `Send email: "${email.subject}"`,
          data: email,
        });
      });

      // Follow-up meeting
      if (processed.suggestedFollowUpMeeting?.needed) {
        pendingItems.push({
          id: `cal_${Date.now()}`,
          type: "calendar",
          label: `Schedule follow-up: ${processed.suggestedFollowUpMeeting.suggestedAgenda}`,
          data: processed.suggestedFollowUpMeeting,
        });
      }

      // Soft commitments → Reminders
      (processed.softCommitments || []).forEach((commitment) => {
        pendingItems.push({
          id: `remind_${Date.now()}_${Math.random()}`,
          type: "reminder",
          label: `Reminder: ${commitment.person} — "${commitment.commitment}"`,
          data: commitment,
        });
      });

      // 6. Save to Cosmos DB (approval queue)
      const saved = await cosmosService.savePendingItems(
        userId,
        meetingId || eventId,
        pendingItems
      );

      // 7. Save meeting record for future pre-call context
      await cosmosService.saveMeetingRecord(userId, meetingId || eventId, {
        subject: meetingInfo.subject,
        attendees: meetingInfo.attendees,
        date: meetingInfo.date,
        summary: processed.summary,
        keyDecisions: processed.keyDecisions,
        transcript: transcript.slice(0, 5000), // Store first 5k chars
      });

      return jsonResponse({
        success: true,
        processed,
        pendingItems: saved.items,
        batchId: saved.id,
        meta: {
          actionItemCount: processed.actionItems?.length || 0,
          emailDraftCount: processed.followUpEmails?.length || 0,
          hasFollowUpMeeting: processed.suggestedFollowUpMeeting?.needed || false,
        },
      });
    } catch (err) {
      context.error("[PostMeeting] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});
