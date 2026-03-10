// src/App.jsx
import React, { useState } from "react";
import { MsalProvider, useMsal, useIsAuthenticated } from "@azure/msal-react";
import { msalInstance, loginRequest, getCurrentUser } from "./services/auth";
import DailyTodos from "./components/DailyTodos";
import PreCallBrief from "./components/PreCallBrief";
import PostCallPanel from "./components/PostCallPanel";
import ThreadCatchup from "./components/ThreadCatchup";
import "./App.css";
import dispatchLogo from "./assets/dispatch-logo.png";

// ─── NAV TABS ───────────────────────────────────────────
const TABS = [
  { id: "daily",     label: "Daily View",     icon: "📋" },
  { id: "pre-call",  label: "Pre-Call Brief",  icon: "📅" },
  { id: "post-call", label: "Post-Call",       icon: "✅" },
  { id: "threads",   label: "Thread Catch-Up", icon: "📧" },
];

// ─── SIGN-IN SCREEN ──────────────────────────────────────
function SignInScreen() {
  const { instance } = useMsal();

  const handleLogin = async () => {
    try {
      await instance.loginPopup(loginRequest);
    } catch (e) {
      console.error("Login failed:", e);
    }
  };

  return (
    <div className="signin-screen">
      <div className="signin-card">
        <div className="dispatch-logo" style={{ flexDirection: "column", gap: 4 }}>
          <img src={dispatchLogo} alt="Dispatch" style={{ width: 110, height: 75, objectFit: "contain" }} />
          <span className="logo-text">Dispatch</span>
        </div>
        <p className="signin-tagline-1">
          Your personal AI assistant.
        </p>
        <p className="signin-tagline"> Walk in prepared, leave without loose ends.</p>
        <div className="signin-features">
          <div className="feature-pill">📅 Pre-Call Briefs</div>
          <div className="feature-pill">✅ Action Item Capture</div>
          <div className="feature-pill">📧 Thread Catch-Up</div>
          <div className="feature-pill">📋 Daily Priorities</div>
        </div>
        <button className="ms-signin-btn" onClick={handleLogin}>
          <img
            src="https://learn.microsoft.com/en-us/azure/active-directory/develop/media/howto-add-branding-in-apps/ms-symbollockup_mssymbol_19.svg"
            alt="Microsoft"
            className="ms-logo"
            onError={(e) => (e.target.style.display = "none")}
          />
          Sign in with Microsoft
        </button>
        <p className="signin-note">
          Dispatch connects to your Microsoft 365 account. All data stays within
          your organization's Azure tenant.
        </p>
      </div>
    </div>
  );
}

// ─── MAIN APP SHELL ──────────────────────────────────────
function AppShell() {
  const isAuthenticated = useIsAuthenticated();
  const { instance } = useMsal();
  const [activeTab, setActiveTab] = useState("daily");
  const user = getCurrentUser();

  const handleLogout = () => instance.logoutPopup();

  if (!isAuthenticated) return <SignInScreen />;

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand" style={{ gap: 6, padding: "16px 12px" }}>
          <img src={dispatchLogo} alt="Dispatch" style={{ width: 40, height: 27, objectFit: "contain", flexShrink: 0 }} />
          <span className="logo-text">Dispatch</span>
        </div>

        <nav className="sidebar-nav">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`nav-item ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="nav-icon">{tab.icon}</span>
              <span className="nav-label">{tab.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">
              {user?.name?.charAt(0)?.toUpperCase() || "U"}
            </div>
            <div className="user-details">
              <div className="user-name">{user?.name || "User"}</div>
              <div className="user-email">{user?.email || ""}</div>
            </div>
          </div>
          <button className="signout-btn" onClick={handleLogout} title="Sign out">
            ↪
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {activeTab === "daily"     && <DailyTodos />}
        {activeTab === "pre-call"  && <PreCallBrief />}
        {activeTab === "post-call" && <PostCallPanel />}
        {activeTab === "threads"   && <ThreadCatchup />}
      </main>
    </div>
  );
}

// ─── ROOT ────────────────────────────────────────────────
export default function App() {
  return (
    <MsalProvider instance={msalInstance}>
      <AppShell />
    </MsalProvider>
  );
}