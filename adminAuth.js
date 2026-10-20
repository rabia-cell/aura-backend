require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

async function requireAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /i, "");

    if (!token) {
      return res.status(401).json({ error: "Login required" });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({ error: "Invalid login" });
    }

const result = await pool.query(
  "SELECT user_id FROM public.admin_users WHERE user_id = $1",
  [data.user.id]
);

if (result.rows.length === 0) {
  return res.status(403).json({
    error: "Admin access required"
  });
}

req.user = data.user;
next();
  } catch (error) {
    res.status(500).json({ error: "Authentication failed" });
  }
}

module.exports = requireAdmin;
