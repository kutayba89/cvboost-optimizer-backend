// middleware/auth.js
import jwt from "jsonwebtoken";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is not set.");
}

/**
 * Extracts and verifies the Bearer token from the request headers.
 * @param {object} req
 * @returns {{ id: string, email: string }}
 */
export function requireAuth(req) {
  const authHeader = req.headers?.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw { status: 401, code: "NOT_LOGGED_IN", error: "Please log in to use the tool." };
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload; // { id, email, iat, exp }
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      throw { status: 401, code: "NOT_LOGGED_IN", error: "Session expired. Please log in again." };
    }
    throw { status: 401, code: "NOT_LOGGED_IN", error: "Invalid session. Please log in again." };
  }
}