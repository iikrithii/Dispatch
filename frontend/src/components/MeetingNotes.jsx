// src/components/MeetingNotes.jsx

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { getPreMeetingBrief, generateMeetingNotes } from "../services/api";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildQuestions(brief) {
  if (!brief) return [];
  const qs = [];

  // 1. Follow-ups
  (brief.followUps?.items || [])
    .filter((i) => i.status === "pending")
    .forEach((item) => {
      qs.push({
        id: `followup__${item.task?.slice(0, 40)}`,
        type: "followup",
        icon: "⏳",
        label: "Pending from last meeting",
        topic: item.task,
        prompt: "Did you complete this? What is the current status?",
        hint: `Assigned to: ${item.owner || "you"}`,
      });
    });

  // 2. Agenda Today (FIX: Extract .text from the rich object)
  (brief.agendaForToday || []).forEach((item, i) => {
    // If it's a rich object { text, issue }, use the text. Otherwise, use string.
    const topicText = typeof item === "string" ? item : (item?.text || "");

    qs.push({
      id: `agenda__${i}`,
      type: "agenda",
      icon: "🎯",
      label: "Agenda item",
      topic: topicText, // This must be a string for React to render it
      prompt: "What do you want to say about this in the meeting?",
      hint: item.issue ? `Linked to Jira: ${item.issue.key}` : null,
    });
  });

  return qs;
}

function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function MeetingNotes({ event, brief: initialBrief, onBack }) {
  const [brief, setBrief]                       = useState(initialBrief?.brief ?? initialBrief ?? null);
  const [loadingBrief, setLoadingBrief]        = useState(!initialBrief);
  const [questions, setQuestions]              = useState([]);
  const [answers, setAnswers]                  = useState({});
  const [additionalNotes, setAdditionalNotes] = useState("");
  const [listening, setListening]              = useState(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [generating, setGenerating]            = useState(false);
  const [result, setResult]                    = useState(null);
  const [copiedId, setCopiedId]                = useState(null);
  const [error, setError]                      = useState(null);

  const recognitionRef = useRef(null);
  const resultRef      = useRef(null);

  useEffect(() => {
    setSpeechSupported(!!(window.SpeechRecognition || window.webkitSpeechRecognition));
  }, []);

  useEffect(() => {
    if (initialBrief) {
      const b = initialBrief?.brief ?? initialBrief;
      setBrief(b);
      setQuestions(buildQuestions(b));
      setLoadingBrief(false);
      return;
    }
    if (!event?.id) return;
    setLoadingBrief(true);
    getPreMeetingBrief(event.id)
      .then((r) => { 
        const b = r.brief ?? null; 
        setBrief(b); 
        setQuestions(buildQuestions(b)); 
      })
      .catch((e) => setError(`Could not load brief: ${e.message}`))
      .finally(() => setLoadingBrief(false));
  }, [event?.id, initialBrief]);

  const handleDeleteQuestion = useCallback((questionId) => {
    setQuestions((prev) => prev.filter((q) => q.id !== questionId));
    setAnswers((prev) => { const n = { ...prev }; delete n[questionId]; return n; });
  }, []);

  const startListening = useCallback((fieldId) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognitionRef.current?.abort();
    const rec = new SR();
    rec.lang            = "en-IN";
    rec.continuous      = false;
    rec.interimResults  = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      const t = e.results[0][0].transcript;
      if (fieldId === "additional") {
        setAdditionalNotes((prev) => prev ? `${prev} ${t}` : t);
      } else {
        setAnswers((prev) => ({ ...prev, [fieldId]: prev[fieldId] ? `${prev[fieldId]} ${t}` : t }));
      }
      setListening(null);
    };
    rec.onerror = () => setListening(null);
    rec.onend   = () => setListening(null);
    recognitionRef.current = rec;
    rec.start();
    setListening(fieldId);
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(null);
  }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    setResult(null);

    // Normalize rich items back to text for the API call
    const normalize = (arr) => (arr || []).map(i => typeof i === "string" ? i : (i?.text || ""));

    try {
      const res = await generateMeetingNotes({
        eventId:       event?.id,
        meetingTitle:  event?.subject || brief?.meetingTitle || "Meeting",
        language:      "English",
        agenda:        normalize(brief?.agendaForToday),
        followUpItems: (brief?.followUps?.items || []).filter((i) => i.status === "pending"),
        openPoints:    normalize(brief?.openPoints),
        keyContext:    brief?.keyContext || "",
        currentStatus: brief?.currentStatus || "",
        questions:     questions.map((q) => ({ id: q.id, type: q.type, topic: q.topic })),
        answers,
        additionalNotes,
      });
      setResult(res);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = (id, text) => {
    copyText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const answeredCount = questions.filter((q) => (answers[q.id] || "").trim().length > 0).length;

  return (
    <div style={{ maxWidth: 780, margin: "0 auto" }}>

      {/* ── Page header ── */}
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button className="btn btn-ghost" style={{ fontSize: 13, padding: "5px 12px" }} onClick={onBack}>
            ← Back
          </button>
          <div>
            <div className="page-title" style={{ fontSize: 18 }}>📝 Speaking Brief</div>
            <div className="page-subtitle" style={{ fontSize: 13, marginTop: 2 }}>
              {event?.subject || "Prepare your speaking points"}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {speechSupported ? (
            <span style={{
              fontSize: 12, fontWeight: 600, color: "var(--green)",
              background: "var(--green-light)", padding: "4px 10px",
              borderRadius: 20, display: "flex", alignItems: "center", gap: 5,
            }}>
              🎤 Voice Dictation available in any language
            </span>
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
              Voice input available in Chrome or Edge
            </span>
          )}
        </div>
      </div>

      {error && <div className="error-state">⚠️ {error}</div>}

      {loadingBrief ? (
        <div className="card loading-state"><div className="spinner" /><div className="loading-text">Loading your brief…</div></div>
      ) : (
        <>
          {/* ── Questions card ── */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header" style={{ marginBottom: 6 }}>
              <div className="card-title">
                Speaking Points{" "}
                <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-secondary)" }}>
                  ({answeredCount}/{questions.length} prepped)
                </span>
              </div>
            </div>
            <div style={{
              fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic",
              marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--border)",
            }}>
              These points are pulled from your pre-call brief. Click any row to add your notes.
            </div>

            {questions.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-secondary)", fontStyle: "italic" }}>
                No agenda or follow-up items found. Use the additional notes box below.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {questions.map((q) => (
                  <QuestionField
                    key={q.id}
                    question={q}
                    value={answers[q.id] || ""}
                    onChange={(val) => setAnswers((prev) => ({ ...prev, [q.id]: val }))}
                    isListening={listening === q.id}
                    speechSupported={speechSupported}
                    onStartListen={() => startListening(q.id)}
                    onStopListen={stopListening}
                    onDelete={() => handleDeleteQuestion(q.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ── Additional notes ── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div className="card-title">Additional Notes</div>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                Anything else — type or speak freely
              </span>
            </div>
            <div style={{ position: "relative" }}>
              <textarea
                value={additionalNotes}
                onChange={(e) => setAdditionalNotes(e.target.value)}
                placeholder={`Type or speak freely — any language, any mix…`}
                style={{
                  width: "100%", minHeight: 110, padding: "10px 12px", borderRadius: 8,
                  border: `1px solid ${listening === "additional" ? "var(--accent)" : "var(--border)"}`,
                  fontSize: 13, fontFamily: "inherit", resize: "vertical", outline: "none",
                  background: listening === "additional" ? "var(--accent-light)" : "var(--bg)",
                  boxSizing: "border-box", transition: "border-color 0.15s, background 0.15s",
                }}
              />
              {speechSupported && (
                <MicButton
                  isListening={listening === "additional"}
                  onStart={() => startListening("additional")}
                  onStop={stopListening}
                  style={{ position: "absolute", bottom: 10, right: 10 }}
                />
              )}
            </div>
          </div>

          {/* ── Generate ── */}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 14, marginBottom: 24 }}>
            {answeredCount === 0 && !additionalNotes && (
              <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                Expand and answer at least one point to generate
              </span>
            )}
            <button
              className="btn btn-primary"
              style={{ padding: "12px 28px", fontSize: 14 }}
              onClick={handleGenerate}
              disabled={generating || (answeredCount === 0 && !additionalNotes.trim())}
            >
              {generating ? "Generating…" : "⚡ Generate Speaking Points"}
            </button>
          </div>

          {generating && (
            <div className="card loading-state" style={{ marginBottom: 20 }}>
              <div className="spinner" />
              <div className="loading-text">Transforming your notes into polished speaking points…</div>
            </div>
          )}

          {result && !generating && (
            <div ref={resultRef}>
              <SpeakingPointsDisplay result={result} copiedId={copiedId} onCopy={handleCopy} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// QuestionField
// ─────────────────────────────────────────────────────────────────────────────
function QuestionField({ question, value, onChange, isListening, speechSupported, onStartListen, onStopListen, onDelete }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { if (value) setExpanded(true); }, []); // eslint-disable-line

  const accentColor =
    value.trim()                    ? "var(--green)"
    : question.type === "followup"  ? "var(--orange)"
    : "var(--accent)";

  const typeColor =
    question.type === "followup"    ? { bg: "#fff7ed", text: "#c2410c" }
    : { bg: "var(--accent-light)", text: "var(--accent)" };

  return (
    <div style={{
      borderRadius: 8,
      border: `1px solid ${expanded ? accentColor : "var(--border)"}`,
      borderLeft: `3px solid ${accentColor}`,
      overflow: "hidden",
      transition: "border-color 0.15s",
      background: "var(--card-bg, white)",
    }}>
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((v) => !v)}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "12px 14px", cursor: "pointer", userSelect: "none",
          background: expanded ? "var(--accent-light)" : "transparent",
          transition: "background 0.15s",
        }}
      >
        <span style={{
          fontSize: 15, width: 28, height: 28, borderRadius: 6,
          background: typeColor.bg, display: "flex", alignItems: "center",
          justifyContent: "center", flexShrink: 0,
        }}>
          {question.icon}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 6,
              background: typeColor.bg, color: typeColor.text,
              textTransform: "uppercase", letterSpacing: "0.04em",
            }}>
              {question.label}
            </span>
            {value.trim() && (
              <span style={{
                fontSize: 10, fontWeight: 700, color: "var(--green)",
                background: "var(--green-light)", padding: "1px 6px", borderRadius: 6,
              }}>
                ✓ Prepped
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", wordBreak: "break-word" }}>
            {question.topic}
          </div>
          {question.hint && (
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1, fontStyle: "italic" }}>
              {question.hint}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6,
            background: expanded ? "var(--border)" : "var(--accent)",
            color: expanded ? "var(--text-secondary)" : "white",
            transition: "background 0.15s, color 0.15s",
            whiteSpace: "nowrap",
          }}>
            {expanded ? "▾ Collapse" : "▸ Add notes"}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            style={{
              width: 26, height: 26, borderRadius: 6, border: "1px solid var(--border)",
              background: "transparent", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12, color: "var(--text-tertiary)",
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "0 14px 14px 14px", borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", fontStyle: "italic", margin: "10px 0 8px" }}>
            {question.prompt}
          </div>
          <div style={{ position: "relative" }}>
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="Type or speak in any language"
              rows={3}
              autoFocus
              style={{
                width: "100%", padding: "9px 44px 9px 10px", borderRadius: 8,
                border: `1px solid ${isListening ? "var(--accent)" : "var(--border)"}`,
                fontSize: 13, fontFamily: "inherit", resize: "vertical", outline: "none",
                background: isListening ? "var(--accent-light)" : "var(--bg)",
                boxSizing: "border-box", transition: "border-color 0.15s, background 0.15s",
              }}
            />
            {speechSupported && (
              <MicButton
                isListening={isListening}
                onStart={onStartListen}
                onStop={onStopListen}
                style={{ position: "absolute", bottom: 8, right: 8 }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MicButton / SpeakingPointsDisplay / StatementCard (Unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────

function MicButton({ isListening, onStart, onStop, style = {} }) {
  return (
    <button
      onClick={isListening ? onStop : onStart}
      style={{
        width: 28, height: 28, borderRadius: "50%", border: "none", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
        background: isListening ? "var(--accent)" : "var(--border)",
        color: isListening ? "white" : "var(--text-secondary)",
        boxShadow: isListening ? "0 0 0 3px var(--accent-light)" : "none",
        transition: "all 0.15s", flexShrink: 0, ...style,
      }}
    >
      {isListening ? "⏹" : "🎤"}
    </button>
  );
}

function SpeakingPointsDisplay({ result, copiedId, onCopy }) {
  const { openingStatement, speakingPoints: initialPoints = [], closingStatement, redFlags = [] } = result;
  const [points, setPoints]   = useState(initialPoints.map((sp) => ({ ...sp, talkingPoints: [...(sp.talkingPoints || [])] })));
  const [checked, setChecked] = useState({});

  const toggleChecked  = (key) => setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
  const updateDraft    = (i, val) => setPoints((prev) => prev.map((sp, idx) => idx === i ? { ...sp, draft: val } : sp));
  const updateBullet   = (i, j, val) => setPoints((prev) => prev.map((sp, idx) => idx === i ? { ...sp, talkingPoints: sp.talkingPoints.map((tp, ti) => ti === j ? val : tp) } : sp));
  const addBullet      = (i) => setPoints((prev) => prev.map((sp, idx) => idx === i ? { ...sp, talkingPoints: [...sp.talkingPoints, ""] } : sp));
  const removeBullet   = (i, j) => setPoints((prev) => prev.map((sp, idx) => idx === i ? { ...sp, talkingPoints: sp.talkingPoints.filter((_, ti) => ti !== j) } : sp));

  const totalPoints  = points.length;
  const checkedCount = Object.values(checked).filter(Boolean).length;

  const fullScript = [
    openingStatement,
    ...points.map((sp) => `[${sp.topic}]\n${sp.draft}\n${(sp.talkingPoints || []).map((t) => `• ${t}`).join("\n")}`),
    closingStatement,
  ].filter(Boolean).join("\n\n");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
          🎙️ Your Speaking Points
          <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-tertiary)", marginLeft: 8 }}>
            {checkedCount}/{totalPoints} covered
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => onCopy("full", fullScript)}>
            {copiedId === "full" ? "✓ Copied!" : "📋 Copy All"}
          </button>
        </div>
      </div>

      {totalPoints > 0 && (
        <div style={{ height: 4, borderRadius: 2, background: "var(--border)", marginBottom: 16, overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 2,
            background: checkedCount === totalPoints ? "var(--green)" : "var(--accent)",
            width: `${(checkedCount / totalPoints) * 100}%`,
            transition: "width 0.3s ease",
          }} />
        </div>
      )}

      {openingStatement && (
        <StatementCard icon="👋" label="Opening" text={openingStatement} id="opening" copiedId={copiedId} onCopy={onCopy} />
      )}

      {points.map((sp, i) => (
        <SpeakingPointCard
          key={i}
          index={i}
          sp={sp}
          isChecked={!!checked[`sp_${i}`]}
          onToggle={() => toggleChecked(`sp_${i}`)}
          onUpdateDraft={(val) => updateDraft(i, val)}
          onUpdateBullet={(j, val) => updateBullet(i, j, val)}
          onAddBullet={() => addBullet(i)}
          onRemoveBullet={(j) => removeBullet(i, j)}
          copiedId={copiedId}
          onCopy={onCopy}
        />
      ))}

      {closingStatement && (
        <StatementCard icon="🤝" label="Closing" text={closingStatement} id="closing" copiedId={copiedId} onCopy={onCopy} />
      )}

      {redFlags.length > 0 && (
        <div className="card" style={{ marginBottom: 14, borderLeft: "3px solid #dc2626", background: "#fff5f5" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#dc2626", marginBottom: 8, textTransform: "uppercase" }}>
            ⚠️ Watch out
          </div>
          {redFlags.map((flag, i) => (
            <div key={i} style={{ fontSize: 13, padding: "4px 0", borderBottom: i < redFlags.length - 1 ? "1px solid #fee2e2" : "none", color: "#7f1d1d" }}>
              {flag}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SpeakingPointCard({ index, sp, isChecked, onToggle, onUpdateDraft, onUpdateBullet, onAddBullet, onRemoveBullet, copiedId, onCopy }) {
  const [editingDraft,  setEditingDraft]  = useState(false);
  const [editingBullet, setEditingBullet] = useState(null);
  const copyContent = `${sp.draft}\n${(sp.talkingPoints || []).map((t) => `• ${t}`).join("\n")}`;

  return (
    <div className="card" style={{
      marginBottom: 14,
      borderLeft: `3px solid ${isChecked ? "var(--green)" : "var(--accent)"}`,
      opacity: isChecked ? 0.5 : 1,
    }}>
      <div className="card-header" style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
          <input type="checkbox" checked={isChecked} onChange={onToggle} style={{ cursor: "pointer" }} />
          <span style={{ fontWeight: 700, color: "var(--accent)", fontSize: 13 }}>{index + 1}.</span>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{sp.topic}</div>
        </div>
        <button className="btn btn-ghost" style={{ fontSize: 11, padding: "3px 9px" }} onClick={() => onCopy(`sp_${index}`, copyContent)}>
          {copiedId === `sp_${index}` ? "✓" : "📋"}
        </button>
      </div>

      <div style={{ marginBottom: 12 }}>
        {editingDraft ? (
          <textarea value={sp.draft} onChange={(e) => onUpdateDraft(e.target.value)} onBlur={() => setEditingDraft(false)} autoFocus rows={4} style={{ width: "100%", padding: 10, fontSize: 13 }} />
        ) : (
          <div onClick={() => setEditingDraft(true)} style={{ fontSize: 13, background: "var(--bg)", padding: 10, borderRadius: 8, cursor: "text" }}>{sp.draft}</div>
        )}
      </div>

      <div>
        {(sp.talkingPoints || []).map((tp, j) => (
          <div key={j} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>•</span>
            {editingBullet === j ? (
              <input value={tp} onChange={(e) => onUpdateBullet(j, e.target.value)} onBlur={() => setEditingBullet(null)} autoFocus style={{ flex: 1 }} />
            ) : (
              <span onClick={() => setEditingBullet(j)} style={{ flex: 1, fontSize: 13, cursor: "text" }}>{tp}</span>
            )}
            <button onClick={() => onRemoveBullet(j)} style={{ cursor: "pointer", border: "none", background: "none" }}>✕</button>
          </div>
        ))}
        <button onClick={onAddBullet} style={{ fontSize: 11, color: "var(--accent)", border: "none", background: "none", cursor: "pointer", marginTop: 4 }}>+ Add bullet</button>
      </div>
    </div>
  );
}

function StatementCard({ icon, label, text, id, copiedId, onCopy }) {
  return (
    <div className="card" style={{ marginBottom: 14, borderLeft: "3px solid var(--green)", background: "var(--bg)" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" }}>{icon} {label}</div>
          <div style={{ fontSize: 13, fontStyle: "italic" }}>"{text}"</div>
        </div>
        <button className="btn btn-ghost" style={{ fontSize: 11, padding: "3px 9px" }} onClick={() => onCopy(id, text)}>
          {copiedId === id ? "✓" : "📋"}
        </button>
      </div>
    </div>
  );
}