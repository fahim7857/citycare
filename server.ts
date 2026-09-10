import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import rateLimit from "express-rate-limit";
import session from "express-session";
import SqliteStoreFactory from "better-sqlite3-session-store";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { db, UPLOADS_DIR } from "./db";

// NOTE ON ENV VARS: this project's _env.example was written for AI
// Studio/Cloud Run, which auto-injects GEMINI_API_KEY, APP_URL, and
// SESSION_SECRET into the process at runtime — no .env file needed there.
// cPanel/Passenger does NOT do this. dotenv.config() below only works if
// a real .env file (copied from _env.example, values filled in) exists in
// PassengerAppRoot, AND SESSION_SECRET is a new, unique random string —
// do not reuse the placeholder value from _env.example verbatim, since it
// is committed to the repo and not a secret. On cPanel it's more reliable
// to set these as actual environment variables inside "Setup Node.js App"
// -> Environment Variables, which Passenger injects directly — that
// survives worker recycles even if the .env file is ever missing/stale.
dotenv.config();

// Persistent, Passenger-safe session store. MemoryStore loses every
// session whenever a Passenger worker is recycled or restarted (which
// happens routinely on shared/CloudLinux hosting), so operators kept
// getting logged out unpredictably. This reuses the same better-sqlite3
// connection already opened for report data, so no extra process/driver
// is needed. It creates its own "sessions" table on first run.
const SqliteStore = SqliteStoreFactory(session);

const app = express();

// Trust Apache/Passenger's reverse proxy so req.protocol and req.secure
// reflect the real client-facing scheme (https), not the internal http
// hop between Apache and the Node process. Without this, req.protocol
// always reports "http" in production, which corrupts generated report
// links (e.g. http://renbora.com/citycare/report/... instead of https://).
app.set("trust proxy", 1);

// cPanel/Passenger assigns the actual port at runtime via process.env.PORT.
// Hardcoding 3000 can prevent the app from binding correctly on cPanel.
const PORT = process.env.PORT || 3000;

// This app is deployed under renbora.com/citycare/ instead of the domain
// root. BASE_PATH must exactly match:
//   1. The path in cPanel's "Setup Node.js App" -> Application URL
//   2. The `base` value set in vite.config.ts
const BASE_PATH = "/citycare";

// TEMPORARY DIAGNOSTIC — remove once routing is confirmed fixed.
// Logs exactly what path/host Apache+Passenger hand to Express, so you
// can confirm definitively whether /citycare is being stripped, doubled,
// or mangled, instead of guessing from the 404 message alone.
app.use((req, _res, next) => {
  console.log(
    `[routing-debug] RAW method=${req.method} originalUrl=${req.originalUrl} url=${req.url} host=${req.get("host")}`
  );
  next();
});

// NORMALIZE THE INCOMING URL — replaces the previous "mount everything
// twice, once at BASE_PATH and once at '/'" approach. That hedge worked
// for the router (harmless if one of the two mounts is simply inert) but
// became fragile once static file serving and a catch-all SPA route were
// also doubled — two overlapping "catch everything" layers is exactly
// the kind of setup that can misfire in hard-to-predict ways, which is
// almost certainly what broke uploads last time.
//
// This does the same job with ONE rule instead of two competing mounts:
// if Apache/Passenger already stripped the "/citycare" prefix before
// handing the request to Node, add it back here, once, before any
// routing happens. From this point on, every route in this file only
// ever needs to be registered at BASE_PATH — never at "/" — because by
// the time a request reaches those routes, it is guaranteed to already
// start with BASE_PATH.
app.use((req, _res, next) => {
  if (!req.url.startsWith(BASE_PATH)) {
    req.url = BASE_PATH + (req.url.startsWith("/") ? req.url : "/" + req.url);
  }
  console.log(`[routing-debug] NORMALIZED url=${req.url}`);
  next();
});

const router = express.Router();

router.use(express.json());

// Sessions — used to remember that an operator is logged in.
// NOTE: SESSION_SECRET must be set in production and should be a long random string.
if (!process.env.SESSION_SECRET) {
  throw new Error(
    "Missing required environment variable SESSION_SECRET. Please set SESSION_SECRET to a long random string before starting the server."
  );
}
router.use(
  session({
    store: new SqliteStore({
      client: db,
      expired: {
        clear: true,
        intervalMs: 1000 * 60 * 60, // purge expired sessions hourly
      },
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

// Small helper: blocks a request unless the operator is logged in.
function requireAdminAuth(req: any, res: any, next: any) {
  if (req.session && req.session.adminUsername) {
    return next();
  }
  return res.status(401).json({ error: "Please log in to do that." });
}

// Rate limiting for login to prevent repeated password guessing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: {
    error: "Too many login attempts. Please wait 15 minutes before trying again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// API: Health probe
router.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// API: Operator login
router.post("/api/login", loginLimiter, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const user = db
    .prepare("SELECT * FROM admin_users WHERE username = ?")
    .get(username) as any;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  (req.session as any).adminUsername = user.username;
  res.json({ success: true });
});

// API: Operator logout
router.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// Page: the operator upload form — only loads if logged in, otherwise
// bounces to the login page.
router.get("/admin-upload.html", (req, res) => {
  if (!(req.session as any)?.adminUsername) {
    return res.redirect(`${BASE_PATH}/admin-login.html`);
  }

  const filePath =
    process.env.NODE_ENV === "production"
      ? path.join(process.cwd(), "dist", "admin-upload.html")
      : path.join(process.cwd(), "admin-upload.html");

  res.sendFile(filePath);
});

// Page: the admin dashboard — only loads if logged in.
router.get("/admin-dashboard.html", (req, res) => {
  if (!(req.session as any)?.adminUsername) {
    return res.redirect(`${BASE_PATH}/admin-login.html`);
  }

  const filePath =
    process.env.NODE_ENV === "production"
      ? path.join(process.cwd(), "dist", "admin-dashboard.html")
      : path.join(process.cwd(), "admin-dashboard.html");

  res.sendFile(filePath);
});

// API: List every uploaded report, newest first. Used by admin-dashboard.html.
router.get("/api/reports", requireAdminAuth, (req, res) => {
  const reports = db
    .prepare("SELECT * FROM reports ORDER BY created_at DESC")
    .all();

  res.json(reports);
});

// Configure where uploaded report files get saved on disk.
// Every uploaded file gets a random secure token as its filename,
// so nobody can guess one report's link from another's.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const token = uuidv4();
    // Stash the token on the request so our route handler below can reuse
    // the exact same token for both the filename and the database row.
    (req as any).reportToken = token;
    const ext = path.extname(file.originalname);
    cb(null, `${token}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [".pdf", ".jpg", ".jpeg", ".png"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      return cb(new Error("Only PDF, JPG, JPEG, and PNG files are allowed."));
    }
    cb(null, true);
  },
});

// API: Operator uploads a new patient report — now requires login.
function isValidPhone(phone: string) {
  const normalized = phone.replace(/\D/g, "");
  return /^[0-9]{10,15}$/.test(normalized);
}

router.post("/api/reports", requireAdminAuth, upload.single("file"), (req, res) => {
  const { patientName, phone, date, reportId } = req.body;
  const file = req.file;
  const token = (req as any).reportToken;

  if (!patientName || !phone || !date || !token) {
    return res.status(400).json({
      error: "Patient name, phone number, and test date are required. A valid file upload is also required.",
    });
  }

  if (!isValidPhone(phone)) {
    return res.status(400).json({
      error: "Phone number must contain only digits and be 10 to 15 characters long.",
    });
  }

  if (!file) {
    return res.status(400).json({
      error: "A valid file upload is required. Please attach a PDF, JPG, JPEG, or PNG file under 20MB.",
    });
  }

  const insert = db.prepare(`
    INSERT INTO reports (token, report_id, patient_name, patient_phone, test_date, file_path, original_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(token, reportId || null, patientName, phone, date, file.filename, file.originalname);

  // Include BASE_PATH so the generated link opens correctly on its own.
  const link = `${req.protocol}://${req.get("host")}${BASE_PATH}/report/${token}`;

  res.json({
    success: true,
    token,
    link,
    message: "Report uploaded successfully.",
  });
});

// API: Patient-facing lookup by secure token. This is what report-view.html
// calls on load. The token (an unguessable random UUID) is the only
// credential required to view a report — the same trust model as any
// private share link. Every successful lookup counts as a "view" and is
// logged to report_events for the tracking/history page.
router.get("/api/reports/:token", (req, res) => {
  const { token } = req.params;

  const report = db
    .prepare("SELECT * FROM reports WHERE token = ?")
    .get(token) as any;

  if (!report) {
    return res.status(404).json({ error: "No report found for this link." });
  }

  db.prepare(
    "UPDATE reports SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE id = ?"
  ).run(report.id);
  db.prepare(
    "INSERT INTO report_events (report_id, event_type) VALUES (?, 'view')"
  ).run(report.id);

  res.json({
    patientName: report.patient_name,
    phone: report.patient_phone,
    testDate: report.test_date,
    originalFilename: report.original_filename,
    createdAt: report.created_at,
    // Include BASE_PATH so the frontend's fetch for the file resolves correctly.
    fileUrl: `${BASE_PATH}/api/reports/${token}/file`,
  });
});

// API: Streams the actual uploaded file for viewing or downloading.
// Every hit here is logged as a "download" event, separate from "view"
// events above, so the tracking page can show both numbers.
router.get("/api/reports/:token/file", (req, res) => {
  const { token } = req.params;

  const report = db
    .prepare("SELECT * FROM reports WHERE token = ?")
    .get(token) as any;

  if (!report) {
    return res.status(404).send("No report found for this link.");
  }

  const filePath = path.join(UPLOADS_DIR, report.file_path);

  if (!fs.existsSync(filePath)) {
    console.log(
      `[file-debug] Missing file on disk. Looked for: ${filePath} (UPLOADS_DIR=${UPLOADS_DIR}, report.file_path=${report.file_path})`
    );
    return res.status(404).send("This report's file is missing from storage.");
  }

  db.prepare(
    "UPDATE reports SET download_count = download_count + 1 WHERE id = ?"
  ).run(report.id);
  db.prepare(
    "INSERT INTO report_events (report_id, event_type) VALUES (?, 'download')"
  ).run(report.id);

  res.sendFile(filePath, {
    headers: {
      // "inline" lets browsers preview PDFs/images directly; the page's
      // own Download button still forces a save via the `download` attribute.
      "Content-Disposition": `inline; filename="${report.original_filename}"`,
    },
  });
});

// Page: the patient-facing report viewer. The :token is read client-side
// (report-view.html calls the API above), so this route just needs to
// serve the same static HTML file no matter what token is in the URL.
router.get("/report/:token", (req, res) => {
  const reportPagePath =
    process.env.NODE_ENV === "production"
      ? path.join(process.cwd(), "dist", "report-view.html")
      : path.join(process.cwd(), "report-view.html");

  res.sendFile(reportPagePath);
});

// ============================================================
// DOCTORS — manageable from the admin dashboard (add/edit/delete).
// Powers the two-step "pick specialty category, then pick doctor"
// booking flow on the public site (index.html).
// ============================================================

// API: Public list of bookable doctors. Only returns active doctors —
// an admin can hide a doctor from the public booking form by setting
// active=0 via the edit route below, without deleting their record
// (keeps any existing appointment history intact).
router.get("/api/doctors", (req, res) => {
  const doctors = db
    .prepare("SELECT * FROM doctors WHERE active = 1 ORDER BY specialty_category, name")
    .all();

  res.json(doctors);
});

// API: Admin-only list of every doctor, active AND inactive — used by
// the doctor management table in admin-dashboard.html so an admin can
// see (and re-activate) doctors that are currently hidden.
router.get("/api/doctors/all", requireAdminAuth, (req, res) => {
  const doctors = db
    .prepare("SELECT * FROM doctors ORDER BY specialty_category, name")
    .all();

  res.json(doctors);
});

// API: Admin adds a new doctor.
router.post("/api/doctors", requireAdminAuth, (req, res) => {
  const { name, specialtyCategory, degree, experience, chamberTime, fee, active } = req.body;

  if (!name || !specialtyCategory) {
    return res.status(400).json({ error: "Doctor name and specialty category are required." });
  }

  const feeNumber = Number(fee);

  const insert = db.prepare(`
    INSERT INTO doctors (name, specialty_category, degree, experience, chamber_time, fee, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(
    name,
    specialtyCategory,
    degree || null,
    experience || null,
    chamberTime || null,
    Number.isFinite(feeNumber) ? feeNumber : 0,
    active === false || active === 0 ? 0 : 1
  );

  res.json({ success: true, id: result.lastInsertRowid });
});

// API: Admin edits an existing doctor (including toggling active on/off).
router.put("/api/doctors/:id", requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { name, specialtyCategory, degree, experience, chamberTime, fee, active } = req.body;

  const existing = db.prepare("SELECT * FROM doctors WHERE id = ?").get(id);
  if (!existing) {
    return res.status(404).json({ error: "Doctor not found." });
  }

  if (!name || !specialtyCategory) {
    return res.status(400).json({ error: "Doctor name and specialty category are required." });
  }

  const feeNumber = Number(fee);

  db.prepare(`
    UPDATE doctors
    SET name = ?, specialty_category = ?, degree = ?, experience = ?, chamber_time = ?, fee = ?, active = ?
    WHERE id = ?
  `).run(
    name,
    specialtyCategory,
    degree || null,
    experience || null,
    chamberTime || null,
    Number.isFinite(feeNumber) ? feeNumber : 0,
    active === false || active === 0 ? 0 : 1,
    id
  );

  res.json({ success: true });
});

// API: Admin deletes a doctor. Blocked if that doctor has existing
// appointments booked against them, to avoid orphaning appointment
// records — deactivating via the edit route above is the safe way to
// remove a doctor from the public booking form in that case.
router.delete("/api/doctors/:id", requireAdminAuth, (req, res) => {
  const { id } = req.params;

  const appointmentCount = (
    db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE doctor_id = ?").get(id) as any
  ).count;

  if (appointmentCount > 0) {
    return res.status(400).json({
      error:
        "This doctor has existing appointments and can't be deleted. Set them to inactive instead to hide them from the booking form.",
    });
  }

  const result = db.prepare("DELETE FROM doctors WHERE id = ?").run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Doctor not found." });
  }

  res.json({ success: true });
});

// ============================================================
// APPOINTMENTS — patient bookings from the public site, managed
// from the admin dashboard.
// ============================================================

// API: Patient books an appointment with a doctor. Public — no login
// required, since this is meant to be filled out by patients on the
// homepage booking form.
router.post("/api/appointments", (req, res) => {
  const { patientName, patientPhone, doctorId, appointmentDate, timeSlot } = req.body;

  if (!patientName || !patientPhone || !doctorId || !appointmentDate) {
    return res.status(400).json({
      error: "Patient name, phone number, doctor, and appointment date are required.",
    });
  }

  if (!isValidPhone(patientPhone)) {
    return res.status(400).json({
      error: "Phone number must contain only digits and be 10 to 15 characters long.",
    });
  }

  const doctor = db.prepare("SELECT * FROM doctors WHERE id = ? AND active = 1").get(doctorId);

  if (!doctor) {
    return res.status(400).json({ error: "Selected doctor is not available for booking." });
  }

  const insert = db.prepare(`
    INSERT INTO appointments (patient_name, patient_phone, doctor_id, appointment_date, time_slot)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = insert.run(patientName, patientPhone, doctorId, appointmentDate, timeSlot || null);

  res.json({ success: true, id: result.lastInsertRowid });
});

// API: Admin dashboard list of every appointment, newest first, joined
// with the doctor's name/specialty so the table doesn't need a second
// lookup per row.
router.get("/api/appointments", requireAdminAuth, (req, res) => {
  const appointments = db
    .prepare(
      `
      SELECT
        appointments.*,
        doctors.name AS doctor_name,
        doctors.specialty_category AS doctor_specialty
      FROM appointments
      LEFT JOIN doctors ON doctors.id = appointments.doctor_id
      ORDER BY appointments.created_at DESC
    `
    )
    .all();

  res.json(appointments);
});

// API: Admin updates an appointment's status (pending / confirmed / cancelled).
router.put("/api/appointments/:id", requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["pending", "confirmed", "cancelled"];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: "Status must be one of: pending, confirmed, cancelled." });
  }

  const result = db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Appointment not found." });
  }

  res.json({ success: true });
});

// API: Admin deletes an appointment record.
router.delete("/api/appointments/:id", requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const result = db.prepare("DELETE FROM appointments WHERE id = ?").run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Appointment not found." });
  }

  res.json({ success: true });
});

// Mount every route defined above under BASE_PATH. Thanks to the
// normalization middleware above, this is now the ONLY mount point
// needed — every request reaching this line is guaranteed to already
// start with BASE_PATH, whether Apache/Passenger stripped the prefix
// or not.
app.use(BASE_PATH, router);

// Configure Express to serve static assets and set up development/production runtime
async function initializeServer() {
  if (process.env.NODE_ENV !== "production") {
    // In development, let Vite handle request routing and asset serving.
    // Vite reads `base` from vite.config.ts and matches /citycare/... paths
    // on its own, so no extra prefixing is needed here.
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve the compiled dist directory under BASE_PATH,
    // matching cPanel's Application URL and vite.config.ts's `base`.
    // Single mount point only — same reasoning as the router above.
    const distPath = path.join(process.cwd(), "dist");
    app.use(BASE_PATH, express.static(distPath));
    app.get(`${BASE_PATH}/*`, (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Diagnostic Center web app server running on port ${PORT}`);
  });
}

initializeServer();