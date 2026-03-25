// src/components/PreCallBrief.jsx
import React, { useEffect, useState } from "react";
import { getEvents, getPreMeetingBrief } from "../services/api";
import { formatDistanceToNow } from "date-fns";
import MeetingNotes from "./MeetingNotes";

// ─────────────────────────────────────────────
// Date / time helpers
// ─────────────────────────────────────────────

function getDateString(start) {
  if (!start) return null;
  let raw = null; let tzName = null;
  if (typeof start === "string") { raw = start; }
  else if (start?.dateTime)       { raw = start.dateTime; tzName = start.timeZone || null; }
  if (!raw) return null;
  if (/[+-]\d{2}:\d{2}$/.test(raw) || raw.endsWith("Z")) return raw;
  const TZ_MAP = {
    "India Standard Time": "+05:30", "Asia/Kolkata": "+05:30",
    "UTC": "Z", "Coordinated Universal Time": "Z",
    "Pacific Standard Time": "-08:00", "Pacific Daylight Time": "-07:00",
    "Eastern Standard Time": "-05:00", "Eastern Daylight Time": "-04:00",
  };
  if (tzName && TZ_MAP[tzName]) {
    const mapped = TZ_MAP[tzName];
    return mapped === "Z" ? raw + "Z" : raw + mapped;
  }
  return raw + "+05:30";
}

function safeFormatTime(start) {
  const s = getDateString(start); if (!s) return "TBD";
  try { return new Date(s).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }); }
  catch { return "TBD"; }
}

function safeFormatDate(start) {
  const s = getDateString(start); if (!s) return "";
  try { return new Date(s).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short", day: "numeric" }); }
  catch { return ""; }
}

function safeFormatFull(start) {
  const s = getDateString(start); if (!s) return "";
  try { return new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }); }
  catch { return s; }
}

function safeDistance(start) {
  const s = getDateString(start); if (!s) return "";
  try { return formatDistanceToNow(new Date(s), { addSuffix: true }); }
  catch { return ""; }
}

function safeFormatShort(dateValue) {
  if (!dateValue) return null;
  try { return new Date(dateValue).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch { return null; }
}

// ─────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────

export default function PreCallBrief() {
  const [events,        setEvents]       = useState([]);
  const [loadingEvents,setLoadingEvents]= useState(true);
  const [selectedEvent,setSelectedEvent]= useState(null);
  const [brief,         setBrief]        = useState(null);
  const [loadingBrief, setLoadingBrief] = useState(false);
  const [error,         setError]        = useState(null);
  const [notesMode,     setNotesMode]    = useState(null);

  useEffect(() => {
    getEvents()
      .then((r) => setEvents(r.events || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoadingEvents(false));
  }, []);

  const handleSelectEvent = async (event) => {
    setSelectedEvent(event);
    setBrief(null);
    setLoadingBrief(true);
    setError(null);
    try {
      const result = await getPreMeetingBrief(event.id);
      setBrief(result);
    } catch (e) { setError(e.message); }
    finally { setLoadingBrief(false); }
  };

  if (notesMode) {
    return (
      <MeetingNotes
        event={notesMode.event}
        brief={notesMode.brief}
        onBack={() => setNotesMode(null)}
      />
    );
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Pre-Call Brief</div>
        <div className="page-subtitle">Select a meeting to get an AI-powered briefing before you join.</div>
      </div>

      {error && <div className="error-state">⚠️ {error}</div>}

      <div className="content-grid">
        <div className="card">
          <div className="card-header"><div className="card-title">Upcoming Meetings</div></div>
          {loadingEvents ? (
            <div className="loading-state" style={{ padding: 30 }}><div className="spinner" /></div>
          ) : events.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📅</div>
              <div className="empty-text">No upcoming meetings in the next 7 days.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {events.map((event) => (
                <div
                  key={event.id}
                  className="meeting-item"
                  style={{
                    background:  selectedEvent?.id === event.id ? "var(--accent-light)" : undefined,
                    borderColor: selectedEvent?.id === event.id ? "var(--accent)"       : undefined,
                  }}
                  onClick={() => handleSelectEvent(event)}
                >
                  <div className="meeting-time-block">
                    <div className="meeting-time">{safeFormatTime(event.start)}</div>
                    <div className="meeting-duration">{safeFormatDate(event.start)}</div>
                  </div>
                  <div className="meeting-info">
                    <div className="meeting-title">{event.subject}</div>
                    <div className="meeting-meta">
                      {event.attendees?.length || 0} attendees · {safeDistance(event.start)}
                      {event.isOnline && (
                        <span style={{ marginLeft: 6, background: "var(--green-light)", color: "var(--green)", padding: "1px 6px", borderRadius: 10, fontSize: 10, fontWeight: 600 }}>
                          Online
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, flexShrink: 0 }}>
                    <button className="btn btn-primary" style={{ fontSize: 12, padding: "6px 12px" }}>
                      Brief →
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: "4px 10px", whiteSpace: "nowrap" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const existingBrief = selectedEvent?.id === event.id && brief ? brief : null;
                        setNotesMode({ event, brief: existingBrief });
                      }}
                    >
                      📝 Notes
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ overflow: "hidden", minWidth: 0 }}>
          {!selectedEvent ? (
            <div className="empty-state" style={{ padding: 60 }}>
              <div className="empty-icon">👈</div>
              <div className="empty-text">Select a meeting to generate your brief.</div>
            </div>
          ) : loadingBrief ? (
            <div className="loading-state">
              <div className="spinner" />
              <div className="loading-text">Analysing emails, past meetings, and documents…</div>
            </div>
          ) : brief ? (
            <BriefDisplay brief={brief.brief} event={brief.event} meta={brief.meta} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// BriefDisplay — using Consolidated Agenda Today
// ─────────────────────────────────────────────

function BriefDisplay({ brief, event, meta }) {
  const joinUrl = event?.joinUrl || event?.onlineMeeting?.joinUrl;
  
  const evidenceItems = [
    { label: "Emails",       value: meta?.emailsAnalyzed      || 0 },
    { label: "Past Meetings",value: meta?.previousMeetingsFound || 0 },
    { label: "Jira Issues",  value: meta?.enabled ? (meta?.matchedIssueCount || 0) : 0 },
  ];
  
  return (
    <div style={{ overflowY: "auto", overflowX: "hidden", maxHeight: "78vh", paddingRight: 6, width: "100%", boxSizing: "border-box" }}>

      <div style={{ marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, wordBreak: "break-word", overflowWrap: "anywhere" }}>
          {brief?.meetingTitle || event?.subject}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{safeFormatFull(event?.start)}</span>
          {joinUrl && (
            <a href={joinUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "white", fontWeight: 600, background: "var(--accent)", padding: "3px 10px", borderRadius: 12, textDecoration: "none", whiteSpace: "nowrap" }}>
              Join →
            </a>
          )}
        </div>
      </div>

      <BriefSection icon="🛡️" title="How This Brief Was Prepared">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, marginBottom: 10 }}>
          {evidenceItems.map((item) => (
            <div key={item.label} style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--accent)", lineHeight: 1.1, marginBottom: 4 }}>{item.value}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{item.label}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, padding: "10px 12px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)", wordBreak: "break-word" }}>
          These insights are grounded in communication history, prior meeting context, and linked Jira execution data.
        </div>
      </BriefSection>

      {brief?.keyContext && (
        <BriefSection icon="💡" title="Key Context">
          <div style={{ fontSize: 13, background: "var(--accent-light)", padding: 10, borderRadius: 8, borderLeft: "3px solid var(--accent)", wordBreak: "break-word", overflowWrap: "anywhere", lineHeight: 1.6 }}>
            {brief.keyContext}
          </div>
        </BriefSection>
      )}

      {brief?.currentStatus && (
        <BriefSection icon="📊" title="Current Status">
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, wordBreak: "break-word", overflowWrap: "anywhere" }}>
            {brief.currentStatus}
          </p>
        </BriefSection>
      )}

      {(brief?.preMeetingChecks || []).length > 0 && (
        <BriefSection icon="👀" title="Before You Join">
          {brief.preMeetingChecks.map((item, i) => <PrepItem key={i} item={item} />)}
        </BriefSection>
      )}

      {brief?.executionContext && (
        <BriefSection
          icon="🧩"
          title={brief.executionContext.title || "Jira Overview"}
          subtitle={brief.executionContext.spaceName ? `Space — ${brief.executionContext.spaceName}` : undefined}
        >
          {brief.executionContext.statusLine && (
            <div style={{ marginBottom: 12, padding: "10px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              {brief.executionContext.statusLine}
            </div>
          )}
          {(brief.executionContext.blockers || []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                What's Blocking the Team?
              </div>
              {brief.executionContext.blockers.map((item, i) => (
                <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 13 }}>
                  <span style={{ color: "var(--red, #dc2626)", flexShrink: 0 }}>•</span>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          )}
        </BriefSection>
      )}

      {/* Rich Agenda Today (Replaces Likely Discuss & Open Points) */}
      {(brief?.agenda || brief?.agendaForToday || []).length > 0 && (
        <BriefSection icon="🎯" title="Agenda Today">
          {(brief.agenda || brief.agendaForToday).map((item, i) => <PrepItem key={i} item={item} />)}
        </BriefSection>
      )}

      {(brief?.assignedToMe || []).length > 0 && (
        <BriefSection icon="📌" title="My Open Jira Items">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {brief.assignedToMe.map((issue) => <IssueCard key={issue.key} issue={issue} />)}
          </div>
        </BriefSection>
      )}

      {brief?.followUps && (
        <BriefSection
          icon="🔁"
          title="Last Meeting Follow-ups"
          subtitle={`${brief.followUps.subject || ""}${brief.followUps.date ? " · " + brief.followUps.date : ""}`}
        >
          {brief.followUps.narrative && (
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.65, marginBottom: 14, padding: "10px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", wordBreak: "break-word", overflowWrap: "anywhere" }}>
              {brief.followUps.narrative}
            </div>
          )}
          {(brief.followUps.items || []).map((a, i) => <ActionItem key={i} item={a} />)}
        </BriefSection>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────

function BriefSection({ icon, title, subtitle, children }) {
  return (
    <div className="brief-section">
      <div className="brief-section-title" style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 4 }}>
        <span>{icon} {title}</span>
        {subtitle && <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-tertiary)", wordBreak: "break-word" }}>{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function ActionItem({ item }) {
  const done = item.status === "done";
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 10px", marginBottom: 6, borderRadius: 8, background: done ? "#f0fdf4" : "#fff7ed", borderLeft: `3px solid ${done ? "#16a34a" : "#ea580c"}`, boxSizing: "border-box", width: "100%", minWidth: 0 }}>
      <span style={{ fontSize: 14, marginTop: 1, flexShrink: 0 }}>{done ? "✅" : "⏳"}</span>
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ fontSize: 13, wordBreak: "break-word", overflowWrap: "anywhere" }}>
          <span style={{ fontWeight: 600, color: "var(--accent)" }}>{item.owner}</span>
          <span style={{ color: "var(--text-secondary)" }}> — {item.task}</span>
        </div>
        {item.evidence && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 3, fontStyle: "italic", wordBreak: "break-word" }}>{item.evidence}</div>}
        {done && item.emailId && (
          <a href={`https://outlook.live.com/mail/0/inbox/${item.emailId}`} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, textDecoration: "none", display: "inline-block", marginTop: 4 }}>
            📧 {item.emailSubject || "View confirmation"} →
          </a>
        )}
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: done ? "#16a34a" : "#ea580c", color: "white", whiteSpace: "nowrap", flexShrink: 0 }}>
        {done ? "DONE" : "PENDING"}
      </span>
    </div>
  );
}

function PrepItem({ item }) {
  const issues = item.issues || (item.issue ? [item.issue] : []);
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 8, paddingBottom: issues.length ? 8 : 0, fontSize: 13, wordBreak: "break-word", overflowWrap: "anywhere" }}>
        <span style={{ color: "var(--accent)", flexShrink: 0 }}>→</span>
        <span>{item.text}</span>
      </div>
      {issues.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {issues.map((issue) => <IssueCard key={issue.key} issue={issue} compact />)}
        </div>
      )}
    </div>
  );
}

function IssueCard({ issue, compact = false }) {
  const dueDate   = safeFormatShort(issue.dueDate);
  const updatedAt = safeFormatShort(issue.updatedAt);
  const isDone    = /^(done|closed|resolved)$/i.test(issue.status || "");
  const statusColor = issue.isBlocked ? "var(--red, #dc2626)" : isDone ? "var(--green)" : "var(--accent)";
  const statusBg    = issue.isBlocked ? "var(--red-light, #fee2e2)" : isDone ? "var(--green-light)" : "var(--accent-light)";

  const card = (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--surface, var(--bg))" }}>
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 700, marginBottom: 3 }}>{issue.key}</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", wordBreak: "break-word" }}>{issue.title}</div>
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 999, whiteSpace: "nowrap", color: statusColor, background: statusBg }}>
          {issue.status}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 11, color: "var(--text-secondary)" }}>
        <span>{issue.assignee || "Unassigned"}</span>
        <span>•</span><span>{issue.priority || "No priority"}</span>
        {dueDate   && <><span>•</span><span>Due {dueDate}</span></>}
        {updatedAt && <><span>•</span><span>Updated {updatedAt}</span></>}
        {issue.isBlocked && <><span>•</span><span style={{ color: "var(--red, #dc2626)", fontWeight: 600 }}>Blocked</span></>}
      </div>
    </div>
  );

  if (!issue.url) return card;
  return (
    <a href={issue.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      {card}
    </a>
  );
}