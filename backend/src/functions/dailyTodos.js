// functions/dailyTodos.js
// HTTP Trigger: GET /api/daily-todos
// Returns a prioritized view of today's meetings, tasks, and urgent emails.

const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const openaiService = require("../services/openaiService");
const cosmosService = require("../services/cosmosService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

app.http("dailyTodos", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "daily-todos",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken, userId } = extractAuth(req);
      context.log(`[DailyTodos] Generating daily view for user: ${userId}`);

      // Fetch all data sources in parallel
      const [
        eventsResult,
        dispatchTasksResult,
        inboxResult,
        pendingApprovals,
        reminders,
      ] = await Promise.all([
        graphService.getTodayEvents(accessToken),
        graphService.getDispatchTasks(accessToken),
        graphService.getRecentInboxMessages(accessToken, 15),
        cosmosService.getPendingItems(userId),
        cosmosService.getActiveReminders(userId),
      ]);

      // const todayEvents = eventsResult.value || [];
      const todayEvents = (eventsResult.value || []).filter((e) => {
  if (!e.start?.dateTime) return false;
  const eventDate = e.start.dateTime.slice(0, 10); // "2026-03-06"
  const today = new Date().toLocaleDateString("en-CA", { 
    timeZone: "Asia/Kolkata" 
  }); // gives "2026-03-06" in IST
  return eventDate === today;
});
      const pendingTasks = dispatchTasksResult.value || [];
      const inboxMessages = inboxResult.value || [];

      // Filter for urgent/unread emails (simplified heuristic)
      const urgentEmails = inboxMessages.filter((m) => !m.isRead).slice(0, 5);

      // Count pending approvals across all batches
      const pendingItemCount = pendingApprovals.reduce((acc, batch) => {
        return (
          acc +
          (batch.items?.filter((i) => i.status === "pending").length || 0)
        );
      }, 0);

      // Generate AI-prioritized daily plan
      const priorities = await openaiService.generateDailyPriorities({
        todayEvents,
        pendingTasks,
        urgentEmails,
      });

      // Filter reminders that are due today or overdue
      const today = new Date().toISOString().split("T")[0];
      const dueReminders = reminders.filter(
        (r) => r.dueDate && r.dueDate.split("T")[0] <= today
      );

      return jsonResponse({
        success: true,
        priorities,
        rawData: {
          meetings: todayEvents.map((e) => ({
            id: e.id,
            subject: e.subject,
            start: e.start?.dateTime,
            end: e.end?.dateTime,
            attendeeCount: e.attendees?.length || 0,
            joinUrl: e.onlineMeeting?.joinUrl,
          })),
          tasks: pendingTasks.slice(0, 20),
          urgentEmailCount: urgentEmails.length,
          pendingApprovalCount: pendingItemCount,
          dueReminders,
        },
        meta: {
          generatedAt: new Date().toISOString(),
          meetingCount: todayEvents.length,
          taskCount: pendingTasks.length,
          hasOverdueItems: dueReminders.length > 0,
        },
      });
    } catch (err) {
      context.error("[DailyTodos] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});
