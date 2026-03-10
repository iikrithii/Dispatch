// functions/approveItem.js
// HTTP Trigger: POST /api/approve-item
// Body: { batchId, itemId, action: "approve" | "reject" }
// When approved, executes the actual action (create task, send email, etc.)

const { app } = require("@azure/functions");
const graphService = require("../services/graphService");
const cosmosService = require("../services/cosmosService");
const { extractAuth, jsonResponse, errorResponse } = require("../utils/auth");

app.http("approveItem", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "approve-item",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return jsonResponse({});

    try {
      const { accessToken, userId } = extractAuth(req);
      const { batchId, itemId, action } = await req.json();

      if (!batchId || !itemId || !action) {
        return errorResponse("batchId, itemId, and action are required", 400);
      }

      context.log(`[Approve] ${action} item ${itemId} from batch ${batchId}`);

      // Update status in Cosmos
      const updated = await cosmosService.updateItemStatus(
        userId,
        batchId,
        itemId,
        action === "approve" ? "approved" : "rejected"
      );

      // Find the item that was approved
      const item = updated.items?.find((i) => i.id === itemId);

      if (action !== "approve" || !item) {
        return jsonResponse({ success: true, action: "rejected" });
      }

      // Execute the approved action
      let executionResult = null;

      switch (item.type) {
        case "task": {
          try {
            const list = await graphService.getOrCreateDispatchList(accessToken);
            executionResult = await graphService.createTask(
              accessToken,
              list.id,
              {
                title: item.data.title,
                notes: `Owner: ${item.data.owner}\nUrgency: ${item.data.urgency}`,
                dueDate: item.data.deadline,
              }
            );
          } catch (taskErr) {
            // Fallback — create in default To-Do list
            const lists = await graphService.getTaskLists(accessToken);
            const defaultList = lists.value?.[0];
            if (defaultList) {
              executionResult = await graphService.createTask(
                accessToken,
                defaultList.id,
                { title: item.data.title, notes: `Owner: ${item.data.owner}` }
              );
            }
          }
          break;
        }

        case "email": {
          // Create a draft email (does NOT send — user sends from Outlook)
          if (item.data.to && item.data.subject) {
            executionResult = await graphService.createDraftEmail(
              accessToken,
              {
                toEmails: Array.isArray(item.data.to) ? item.data.to : [item.data.to],
                subject: item.data.subject,
                body: item.data.body,
              }
            );
          }
          break;
        }

        case "reminder": {
          // Save reminder to Cosmos
          executionResult = await cosmosService.saveReminder(userId, {
            text: item.data.commitment,
            dueDate: item.data.estimatedDeadline,
            owner: item.data.person,
            meetingId: batchId,
          });
          break;
        }

        // case "calendar": {
        //   // Just store the suggestion — user books via Calendar
        //   executionResult = {
        //     note: "Suggested follow-up saved. Open Calendar to book.",
        //     agenda: item.data.suggestedAgenda,
        //     timeframe: item.data.suggestedTimeframe,
        //   };
        //   break;
        // }
        case "calendar": {
        try {
          const now = new Date();
          const start = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 1 week from now
          const end = new Date(start.getTime() + 30 * 60 * 1000); // 30 min meeting
        
          executionResult = await graphService.createCalendarEvent(
            accessToken,
            {
              subject: item.data.suggestedAgenda || "Follow-up Meeting",
              body: `Follow-up scheduled by Dispatch.\nAgenda: ${item.data.suggestedAgenda}`,
              start: start.toISOString(),
              end: end.toISOString(),
              attendeeEmails: [],
            }
          );
        } catch (calErr) {
          executionResult = { note: "Calendar event creation failed", error: calErr.message };
        }
        break;
    }
      }

      return jsonResponse({
        success: true,
        action: "approved",
        itemType: item.type,
        executionResult,
      });
    } catch (err) {
      context.error("[Approve] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});
