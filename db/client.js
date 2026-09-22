// db/client.js
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: false,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err.message);
});

// Named export for compatibility
export { pool };
export default pool;