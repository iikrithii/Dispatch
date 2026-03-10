// src/services/auth.js
// Microsoft Authentication Library (MSAL) configuration.
// Replace YOUR_CLIENT_ID and YOUR_TENANT_ID with your Azure AD App Registration values.

import { PublicClientApplication, LogLevel } from "@azure/msal-browser";

// ──────────────────────────────────────────────────────────
// CONFIGURATION — update these values after App Registration
// ──────────────────────────────────────────────────────────
export const msalConfig = {
  auth: {
    clientId: process.env.REACT_APP_CLIENT_ID || "YOUR_CLIENT_ID",
   // authority: `https://login.microsoftonline.com/${process.env.REACT_APP_TENANT_ID || "YOUR_TENANT_ID"}`,
   authority: `https://login.microsoftonline.com/common`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => {
        if (level === LogLevel.Error) console.error("[MSAL]", message);
      },
      logLevel: LogLevel.Error,
    },
  },
};

// Scopes required for all Graph API features Dispatch uses
// export const graphScopes = [
//   "User.Read",
//   "Calendars.ReadWrite",
//   "Mail.ReadWrite",
//   "Mail.Send",
//   "Tasks.ReadWrite",
//   "OnlineMeetings.Read",
// ];

export const graphScopes = [
  "User.Read",
  "Calendars.ReadWrite",
  "Mail.ReadWrite",
  "Mail.Send",
  "Tasks.ReadWrite",
];

export const loginRequest = {
  scopes: graphScopes,
};

export const msalInstance = new PublicClientApplication(msalConfig);

// ──────────────────────────────────────────────────────────
// TOKEN HELPER
// ──────────────────────────────────────────────────────────

/**
 * Get a valid access token silently (no popup if already authenticated).
 * Falls back to interactive popup on failure.
 */
export async function getAccessToken() {
  await msalInstance.initialize();
  const accounts = msalInstance.getAllAccounts();

  if (accounts.length === 0) {
    throw new Error("No authenticated account. Please sign in.");
  }

  try {
    const response = await msalInstance.acquireTokenSilent({
      ...loginRequest,
      account: accounts[0],
    });
    return response.accessToken;
  } catch {
    // Silent token acquisition failed — show login popup
    const response = await msalInstance.acquireTokenPopup(loginRequest);
    return response.accessToken;
  }
}

/**
 * Get the currently signed-in user's display name and email.
 */
export function getCurrentUser() {
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length === 0) return null;
  return {
    name: accounts[0].name,
    email: accounts[0].username,
    localAccountId: accounts[0].localAccountId,
  };
}
