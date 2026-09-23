// db/client.js
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set.");
}

// TLS between Vercel and the database.
//
// Controlled by the DATABASE_SSL env var so the server and the app can be
// switched over independently (enabling it in code before the server supports
// TLS would take the site down, and vice versa).
//
//   DATABASE_SSL=true   → encrypt the connection (set this once Postgres has ssl=on)
//   unset / anything else → plaintext (current legacy behaviour)
//
// rejectUnauthorized:false still ENCRYPTS the traffic; it only skips verifying
// the certificate chain, which is required for a self-signed server cert.
// If you later install a CA-signed cert, set DATABASE_SSL_STRICT=true.
const sslEnabled = String(process.env.DATABASE_SSL || "").toLowerCase() === "true";
const sslStrict  = String(process.env.DATABASE_SSL_STRICT || "").toLowerCase() === "true";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: sslEnabled ? { rejectUnauthorized: sslStrict } : false,
});

if (!sslEnabled) {
  console.warn(
    "[db] WARNING: connecting to PostgreSQL WITHOUT TLS. " +
    "Credentials and personal data cross the network in plaintext. " +
    "Enable ssl on the server, then set DATABASE_SSL=true."
  );
}

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err.message);
});

// Named export for compatibility
export { pool };
export default pool;