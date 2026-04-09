// functions/dailyTodos.js
// HTTP Trigger: GET /api/daily-todos
// Returns a prioritized view of today's meetings, tasks, and urgent emails.

const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const openaiService = require("../services/openaiService");
const cosmosService = require("../services/cosmosService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

function sanitizeForAI(text = "") {
  const blockedTerms = [
    "kill",
    "suicide",
    "murder",
    "bomb",
    "weapon",
    "gun",
    "blood",
    "abuse",
    "porn",
    "nude",
    "sex",
    "assault",
    "violence",
  ];

  let cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .trim();

  for (const term of blockedTerms) {
    const pattern = new RegExp(`\\b${term}\\b`, "gi");
    cleaned = cleaned.replace(pattern, "[redacted]");
  }

  return cleaned.slice(0, 180);
}

function buildFallbackDailyPriorities({ todayEvents = [], pendingTasks = [], urgentEmails = [] }) {
  const topPriorities = [];

  todayEvents.slice(0, 3).forEach((event, index) => {
    topPriorities.push({
      rank: topPriorities.length + 1,
      type: "meeting",
      title: event.subject || `Meeting ${index + 1}`,
      context: `${event.attendees?.length || 0} attendees${event.bodyPreview ? ` • ${sanitizeForAI(event.bodyPreview)}` : ""}`,
      time: event.start?.dateTime?.slice(11, 16) || null,
      action: "Prepare for meeting",
    });
  });

  pendingTasks.slice(0, Math.max(0, 3 - topPriorities.length)).forEach((task) => {
    topPriorities.push({
      rank: topPriorities.length + 1,
      type: "task",
      title: task.title || "Pending task",
      context: task.dueDateTime?.dateTime
        ? `Due ${task.dueDateTime.dateTime.slice(0, 16).replace("T", " ")}`
        : "No due date",
      time: null,
      action: "Make progress",
    });
  });

  if (topPriorities.length === 0 && urgentEmails.length > 0) {
    topPriorities.push({
      rank: 1,
      type: "email",
      title: sanitizeForAI(urgentEmails[0].subject || "Unread email"),
      context: `From ${urgentEmails[0].from?.emailAddress?.name || "unknown sender"}`,
      time: null,
      action: "Review email",
    });
  }

  return {
    greeting: "Good morning. Here's your daily plan.",
    topPriorities,
    meetingCount: todayEvents.length,
    overdueItems: pendingTasks
      .filter((task) => task.dueDateTime?.dateTime && task.dueDateTime.dateTime < new Date().toISOString())
      .slice(0, 3)
      .map((task) => task.title || "Overdue task"),
    endOfDayGoals: topPriorities.slice(0, 3).map((item) => `Close the loop on ${item.title}`),
  };
}

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
      const safeUrgentEmails = urgentEmails.map((email) => ({
        ...email,
        subject: sanitizeForAI(email.subject || ""),
        bodyPreview: sanitizeForAI(email.bodyPreview || ""),
        from: {
          ...email.from,
          emailAddress: {
            ...email.from?.emailAddress,
            name: sanitizeForAI(email.from?.emailAddress?.name || "Unknown sender"),
          },
        },
      }));

      // Count pending approvals across all batches
      const pendingItemCount = pendingApprovals.reduce((acc, batch) => {
        return (
          acc +
          (batch.items?.filter((i) => i.status === "pending").length || 0)
        );
      }, 0);

      // Generate AI-prioritized daily plan
      let priorities;
      try {
        priorities = await openaiService.generateDailyPriorities({
          todayEvents: todayEvents.map((event) => ({
            ...event,
            subject: sanitizeForAI(event.subject || ""),
            bodyPreview: sanitizeForAI(event.bodyPreview || ""),
          })),
          pendingTasks: pendingTasks.map((task) => ({
            ...task,
            title: sanitizeForAI(task.title || ""),
          })),
          urgentEmails: safeUrgentEmails,
        });
      } catch (aiError) {
        context.log(`[DailyTodos] Falling back after AI prioritization failed: ${aiError.message}`);
        priorities = buildFallbackDailyPriorities({
          todayEvents,
          pendingTasks,
          urgentEmails: safeUrgentEmails,
        });
      }

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
