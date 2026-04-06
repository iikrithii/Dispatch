// functions/getHandoverReport.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP Trigger: GET /api/handover-report
// Query params: threadId, projectName, nextMeetingId (same as project-details)
//
// Returns a PDF binary (application/pdf) — the browser opens/downloads it directly.
// ─────────────────────────────────────────────────────────────────────────────

const { app }       = require("@azure/functions");
const PDFDocument   = require("pdfkit");
const cosmosService = require("../services/cosmosService");
const { generateHandoverReport } = require("../services/openaiService");
const { extractAuth, errorResponse } = require("../utils/auth");

const STOP_WORDS = new Set([
  "with","from","this","that","have","will","been","your","meeting","call",
  "sync","review","weekly","update","prep","follow","about","just","also",
]);
function tokenize(text = "") {
  return (text || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

// ── Colour palette (matches Dispatch UI) ──────────────────────────────────────
const C = {
  accent:    "#4f46e5",
  textPri:   "#111827",
  textSec:   "#6b7280",
  border:    "#e5e7eb",
  tagBg:     "#eef2ff",
  high:      "#b91c1c",
  medium:    "#92400e",
  low:       "#166534",
  done:      "#166534",
  pending:   "#c2410c",
  white:     "#ffffff",
  lightGray: "#f9fafb",
};

// ── PDF helpers ───────────────────────────────────────────────────────────────
// function hex(h) {
//   const r = parseInt(h.slice(1,3),16),
//         g = parseInt(h.slice(3,5),16),
//         b = parseInt(h.slice(5,7),16);
//   return [r/255, g/255, b/255];
// }
// function setFill(doc, h)   { doc.fillColor(hex(h));   return doc; }
// function setStroke(doc, h) { doc.strokeColor(hex(h)); return doc; }

function setFill(doc, h)   { doc.fillColor(h);   return doc; }
function setStroke(doc, h) { doc.strokeColor(h); return doc; }

const MARGIN = 48;
const PAGE_W = 595; // A4
const CONTENT_W = PAGE_W - MARGIN * 2;

function sectionHeader(doc, title, y) {
  // Accent rule
  setFill(doc, C.accent);
  doc.rect(MARGIN, y, CONTENT_W, 1.5).fill();
  y += 6;
  setFill(doc, C.accent);
  doc.font("Helvetica-Bold").fontSize(11).text(title.toUpperCase(), MARGIN, y, {
    characterSpacing: 0.8,
  });
  y += 20;
  return y;
}

function bodyText(doc, text, y, opts = {}) {
  setFill(doc, opts.color || C.textPri);
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica")
     .fontSize(opts.size || 9.5)
     .text(text, MARGIN + (opts.indent || 0), y, {
       width: CONTENT_W - (opts.indent || 0),
       lineGap: 2,
     });
  return doc.y + (opts.gap ?? 6);
}

function bullet(doc, text, y, color = C.textPri) {
  setFill(doc, C.accent);
  doc.circle(MARGIN + 5, y + 4, 2).fill();
  setFill(doc, color);
  doc.font("Helvetica").fontSize(9.5).text(text, MARGIN + 14, y, {
    width: CONTENT_W - 14, lineGap: 2,
  });
  return doc.y + 5;
}

function tag(doc, label, x, y, bgHex, textHex) {
  const w = doc.widthOfString(label, { fontSize: 8 }) + 12;
  setFill(doc, bgHex); setStroke(doc, bgHex);
  doc.roundedRect(x, y - 1, w, 14, 3).fill();
  setFill(doc, textHex);
  doc.font("Helvetica-Bold").fontSize(8).text(label, x + 6, y + 1, { lineBreak: false });
  return x + w + 6;
}

function maybeNewPage(doc, y, needed = 60) {
  if (y > 780) { doc.addPage(); return MARGIN; }
  return y;
}

// ─────────────────────────────────────────────────────────────────────────────
app.http("getHandoverReport", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "handover-report",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") {
      return { status: 200, headers: { "Access-Control-Allow-Origin": "*" } };
    }

    try {
      const { userId } = extractAuth(req);
      const threadId    = req.query.get("threadId")    || "";
      const projectName = req.query.get("projectName") || "";

      if (!threadId && !projectName) {
        return errorResponse("threadId or projectName is required", 400);
      }

      // ── 1. Fetch raw data (mirrors getProjectDetails) ────────────────────
      const keywords   = tokenize(projectName);
      const meetings   = await cosmosService.getPreviousMeetings(userId, [], keywords, 8);
      const allPending = await cosmosService.getPendingItems(userId);

      const meetingIds   = new Set(meetings.map((m) => m.meetingId || m.id));
      const pendingTasks = allPending
        .filter((b) => meetingIds.has(b.meetingId))
        .flatMap((b) => (b.items || []).filter((i) => i.status === "pending"))
        .slice(0, 30);

      const attendeeMap = new Map();
      for (const m of meetings) {
        for (const a of (m.attendees || [])) {
          const match = typeof a === "string" ? a.match(/^(.+?)\s*<(.+?)>$/) : null;
          const name  = match ? match[1].trim() : (typeof a === "string" ? a : a.name || "");
          const email = match ? match[2].trim() : (typeof a === "object" ? a.email : a);
          const key   = email || name;
          if (!key) continue;
          if (!attendeeMap.has(key)) attendeeMap.set(key, { name, email, taskCount: 0 });
          for (const item of pendingTasks) {
            if ((item.data?.owner || "").toLowerCase().includes((name || "").toLowerCase().split(" ")[0]))
              attendeeMap.get(key).taskCount++;
          }
        }
      }
      const attendees = Array.from(attendeeMap.values());

      const emailThreads = threadId
        ? [{ subject: projectName, conversationId: threadId }]
        : [];

      // ── 2. LLM — generate handover narrative ─────────────────────────────
      const narrative = await generateHandoverReport({
        projectName,
        meetings,
        pendingTasks,
        attendees,
        emailThreads,
      });

      // ── 3. Build PDF ──────────────────────────────────────────────────────
      const buffers = [];
      const doc     = new PDFDocument({ size: "A4", margin: MARGIN, autoFirstPage: true });
      doc.on("data", (chunk) => buffers.push(chunk));

      await new Promise((resolve, reject) => {
        doc.on("end",   resolve);
        doc.on("error", reject);

        const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
        let y = MARGIN;

        // ── Cover header bar ──────────────────────────────────────────────
        setFill(doc, C.accent);
        doc.rect(0, 0, PAGE_W, 6).fill();

        // Dispatch wordmark
        setFill(doc, C.accent);
        doc.font("Helvetica-Bold").fontSize(10).text("DISPATCH", MARGIN, y, { lineBreak: false });
        setFill(doc, C.textSec);
        doc.font("Helvetica").fontSize(9).text("  ·  Project Handover Report", MARGIN + 58, y + 1, { lineBreak: false });
        setFill(doc, C.textSec);
        doc.font("Helvetica").fontSize(9).text(today, { align: "right", lineBreak: false });
        y += 28;

        // Project title
        setFill(doc, C.textPri);
        doc.font("Helvetica-Bold").fontSize(22).text(projectName || "Project Handover", MARGIN, y, { width: CONTENT_W });
        y = doc.y + 6;

        if (narrative.oneLiner) {
          setFill(doc, C.textSec);
          doc.font("Helvetica").fontSize(10.5).text(narrative.oneLiner, MARGIN, y, { width: CONTENT_W });
          y = doc.y + 16;
        }

        // Divider
        setStroke(doc, C.border);
        doc.moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).lineWidth(0.5).stroke();
        y += 18;

        // ── § 1  Project Overview ─────────────────────────────────────────
        y = sectionHeader(doc, "1  Project Overview", y);
        y = bodyText(doc, narrative.overview || "No overview available.", y);

        if (narrative.currentStatus) {
          y += 4;
          setFill(doc, C.tagBg);
          doc.roundedRect(MARGIN, y, CONTENT_W, 32, 4).fill();
          setFill(doc, C.accent);
          doc.font("Helvetica-Bold").fontSize(8.5).text("CURRENT STATUS", MARGIN + 10, y + 6);
          setFill(doc, C.textPri);
          doc.font("Helvetica").fontSize(9).text(narrative.currentStatus, MARGIN + 10, y + 18, { width: CONTENT_W - 20 });
          y = doc.y + 14;
        }

        // ── § 2  Meeting History & Key Decisions ──────────────────────────
        y = maybeNewPage(doc, y);
        y += 10;
        y = sectionHeader(doc, "2  Meeting History & Key Decisions", y);

        const meetingList = narrative.meetingHistory || [];
        if (meetingList.length === 0) {
          y = bodyText(doc, "No meeting records found.", y, { color: C.textSec });
        } else {
          for (const m of meetingList) {
            y = maybeNewPage(doc, y, 80);
            // Date + subject
            const dateStr = m.date
              ? new Date(m.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
              : "Date unknown";
                    
            setFill(doc, C.textSec);
            doc.font("Helvetica").fontSize(8.5).text(dateStr, MARGIN, y);
            y = doc.y + 2;
                    
            setFill(doc, C.textPri);
            doc.font("Helvetica-Bold").fontSize(9.5).text(m.subject || "Untitled", MARGIN, y, { width: CONTENT_W });
            y = doc.y + 4;

            if (m.summary) {
              y = bodyText(doc, m.summary, y, { indent: 10, color: C.textSec, size: 9 });
            }
            if ((m.decisions || []).length > 0) {
              for (const d of m.decisions) {
                y = bullet(doc, "Decision: " + d, y, C.textPri);
              }
            }
            y += 6;
          }
        }

        // ── § 3  Open Action Items ────────────────────────────────────────
        y = maybeNewPage(doc, y);
        y += 6;
        y = sectionHeader(doc, "3  Open Action Items", y);

        const actions = narrative.openActionItems || [];
        if (actions.length === 0) {
          y = bodyText(doc, "No pending action items.", y, { color: C.textSec });
        } else {
          for (const a of actions) {
            y = maybeNewPage(doc, y, 40);
            // Status tag inline
            const tagColor = a.status === "done" ? C.done : C.pending;
            const tagLabel = (a.status || "pending").toUpperCase();
            let tx = MARGIN + 14;
            tx = tag(doc, tagLabel, tx, y, a.status === "done" ? "#f0fdf4" : "#fff7ed", tagColor);
            setFill(doc, C.textPri);
            doc.font("Helvetica").fontSize(9.5).text(a.task || "", tx, y, {
              width: CONTENT_W - (tx - MARGIN),
              lineBreak: false,
            });
            y = doc.y + 4;
            if (a.owner) {
              setFill(doc, C.textSec);
              doc.font("Helvetica").fontSize(8.5).text(`Owner: ${a.owner}`, MARGIN + 14, y);
              y = doc.y + 6;
            }
          }
        }

        // ── § 4  Key People & Roles ───────────────────────────────────────
        y = maybeNewPage(doc, y);
        y += 6;
        y = sectionHeader(doc, "4  Key People & Roles", y);

        const people = narrative.keyPeople || [];
        if (people.length === 0) {
          y = bodyText(doc, "No attendee data found.", y, { color: C.textSec });
        } else {
          // 2-column grid
          const col = (CONTENT_W - 10) / 2;
          people.forEach((person, i) => {
            y = maybeNewPage(doc, y, 40);
            const xOff = (i % 2) * (col + 10);
            const rowY  = i % 2 === 0 ? y : y; // track row start for even-indexed

            setFill(doc, C.lightGray);
            doc.roundedRect(MARGIN + xOff, y, col, 34, 4).fill();

            // Avatar circle
            setFill(doc, C.accent);
            doc.circle(MARGIN + xOff + 18, y + 17, 12).fill();
            setFill(doc, C.white);
            doc.font("Helvetica-Bold").fontSize(10).text(
              (person.name || "?").charAt(0).toUpperCase(),
              MARGIN + xOff + 12, y + 11,
              { lineBreak: false }
            );

            setFill(doc, C.textPri);
            doc.font("Helvetica-Bold").fontSize(9).text(
              person.name || person.email || "Unknown",
              MARGIN + xOff + 36, y + 6,
              { width: col - 40, lineBreak: false }
            );
            if (person.role || person.email) {
              setFill(doc, C.textSec);
              doc.font("Helvetica").fontSize(8).text(
                person.role || person.email || "",
                MARGIN + xOff + 36, y + 19,
                { width: col - 40, lineBreak: false }
              );
            }

            if (i % 2 === 1) y += 42; // advance row after right column
            else if (i === people.length - 1) y += 42; // last item, odd count
          });
          y += 6;
        }

        // ── § 5  Email Thread Context ─────────────────────────────────────
        if ((narrative.emailContext || []).length > 0) {
          y = maybeNewPage(doc, y);
          y += 6;
          y = sectionHeader(doc, "5  Email Thread Context", y);
          for (const e of narrative.emailContext) {
            y = maybeNewPage(doc, y, 40);
            y = bodyText(doc, e.subject || "(no subject)", y, { bold: true, size: 9.5 });
            if (e.summary) y = bodyText(doc, e.summary, y, { indent: 10, color: C.textSec, size: 9 });
            y += 4;
          }
        }

        // ── § 6  Day-One Checklist ────────────────────────────────────────
        if ((narrative.dayOneChecklist || []).length > 0) {
          y = maybeNewPage(doc, y);
          y += 6;
          y = sectionHeader(doc, "6  What To Do On Day One", y);
          for (const item of narrative.dayOneChecklist) {
            y = maybeNewPage(doc, y, 24);
            // Checkbox square
            setStroke(doc, C.accent); setFill(doc, C.white);
            doc.roundedRect(MARGIN, y, 10, 10, 2).stroke();
            setFill(doc, C.textPri);
            doc.font("Helvetica").fontSize(9.5).text(item, MARGIN + 16, y, { width: CONTENT_W - 16 });
            y = doc.y + 6;
          }
        }

        // ── Footer on each page ───────────────────────────────────────────
        const pages = doc.bufferedPageRange();
        for (let i = 0; i < pages.count; i++) {
          doc.switchToPage(pages.start + i);
          setFill(doc, C.border);
          doc.rect(0, 826, PAGE_W, 16).fill();
          setFill(doc, C.textSec);
          doc.font("Helvetica").fontSize(7.5)
            .text(`Dispatch · ${projectName} Handover · Generated ${today}`,
              MARGIN, 830, { lineBreak: false });
          doc.text(`Page ${i + 1} of ${pages.count}`,
            { align: "right", lineBreak: false });
        }

        doc.end();
      });

      const pdfBuffer = Buffer.concat(buffers);
      const safeName  = (projectName || "handover").replace(/[^a-z0-9]/gi, "_");

      return {
        status: 200,
        headers: {
          "Content-Type":        "application/pdf",
          "Content-Disposition": `inline; filename="${safeName}_handover.pdf"`,
          "Access-Control-Allow-Origin": "*",
        },
        body: pdfBuffer,
      };

    } catch (err) {
      context.error("[HandoverReport] Error:", err.message);
      return errorResponse(err.message);
    }
  },
});