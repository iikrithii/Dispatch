// utils/auth.js
// Validates the Bearer token from the frontend and extracts the user's email.
// In production use Azure AD token validation. For prototype, we decode the JWT.

/**
 * Extract the access token from the Authorization header.
 * Returns { accessToken, userEmail } or throws.
 */
function extractAuth(req) {
  const authHeader = req.headers.get
    ? req.headers.get("authorization")
    : req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }

  const accessToken = authHeader.replace("Bearer ", "");

  try {
    // Base64url decode — personal account tokens may use padding variants
    const base64 = accessToken.split(".")[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(accessToken.split(".")[1].length / 4) * 4, "=");

    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));

    // Personal accounts: oid is present, sub is long opaque string
    // Fall through multiple fields to find something stable
    const userId =
      payload.oid ||           // org accounts
      payload.sub ||           // personal accounts fallback
      payload.preferred_username ||
      payload.email ||
      payload.upn ||
      "unknown";

    const userEmail =
      payload.preferred_username ||
      payload.upn ||
      payload.email ||
      payload.unique_name ||
      userId;

    return { accessToken, userEmail, userId };
  } catch (e) {
    // Token not decodable (opaque token) — use a hash of the token as stable ID
    const stableId = require("crypto")
      .createHash("sha256")
      .update(accessToken.slice(-32))
      .digest("hex")
      .slice(0, 16);
    return { accessToken, userEmail: "unknown@user.com", userId: stableId };
  }
}

/**
 * Standard CORS + JSON response helper.
 */
function jsonResponse(data, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
    body: JSON.stringify(data),
  };
}

function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

module.exports = { extractAuth, jsonResponse, errorResponse };