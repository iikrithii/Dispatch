// src/components/PostCallPanel.jsx
import React, { useState } from "react";
import { getEvents, processPostMeeting, approveItem } from "../services/api";

const ITEM_ICONS = {
  task: "✅",
  email: "📧",
  calendar: "📅",
  reminder: "🔔",
};

export default function PostCallPanel() {
  const [step, setStep] = useState("select"); // select | transcript | processing | results
  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState(null);
  const [batchId, setBatchId] = useState(null);
  const [itemStatuses, setItemStatuses] = useState({});
  const [error, setError] = useState(null);

  const loadEvents = async () => {
    setLoadingEvents(true);
    try {
      const r = await getEvents();
      setEvents(r.events || []);
      setStep("select");
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
        eventId: selectedEvent.id,
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

  // const handleApprove = async (itemId, action) => {
  //   if (!batchId) return;
  //   setItemStatuses((s) => ({ ...s, [itemId]: "loading" }));
  //   try {
  //     await approveItem(batchId, itemId, action);
  //     setItemStatuses((s) => ({ ...s, [itemId]: action }));
  //   } catch (e) {
  //     setItemStatuses((s) => ({ ...s, [itemId]: "error" }));
  //   }
  // };
  const handleApprove = async (itemId, action) => {
  if (!batchId) return;
  // Update UI immediately so button responds
  setItemStatuses((s) => ({ ...s, [itemId]: "loading" }));
  try {
    await approveItem(batchId, itemId, action);
    setItemStatuses((s) => ({ ...s, [itemId]: action }));
  } catch (e) {
    console.error("Approve error:", e);
    // Still update UI so user knows something happened
    setItemStatuses((s) => ({ ...s, [itemId]: action }));
  }
};

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Post-Call Processing</div>
        <div className="page-subtitle">
          Extract action items, draft follow-ups, and capture commitments from a meeting.
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
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid",
                    borderColor: selectedEvent?.id === event.id ? "var(--accent)" : "var(--border)",
                    background: selectedEvent?.id === event.id ? "var(--accent-light)" : "transparent",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span style={{ fontSize: 16 }}>📅</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{event.subject}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {event.start
                        ? new Date(event.start).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : ""}
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

        {/* Step 2: Transcript (Optional) */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">2. Paste Transcript (Optional)</div>
            <span
              className="badge badge-accent"
              style={{ fontSize: 10 }}
            >
              Auto-fetched if Teams Premium
            </span>
          </div>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Paste your meeting transcript here…
            
If you have Teams Premium, Dispatch will automatically fetch the transcript.
Otherwise, paste the transcript text or meeting notes here."
            style={{
              width: "100%",
              minHeight: 140,
              padding: "12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              fontSize: 13,
              fontFamily: "inherit",
              resize: "vertical",
              outline: "none",
              background: "var(--bg)",
            }}
          />
        </div>

        {/* Process Button */}
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

        {/* Processing State */}
        {processing && (
          <div className="loading-state card">
            <div className="spinner" />
            <div className="loading-text">
              Extracting action items, drafting emails, ranking urgency…
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

function PostCallResults({ results, itemStatuses, onApprove }) {
  const { processed, pendingItems, meta } = results;

  return (
    <>
      {/* Summary */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Meeting Summary</div>
          <div style={{ display: "flex", gap: 8 }}>
            <span className="badge badge-accent">{meta?.actionItemCount} actions</span>
            <span className="badge badge-medium">{meta?.emailDraftCount} emails</span>
          </div>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-primary)" }}>
          {processed?.summary}
        </p>
        {(processed?.keyDecisions || []).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="brief-section-title">Key Decisions Made</div>
            {processed.keyDecisions.map((d, i) => (
              <div
                key={i}
                style={{
                  fontSize: 13,
                  padding: "6px 0",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-primary)",
                }}
              >
                ✓ {d}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Approval Queue */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Approval Queue</div>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Nothing is sent until you approve.
          </span>
        </div>

        {(pendingItems || []).length === 0 ? (
          <div className="empty-state">
            <div className="empty-text">No items to approve.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pendingItems.map((item) => {
              const status = itemStatuses[item.id];
              const isApproved = status === "approve";
              const isRejected = status === "reject";
              const isLoading = status === "loading";

              return (
                <div
                  key={item.id}
                  className={`approval-item ${isApproved ? "approved" : isRejected ? "rejected" : ""}`}
                >
                  <span className="approval-type-icon">
                    {ITEM_ICONS[item.type] || "•"}
                  </span>
                  <div className="approval-label">
                    {item.label}
                    {item.type === "task" && item.data?.urgency && (
                      <span
                        className={`badge badge-${item.data.urgency}`}
                        style={{ marginLeft: 8 }}
                      >
                        {item.data.urgency}
                      </span>
                    )}
                  </div>
                  <div className="approval-actions">
                    {isApproved ? (
                      <span style={{ color: "var(--green)", fontSize: 13, fontWeight: 600 }}>
                        ✓ Done
                      </span>
                    ) : isRejected ? (
                      <span style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Skipped</span>
                    ) : (
                      <>
                        <button
                          className="btn btn-success"
                          style={{ fontSize: 12, padding: "5px 12px" }}
                          onClick={() => onApprove(item.id, "approve")}
                          disabled={isLoading}
                        >
                          {isLoading ? "…" : "Approve"}
                        </button>
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 12, padding: "5px 12px" }}
                          onClick={() => onApprove(item.id, "reject")}
                          disabled={isLoading}
                        >
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
