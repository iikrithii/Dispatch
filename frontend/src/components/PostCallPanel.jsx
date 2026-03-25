// src/components/PostCallPanel.jsx

import React, { useState } from "react";
import { getEvents, processPostMeeting, approveItem } from "../services/api";

const ITEM_ICONS = {
  email:    "📧",
  calendar: "📅",
  reminder: "🔔",
};

// ─── Participation level colours ─────────────────────────────────────────────
const PARTICIPATION = {
  high:   { bg: "#f0fdf4", text: "#166534", border: "#86efac", label: "High"   },
  medium: { bg: "#eff6ff", text: "#1e40af", border: "#93c5fd", label: "Medium" },
  low:    { bg: "#fffbeb", text: "#92400e", border: "#fcd34d", label: "Low"    },
  silent: { bg: "#f9fafb", text: "#6b7280", border: "#e5e7eb", label: "Silent" },
};

// ─────────────────────────────────────────────────────────────────────────────
export default function PostCallPanel() {
  const [step,         setStep]         = useState("select");
  const [events,       setEvents]       = useState([]);
  const [loadingEvents,setLoadingEvents]= useState(false);
  const [selectedEvent,setSelectedEvent]= useState(null);
  const [transcript,   setTranscript]   = useState("");
  const [processing,   setProcessing]   = useState(false);
  const [results,      setResults]      = useState(null);
  const [batchId,      setBatchId]      = useState(null);
  const [itemStatuses, setItemStatuses] = useState({});
  const [error,        setError]        = useState(null);

  const loadEvents = async () => {
    setLoadingEvents(true);
    try {
      const r = await getEvents();
      setEvents(r.events || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingEvents(false);
    }
  };

  const handleProcess = async () => {
    if (!selectedEvent) return;
    setProcessing(true);
    setError(null);
    try {
      const result = await processPostMeeting({
        eventId:    selectedEvent.id,
        transcript: transcript || undefined,
      });
      setResults(result);
      setBatchId(result.batchId);
      setStep("results");
    } catch (e) {
      setError(e.message);
    } finally {
      setProcessing(false);
    }
  };

  const handleApprove = async (itemId, action) => {
    if (!batchId) return;
    setItemStatuses((s) => ({ ...s, [itemId]: "loading" }));
    try {
      await approveItem(batchId, itemId, action);
      setItemStatuses((s) => ({ ...s, [itemId]: action }));
    } catch (e) {
      console.error("Approve error:", e);
      setItemStatuses((s) => ({ ...s, [itemId]: action }));
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Post-Call Processing</div>
        <div className="page-subtitle">
          Extract follow-ups, analyse meeting effectiveness, and review engagement.
        </div>
      </div>

      {error && <div className="error-state">⚠️ {error}</div>}

      <div className="content-stack">
        {/* Step 1: Select Meeting */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">1. Select Meeting</div>
            <button className="btn btn-ghost" onClick={loadEvents} disabled={loadingEvents}>
              {loadingEvents ? "Loading…" : "Load Meetings"}
            </button>
          </div>
          {events.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Click "Load Meetings" to see your recent calendar events.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {events.slice(0, 8).map((event) => (
                <div
                  key={event.id}
                  onClick={() => setSelectedEvent(event)}
                  style={{
                    padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                    border: "1px solid",
                    borderColor: selectedEvent?.id === event.id ? "var(--accent)" : "var(--border)",
                    background:  selectedEvent?.id === event.id ? "var(--accent-light)" : "transparent",
                    display: "flex", alignItems: "center", gap: 10,
                  }}
                >
                  <span style={{ fontSize: 16 }}>📅</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{event.subject}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {event.start ? new Date(event.start).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                      · {event.attendeeCount || event.attendees?.length || 0} attendees
                    </div>
                  </div>
                  {selectedEvent?.id === event.id && (
                    <span style={{ color: "var(--accent)", fontWeight: 700 }}>✓</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Step 2: Transcript */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">2. Paste Transcript (Optional)</div>
            <span className="badge badge-accent" style={{ fontSize: 10 }}>
              Auto-fetched if Teams Premium
            </span>
          </div>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder={`Paste your meeting transcript here…\n\nIf you have Teams Premium, Dispatch will automatically fetch the transcript.\nOtherwise, paste the transcript text or meeting notes here.\n\nTip: speaker-labelled transcripts give better engagement analysis.`}
            style={{
              width: "100%", minHeight: 140, padding: "12px", borderRadius: 8,
              border: "1px solid var(--border)", fontSize: 13, fontFamily: "inherit",
              resize: "vertical", outline: "none", background: "var(--bg)",
            }}
          />
        </div>

        {/* Process button */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button
            className="btn btn-primary"
            onClick={handleProcess}
            disabled={!selectedEvent || processing}
            style={{ padding: "12px 28px" }}
          >
            {processing ? "Processing…" : "⚡ Process Meeting"}
          </button>
        </div>

        {/* Processing state */}
        {processing && (
          <div className="loading-state card">
            <div className="spinner" />
            <div className="loading-text">
              Analysing transcript, measuring effectiveness, reviewing engagement…
            </div>
          </div>
        )}

        {/* Results */}
        {results && step === "results" && (
          <PostCallResults
            results={results}
            itemStatuses={itemStatuses}
            onApprove={handleApprove}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PostCallResults
// ─────────────────────────────────────────────────────────────────────────────
function PostCallResults({ results, itemStatuses, onApprove }) {
  const { processed, pendingItems, meta } = results;

  return (
    <>
      {/* ── Summary ── */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Meeting Summary</div>
          <div style={{ display: "flex", gap: 8 }}>
            <span className="badge badge-accent">{meta?.emailDraftCount} emails</span>
            {meta?.hasEffectiveness && (
              <span className="badge badge-medium">Effectiveness scored</span>
            )}
          </div>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-primary)" }}>
          {processed?.summary}
        </p>
        {(processed?.keyDecisions || []).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="brief-section-title">Key Decisions Made</div>
            {processed.keyDecisions.map((d, i) => (
              <div key={i} style={{ fontSize: 13, padding: "6px 0", borderBottom: "1px solid var(--border)", color: "var(--text-primary)" }}>
                ✓ {d}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Meeting Effectiveness ── */}
      {processed?.meetingEffectiveness && (
        <EffectivenessSection data={processed.meetingEffectiveness} />
      )}

      {/* ── Meeting Engagement ── */}
      {processed?.meetingEngagement && (
        <EngagementSection data={processed.meetingEngagement} />
      )}

      {/* ── Approval Queue — emails + reminders only ── */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Follow-up Queue</div>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Nothing is sent until you approve.
          </span>
        </div>
        {(pendingItems || []).length === 0 ? (
          <div className="empty-state">
            <div className="empty-text">No follow-up items to approve.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pendingItems.map((item) => {
              const status     = itemStatuses[item.id];
              const isApproved = status === "approve";
              const isRejected = status === "reject";
              const isLoading  = status === "loading";

              return (
                <div
                  key={item.id}
                  className={`approval-item ${isApproved ? "approved" : isRejected ? "rejected" : ""}`}
                >
                  <span className="approval-type-icon">{ITEM_ICONS[item.type] || "•"}</span>
                  <div className="approval-label">{item.label}</div>
                  <div className="approval-actions">
                    {isApproved ? (
                      <span style={{ color: "var(--green)", fontSize: 13, fontWeight: 600 }}>✓ Done</span>
                    ) : isRejected ? (
                      <span style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Skipped</span>
                    ) : (
                      <>
                        <button className="btn btn-success" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => onApprove(item.id, "approve")} disabled={isLoading}>
                          {isLoading ? "…" : "Approve"}
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => onApprove(item.id, "reject")} disabled={isLoading}>
                          Skip
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EffectivenessSection — collapsible dropdown
// Summary line: "X/Y items covered" · score badge
// ─────────────────────────────────────────────────────────────────────────────
function EffectivenessSection({ data }) {
  const [open, setOpen] = useState(false);
  const { score, addressed = [], skipped = [], newIssuesRaised = [] } = data;

  const total    = addressed.length + skipped.length;
  const covered  = addressed.length;

  const scoreColor =
    score === null ? "var(--text-tertiary)"
    : score >= 75  ? "var(--green)"
    : score >= 45  ? "#f59e0b"
    : "#ef4444";

  const scoreBg =
    score === null ? "var(--bg)"
    : score >= 75  ? "#f0fdf4"
    : score >= 45  ? "#fffbeb"
    : "#fef2f2";

  // Fraction colour mirrors the score colour logic
  const fractionColor =
    total === 0        ? "var(--text-tertiary)"
    : covered === total ? "var(--green)"
    : covered / total >= 0.5 ? "#f59e0b"
    : "#ef4444";

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>

      {/* ── Collapsed header (always visible) ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: "14px 16px", background: "transparent", border: "none",
          cursor: "pointer", textAlign: "left",
        }}
      >
        {/* Icon + title */}
        <span style={{ fontSize: 16, flexShrink: 0 }}>📊</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", flex: 1 }}>
          Meeting Effectiveness
        </span>

        {/* X/Y pill */}
        {total > 0 && (
          <span style={{
            fontSize: 13, fontWeight: 700,
            padding: "3px 10px", borderRadius: 20,
            background: scoreBg,
            color: fractionColor,
            border: `1px solid ${fractionColor}40`,
            flexShrink: 0,
          }}>
            {covered}/{total} items covered
          </span>
        )}

        {/* Numeric score pill */}
        {score !== null && (
          <span style={{
            fontSize: 12, fontWeight: 700,
            padding: "3px 10px", borderRadius: 20,
            background: scoreBg,
            color: scoreColor,
            border: `1px solid ${scoreColor}40`,
            flexShrink: 0,
          }}>
            {score}/100
          </span>
        )}

        {/* Chevron */}
        <span style={{
          fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0,
          transform: open ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 0.2s ease",
          display: "inline-block",
        }}>
          ▾
        </span>
      </button>

      {/* ── Expanded body ── */}
      {open && (
        <div style={{ padding: "0 16px 16px", borderTop: "1px solid var(--border)" }}>

          {/* Score bar */}
          {score !== null && (
            <div style={{ margin: "14px 0 18px" }}>
              <div style={{ height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3,
                  background: scoreColor,
                  width: `${score}%`,
                  transition: "width 0.6s ease",
                }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Nothing addressed</span>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Fully covered</span>
              </div>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

            {/* Addressed */}
            {addressed.length > 0 && (
              <div>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: "var(--green)",
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  ✓ Addressed ({addressed.length})
                </div>
                {addressed.map((item, i) => (
                  <div key={i} style={{
                    padding: "8px 12px", borderRadius: 8, marginBottom: 6,
                    background: "#f0fdf4", border: "1px solid #86efac",
                    display: "flex", alignItems: "flex-start", gap: 10,
                  }}>
                    <span style={{ color: "var(--green)", fontWeight: 700, flexShrink: 0, marginTop: 1 }}>✓</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 }}>
                        {item.item}
                      </div>
                      <div style={{ fontSize: 12, color: "#166534" }}>{item.outcome}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Skipped */}
            {skipped.length > 0 && (
              <div>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: "#d97706",
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  ⏭ Not covered ({skipped.length})
                </div>
                {skipped.map((item, i) => (
                  <div key={i} style={{
                    padding: "8px 12px", borderRadius: 8, marginBottom: 6,
                    background: "#fffbeb", border: "1px solid #fcd34d",
                    display: "flex", alignItems: "flex-start", gap: 10,
                  }}>
                    <span style={{ color: "#d97706", fontWeight: 700, flexShrink: 0, marginTop: 1 }}>—</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 }}>
                        {item.item}
                      </div>
                      {item.reason && (
                        <div style={{ fontSize: 12, color: "#92400e", fontStyle: "italic" }}>
                          {item.reason}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* New issues */}
            {newIssuesRaised.length > 0 && (
              <div>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: "var(--accent)",
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
                }}>
                  + New topics raised ({newIssuesRaised.length})
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {newIssuesRaised.map((issue, i) => (
                    <span key={i} style={{
                      fontSize: 12, padding: "3px 10px", borderRadius: 12,
                      background: "var(--accent-light)", color: "var(--accent)",
                      border: "1px solid var(--accent)30",
                    }}>
                      {issue}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {addressed.length === 0 && skipped.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                No prior agenda found — effectiveness based on transcript content only.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EngagementSection — collapsible dropdown
// Summary line: "X/Y actively engaging"
// ─────────────────────────────────────────────────────────────────────────────
function EngagementSection({ data }) {
  const [open, setOpen] = useState(false);
  const { totalSpeakers, participants = [], facilitationQuality, dominantSpeaker } = data;

  // Count high + medium as "actively engaging"
  const activeCount = participants.filter(
    (p) => p.participationLevel === "high" || p.participationLevel === "medium"
  ).length;
  const total = participants.length;

  const activeColor =
    total === 0                      ? "var(--text-tertiary)"
    : activeCount / total >= 0.7     ? "var(--green)"
    : activeCount / total >= 0.4     ? "#f59e0b"
    : "#ef4444";

  const activeBg =
    total === 0                      ? "var(--bg)"
    : activeCount / total >= 0.7     ? "#f0fdf4"
    : activeCount / total >= 0.4     ? "#fffbeb"
    : "#fef2f2";

  // Sort: high → medium → low → silent
  const ORDER = { high: 0, medium: 1, low: 2, silent: 3 };
  const sorted = [...participants].sort((a, b) =>
    (ORDER[a.participationLevel] ?? 4) - (ORDER[b.participationLevel] ?? 4)
  );

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>

      {/* ── Collapsed header (always visible) ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: "14px 16px", background: "transparent", border: "none",
          cursor: "pointer", textAlign: "left",
        }}
      >
        {/* Icon + title */}
        <span style={{ fontSize: 16, flexShrink: 0 }}>👥</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", flex: 1 }}>
          Meeting Engagement
        </span>

        {/* X/Y active pill */}
        {total > 0 && (
          <span style={{
            fontSize: 13, fontWeight: 700,
            padding: "3px 10px", borderRadius: 20,
            background: activeBg,
            color: activeColor,
            border: `1px solid ${activeColor}40`,
            flexShrink: 0,
          }}>
            {activeCount}/{total} actively engaging
          </span>
        )}

        {/* Speaker count pill */}
        {totalSpeakers > 0 && (
          <span style={{
            fontSize: 12, fontWeight: 600,
            padding: "3px 10px", borderRadius: 20,
            background: "var(--bg)", border: "1px solid var(--border)",
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}>
            {totalSpeakers} speaker{totalSpeakers !== 1 ? "s" : ""}
          </span>
        )}

        {/* Chevron */}
        <span style={{
          fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0,
          transform: open ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 0.2s ease",
          display: "inline-block",
        }}>
          ▾
        </span>
      </button>

      {/* ── Expanded body ── */}
      {open && (
        <div style={{ padding: "0 16px 16px", borderTop: "1px solid var(--border)" }}>

          {/* Dominant speaker callout */}
          {dominantSpeaker && (
            <div style={{
              marginTop: 14, marginBottom: 12,
              padding: "6px 12px", borderRadius: 8,
              background: "#eff6ff", border: "1px solid #93c5fd",
              fontSize: 12, color: "#1e40af",
            }}>
              Most vocal: <strong>{dominantSpeaker}</strong>
            </div>
          )}

          {/* Participants */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: dominantSpeaker ? 0 : 14, marginBottom: 16 }}>
            {sorted.map((p, i) => {
              const level = PARTICIPATION[p.participationLevel] || PARTICIPATION.low;
              return (
                <div key={i} style={{
                  padding: "10px 14px", borderRadius: 8,
                  background: level.bg, border: `1px solid ${level.border}`,
                  display: "flex", alignItems: "flex-start", gap: 12,
                }}>
                  {/* Avatar initial */}
                  <div style={{
                    width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
                    background: `hsl(${(p.name.charCodeAt(0) * 37) % 360}, 55%, 80%)`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, fontWeight: 700,
                    color: `hsl(${(p.name.charCodeAt(0) * 37) % 360}, 55%, 30%)`,
                  }}>
                    {p.name.charAt(0).toUpperCase()}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
                        {p.name}
                      </span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 10,
                        background: "white", color: level.text,
                        border: `1px solid ${level.border}`,
                      }}>
                        {level.label}
                      </span>
                      {p.speakingShare > 0 && (
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                          ~{p.speakingShare}% of conversation
                        </span>
                      )}
                    </div>

                    {/* Speaking share bar */}
                    {p.speakingShare > 0 && (
                      <div style={{ height: 4, borderRadius: 2, background: "white", marginBottom: 6, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", borderRadius: 2,
                          background: level.border,
                          width: `${Math.min(p.speakingShare, 100)}%`,
                        }} />
                      </div>
                    )}

                    {/* Key contributions */}
                    {(p.keyContributions || []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {p.keyContributions.map((c, j) => (
                          <span key={j} style={{
                            fontSize: 11, padding: "2px 8px", borderRadius: 10,
                            background: "white", color: "var(--text-secondary)",
                            border: "1px solid var(--border)",
                          }}>
                            {c}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Note */}
                    {p.note && (
                      <div style={{ fontSize: 11, color: level.text, marginTop: 4, fontStyle: "italic" }}>
                        {p.note}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Facilitation quality */}
          {facilitationQuality && (
            <div style={{
              fontSize: 12, padding: "8px 12px", borderRadius: 8,
              background: "var(--bg)", border: "1px solid var(--border)",
              color: "var(--text-secondary)",
              borderLeft: "3px solid var(--accent)",
            }}>
              💬 {facilitationQuality}
            </div>
          )}
        </div>
      )}
    </div>
  );
}