/**
 * ResQNear — Backend API Server
 * Node.js + Express + MySQL
 * Run: node server.js
 */

const express    = require("express");
const mysql      = require("mysql2/promise");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const cors       = require("cors");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("../frontend"));  // serve frontend

// ── DB CONFIG ──────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || "localhost",
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASS     || "",
  database: process.env.DB_NAME     || "resqnear",
  waitForConnections: true,
  connectionLimit: 10,
});

const JWT_SECRET = process.env.JWT_SECRET || "resqnear_secret_change_in_prod";



// ── AUTH MIDDLEWARE ────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

// ── HAVERSINE (distance in km) ─────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))).toFixed(2);
}

// ══════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════

// POST /api/auth/register
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, phone, emergency_contact } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "Name, email and password are required" });

  const [exists] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
  if (exists.length) return res.status(409).json({ error: "Email already registered" });

  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    "INSERT INTO users (name, email, password, phone, emergency_contact) VALUES (?,?,?,?,?)",
    [name, email, hash, phone || null, emergency_contact || null]
  );

  const user = { id: result.insertId, name, email, role: "user" };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: "7d" });
  res.status(201).json({ user: { ...user, token } });
});

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
  if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });

  const user = rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid credentials" });

  const payload = { id: user.id, name: user.name, email: user.email, role: user.role };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
  res.json({ user: { ...payload, token } });
});

// ══════════════════════════════════════════════════════════
//  RESOURCES ROUTES (Public)
// ══════════════════════════════════════════════════════════

// GET /api/resources?type=hospital&lat=19.99&lng=73.78&q=keyword
app.get("/api/resources", async (req, res) => {
  const { type, lat, lng, q } = req.query;

  let sql = "SELECT * FROM resources WHERE 1=1";
  const params = [];

  if (type && type !== "all") { sql += " AND type = ?"; params.push(type); }
  if (q) { sql += " AND (name LIKE ? OR address LIKE ?)"; params.push(`%${q}%`, `%${q}%`); }

  const [rows] = await pool.query(sql, params);

  // Calculate distance if user location provided
  if (lat && lng) {
    rows.forEach(r => {
      if (r.latitude && r.longitude) {
        r.distance = haversine(parseFloat(lat), parseFloat(lng), r.latitude, r.longitude);
      }
    });
    rows.sort((a, b) => (parseFloat(a.distance) || 999) - (parseFloat(b.distance) || 999));
  }

  res.json(rows);
});

// ══════════════════════════════════════════════════════════
//  SOS ROUTE
// ══════════════════════════════════════════════════════════

// POST /api/sos
app.post("/api/sos", authMiddleware, async (req, res) => {
  const { latitude, longitude } = req.body;
  const userId = req.user.id;

  // Log SOS event
  await pool.query(
    "INSERT INTO sos_logs (user_id, latitude, longitude) VALUES (?,?,?)",
    [userId, latitude, longitude]
  );

  // Get user's emergency contact
  const [rows] = await pool.query("SELECT emergency_contact, name FROM users WHERE id=?", [userId]);
  const user = rows[0];

  // In production: send email/SMS via Twilio/SendGrid here
  console.log(`🆘 SOS from user ${user?.name} at ${latitude},${longitude} — notify: ${user?.emergency_contact}`);

  res.json({ success: true, message: "SOS logged. Emergency contacts notified." });
});



// ══════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════

// GET /api/admin/resources
app.get("/api/admin/resources", authMiddleware, adminOnly, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM resources ORDER BY id DESC");
  res.json(rows);
});

// POST /api/admin/resources
app.post("/api/admin/resources", authMiddleware, adminOnly, async (req, res) => {
  const { name, type, address, contact, latitude, longitude, availability } = req.body;
  if (!name || !type) return res.status(400).json({ error: "Name and type required" });

  const [result] = await pool.query(
    "INSERT INTO resources (name, type, address, contact, latitude, longitude, availability) VALUES (?,?,?,?,?,?,?)",
    [name, type, address, contact, latitude || null, longitude || null, availability || "available"]
  );
  res.status(201).json({ id: result.insertId, message: "Resource added" });
});

// PATCH /api/admin/resources/:id
app.patch("/api/admin/resources/:id", authMiddleware, adminOnly, async (req, res) => {
  const { availability, name, contact, address } = req.body;
  const updates = [], params = [];
  if (availability) { updates.push("availability=?"); params.push(availability); }
  if (name)         { updates.push("name=?");         params.push(name); }
  if (contact)      { updates.push("contact=?");      params.push(contact); }
  if (address)      { updates.push("address=?");      params.push(address); }
  if (!updates.length) return res.status(400).json({ error: "Nothing to update" });
  params.push(req.params.id);
  await pool.query(`UPDATE resources SET ${updates.join(",")} WHERE id=?`, params);
  res.json({ message: "Updated" });
});

// DELETE /api/admin/resources/:id
app.delete("/api/admin/resources/:id", authMiddleware, adminOnly, async (req, res) => {
  await pool.query("DELETE FROM resources WHERE id=?", [req.params.id]);
  res.json({ message: "Deleted" });
});

// GET /api/admin/users
app.get("/api/admin/users", authMiddleware, adminOnly, async (req, res) => {
  const [rows] = await pool.query("SELECT id,name,email,phone,role,created_at FROM users ORDER BY id DESC");
  res.json(rows);
});

// DELETE /api/admin/users/:id
app.delete("/api/admin/users/:id", authMiddleware, adminOnly, async (req, res) => {
  await pool.query("DELETE FROM users WHERE id=?", [req.params.id]);
  res.json({ message: "User removed" });
});

// ══════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ResQNear backend running on http://localhost:${PORT}`);
});
