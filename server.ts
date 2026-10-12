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
import { db, UPLOADS_DIR, getSetting, getAllSettings, updateSetting } from "./db";

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
const rawPort = process.env.PORT || 3000;
const PORT: number = typeof rawPort === "number" ? rawPort : parseInt(String(rawPort), 10) || 3000;

// Application base path (defaults to /citycare, or process.env.BASE_PATH)
// Must match cPanel's "Setup Node.js App" -> Application URL
const BASE_PATH = process.env.BASE_PATH || "/citycare";

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

// API: List uploaded reports with search by report ID, phone number, or patient name.
router.get("/api/reports", requireAdminAuth, (req, res) => {
  const search = (req.query.search as string || "").trim();
  const phone = (req.query.phone as string || "").trim();
  const reportId = (req.query.reportId as string || "").trim();

  let query = "SELECT * FROM reports WHERE 1=1";
  const params: any[] = [];

  if (reportId) {
    query += " AND UPPER(report_id) LIKE ?";
    params.push(`%${reportId.toUpperCase()}%`);
  }

  if (phone) {
    const cleanPhone = phone.replace(/\D/g, "");
    query += " AND REPLACE(REPLACE(REPLACE(patient_phone, ' ', ''), '-', ''), '+', '') LIKE ?";
    params.push(`%${cleanPhone}%`);
  }

  if (search && !reportId && !phone) {
    const cleanDigits = search.replace(/\D/g, "");
    query += ` AND (
      UPPER(COALESCE(report_id, '')) LIKE ?
      OR patient_name LIKE ?
      ${cleanDigits.length >= 3 ? "OR REPLACE(REPLACE(REPLACE(patient_phone, ' ', ''), '-', ''), '+', '') LIKE ?" : "OR patient_phone LIKE ?"}
    )`;
    params.push(`%${search.toUpperCase()}%`, `%${search}%`, `%${cleanDigits.length >= 3 ? cleanDigits : search}%`);
  }

  query += " ORDER BY created_at DESC";

  const reports = db.prepare(query).all(...params);
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
// APPOINTMENTS & PAYMENTS — Public booking, payment workflows,
// patient tracking, receipts, and admin management.
// ============================================================

// Rate limiter for patient appointment status tracking to prevent phone enumeration
const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: "Too many status check attempts. Please wait 15 minutes before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper: generate friendly unique booking reference like CC-APP-20261012-7890
function generateBookingReference(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  return `CC-APP-${dateStr}-${randomSuffix}`;
}

// API: Public payment configuration for the booking form
router.get("/api/payment-config", (_req, res) => {
  const settings = getAllSettings();
  res.json({
    bkash: {
      enabled: settings.bkash_enabled === "1",
      number: settings.bkash_number || "01789555666",
      instructions: settings.bkash_instructions || "",
    },
    nagad: {
      enabled: settings.nagad_enabled === "1",
      number: settings.nagad_number || "01789555666",
      instructions: settings.nagad_instructions || "",
    },
    payAtCenter: {
      enabled: settings.pay_at_center_enabled === "1",
      instructions: settings.pay_at_center_instructions || "",
    },
    centerInfo: {
      name: settings.center_name || "CityCare Diagnostic & Consultation Center",
      hotline: settings.center_hotline || "01789-555666",
      address: settings.center_address || "Mirpur 10, Dhaka",
    },
  });
});

// API: Patient books an appointment.
// Mandatory time-slot removed; payment method supports Center / bKash / Nagad.
router.post("/api/appointments", (req, res) => {
  const {
    patientName,
    patientPhone,
    doctorId,
    appointmentDate,
    timeSlot,
    paymentMethod = "center",
    senderPhone,
    transactionId,
    notes,
  } = req.body;

  if (!patientName || !patientName.trim()) {
    return res.status(400).json({ error: "Patient full name is required." });
  }

  if (!patientPhone || !isValidPhone(patientPhone)) {
    return res.status(400).json({
      error: "Valid patient phone number is required (10 to 15 digits).",
    });
  }

  if (!doctorId) {
    return res.status(400).json({ error: "Please select a doctor." });
  }

  if (!appointmentDate || !/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) {
    return res.status(400).json({ error: "A valid appointment date (YYYY-MM-DD) is required." });
  }

  const validMethods = ["center", "bkash", "nagad"];
  const selectedMethod = String(paymentMethod).toLowerCase();
  if (!validMethods.includes(selectedMethod)) {
    return res.status(400).json({ error: "Invalid payment method selected." });
  }

  // Verify doctor exists and is active
  const doctor = db.prepare("SELECT * FROM doctors WHERE id = ? AND active = 1").get(doctorId) as any;
  if (!doctor) {
    return res.status(400).json({ error: "Selected doctor is not available for booking." });
  }

  // Payment method validation
  let finalSenderPhone: string | null = null;
  let finalTxId: string | null = null;
  let initialPaymentStatus = "unpaid";

  if (selectedMethod === "bkash" || selectedMethod === "nagad") {
    if (!senderPhone || !isValidPhone(senderPhone)) {
      return res.status(400).json({
        error: `Please enter a valid sender mobile number for ${selectedMethod.toUpperCase()} payment.`,
      });
    }
    if (!transactionId || transactionId.trim().length < 4) {
      return res.status(400).json({
        error: `Please enter the valid ${selectedMethod.toUpperCase()} Transaction ID (TrxID).`,
      });
    }
    finalSenderPhone = senderPhone.trim();
    finalTxId = transactionId.trim().toUpperCase();
    initialPaymentStatus = "verification_pending";
  } else {
    // Pay at Center: no mobile payment fields required or stored
    finalSenderPhone = null;
    finalTxId = null;
    initialPaymentStatus = "unpaid";
  }

  const bookingRef = generateBookingReference();
  const accessToken = uuidv4();
  const initialApptStatus = "pending";

  const insert = db.prepare(`
    INSERT INTO appointments (
      booking_reference,
      access_token,
      patient_name,
      patient_phone,
      doctor_id,
      appointment_date,
      time_slot,
      payment_method,
      payment_sender_phone,
      transaction_id,
      status,
      payment_status,
      notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const logEvent = db.prepare(`
    INSERT INTO appointment_events (appointment_id, event_type, details)
    VALUES (?, 'created', ?)
  `);

  let newId: number | bigint = 0;

  db.transaction(() => {
    const result = insert.run(
      bookingRef,
      accessToken,
      patientName.trim(),
      patientPhone.trim(),
      doctorId,
      appointmentDate,
      timeSlot ? timeSlot.trim() : null,
      selectedMethod,
      finalSenderPhone,
      finalTxId,
      initialApptStatus,
      initialPaymentStatus,
      notes ? notes.trim() : null
    );
    newId = result.lastInsertRowid;
    logEvent.run(
      newId,
      `Appointment booked with payment method: ${selectedMethod}, initial payment status: ${initialPaymentStatus}`
    );
  })();

  res.json({
    success: true,
    id: newId,
    bookingReference: bookingRef,
    accessToken,
    status: initialApptStatus,
    paymentStatus: initialPaymentStatus,
    paymentMethod: selectedMethod,
    receiptUrl: `${BASE_PATH}/receipt/${accessToken}`,
    message:
      selectedMethod === "center"
        ? "আপনার বুকিং অনুরোধ সফলভাবে জমা হয়েছে। সেন্টারে এসে ফি পরিশোধ করবেন এবং অ্যাডমিন অনুমোদনের অপেক্ষা করুন।"
        : "আপনার বুকিং ও পেমেন্ট তথ্য সফলভাবে জমা হয়েছে। অ্যাডমিন দ্বারা ট্রানজেকশন যাচাই ও অনুমোদনের অপেক্ষা করুন।",
  });
});

// API: Patient status tracking lookup by phone number or booking reference
router.get("/api/appointments/track", trackingLimiter, (req, res) => {
  const phone = (req.query.phone as string || "").trim();
  const ref = (req.query.ref as string || "").trim();

  if (!phone && !ref) {
    return res.status(400).json({ error: "Please enter your mobile number or booking reference." });
  }

  let query = `
    SELECT
      appointments.booking_reference,
      appointments.access_token,
      appointments.patient_name,
      appointments.patient_phone,
      appointments.appointment_date,
      appointments.time_slot,
      appointments.payment_method,
      appointments.transaction_id,
      appointments.status,
      appointments.payment_status,
      appointments.created_at,
      doctors.name AS doctor_name,
      doctors.specialty_category AS doctor_specialty,
      doctors.fee AS doctor_fee
    FROM appointments
    LEFT JOIN doctors ON doctors.id = appointments.doctor_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (ref) {
    query += " AND UPPER(appointments.booking_reference) = ?";
    params.push(ref.toUpperCase());
  } else if (phone) {
    const cleanPhone = phone.replace(/\D/g, "");
    query += " AND REPLACE(REPLACE(REPLACE(appointments.patient_phone, ' ', ''), '-', ''), '+', '') LIKE ?";
    params.push(`%${cleanPhone}%`);
  }

  query += " ORDER BY appointments.created_at DESC LIMIT 20";

  const rows = db.prepare(query).all(...params) as any[];

  // Sanitize patient phone for privacy in public search
  const sanitized = rows.map((r) => {
    const p = r.patient_phone || "";
    const maskedPhone = p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p;
    return {
      bookingReference: r.booking_reference,
      accessToken: r.access_token,
      patientName: r.patient_name,
      patientPhoneMasked: maskedPhone,
      doctorName: r.doctor_name || "Doctor",
      doctorSpecialty: r.doctor_specialty || "",
      doctorFee: r.doctor_fee || 0,
      appointmentDate: r.appointment_date,
      timeSlot: r.time_slot,
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      status: r.status,
      createdAt: r.created_at,
      receiptUrl: `${BASE_PATH}/receipt/${r.access_token}`,
    };
  });

  res.json({ success: true, count: sanitized.length, appointments: sanitized });
});

// API: Detailed appointment receipt payload by secure access token
router.get("/api/appointments/receipt/:token", (req, res) => {
  const { token } = req.params;

  const appt = db
    .prepare(
      `
      SELECT
        appointments.*,
        doctors.name AS doctor_name,
        doctors.specialty_category AS doctor_specialty,
        doctors.degree AS doctor_degree,
        doctors.experience AS doctor_experience,
        doctors.chamber_time AS doctor_chamber_time,
        doctors.fee AS doctor_fee
      FROM appointments
      LEFT JOIN doctors ON doctors.id = appointments.doctor_id
      WHERE appointments.access_token = ? OR appointments.booking_reference = ?
    `
    )
    .get(token, token) as any;

  if (!appt) {
    return res.status(404).json({ error: "Appointment booking record not found." });
  }

  const settings = getAllSettings();

  res.json({
    centerName: settings.center_name || "CityCare Diagnostic & Consultation Center",
    centerHotline: settings.center_hotline || "01789-555666",
    centerAddress: settings.center_address || "House #12, Road #3, Block #B, Mirpur 10, Dhaka - 1216",
    bookingReference: appt.booking_reference,
    accessToken: appt.access_token,
    patientName: appt.patient_name,
    patientPhone: appt.patient_phone,
    doctorName: appt.doctor_name || "—",
    doctorSpecialty: appt.doctor_specialty || "—",
    doctorDegree: appt.doctor_degree || "",
    doctorFee: appt.doctor_fee || 0,
    appointmentDate: appt.appointment_date,
    timeSlot: appt.time_slot,
    paymentMethod: appt.payment_method,
    paymentSenderPhone: appt.payment_sender_phone,
    transactionId: appt.transaction_id,
    status: appt.status,
    paymentStatus: appt.payment_status,
    approvedAt: appt.approved_at,
    paymentVerifiedAt: appt.payment_verified_at,
    createdAt: appt.created_at,
    notes: appt.notes,
  });
});

// Page: Patient-facing appointment receipt slip
router.get("/receipt/:token", (_req, res) => {
  const filePath =
    process.env.NODE_ENV === "production"
      ? path.join(process.cwd(), "dist", "receipt.html")
      : path.join(process.cwd(), "receipt.html");

  res.sendFile(filePath);
});

// API: Admin list of appointments with comprehensive filtering & search
router.get("/api/appointments", requireAdminAuth, (req, res) => {
  const search = (req.query.search as string || "").trim();
  const status = (req.query.status as string || "all").trim();
  const paymentStatus = (req.query.paymentStatus as string || "all").trim();
  const dateRange = (req.query.dateRange as string || "all").trim();
  const dateField = (req.query.dateField as string || "appointment_date").trim();
  const startDate = (req.query.startDate as string || "").trim();
  const endDate = (req.query.endDate as string || "").trim();

  let sql = `
    SELECT
      appointments.*,
      doctors.name AS doctor_name,
      doctors.specialty_category AS doctor_specialty,
      doctors.fee AS doctor_fee
    FROM appointments
    LEFT JOIN doctors ON doctors.id = appointments.doctor_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (search) {
    const q = `%${search}%`;
    const cleanDigits = `%${search.replace(/\D/g, "")}%`;
    sql += ` AND (
      appointments.patient_name LIKE ?
      OR appointments.booking_reference LIKE ?
      OR appointments.transaction_id LIKE ?
      OR appointments.patient_phone LIKE ?
      OR REPLACE(REPLACE(appointments.patient_phone, ' ', ''), '-', '') LIKE ?
    )`;
    params.push(q, q, q, q, cleanDigits);
  }

  if (status && status !== "all") {
    sql += " AND appointments.status = ?";
    params.push(status);
  }

  if (paymentStatus && paymentStatus !== "all") {
    sql += " AND appointments.payment_status = ?";
    params.push(paymentStatus);
  }

  const dateCol = dateField === "created_at" ? "date(appointments.created_at)" : "date(appointments.appointment_date)";

  if (dateRange === "today") {
    sql += ` AND ${dateCol} = date('now')`;
  } else if (dateRange === "yesterday") {
    sql += ` AND ${dateCol} = date('now', '-1 day')`;
  } else if (dateRange === "this_week") {
    sql += ` AND ${dateCol} >= date('now', '-7 days')`;
  } else if (dateRange === "this_month") {
    sql += ` AND ${dateCol} >= date('now', 'start of month')`;
  } else if (dateRange === "custom") {
    if (startDate && endDate) {
      sql += ` AND ${dateCol} BETWEEN ? AND ?`;
      params.push(startDate, endDate);
    } else if (startDate) {
      sql += ` AND ${dateCol} >= ?`;
      params.push(startDate);
    } else if (endDate) {
      sql += ` AND ${dateCol} <= ?`;
      params.push(endDate);
    }
  }

  sql += " ORDER BY appointments.created_at DESC";

  const appointments = db.prepare(sql).all(...params);
  res.json(appointments);
});

// API: Summary analytics statistics for admin dashboard overview
router.get("/api/appointments/stats", requireAdminAuth, (_req, res) => {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM appointments").get() as any).c;
  const pending = (db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE status = 'pending'").get() as any).c;
  const confirmed = (db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE status = 'confirmed'").get() as any).c;
  const cancelled = (db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE status = 'cancelled'").get() as any).c;
  const verificationPending = (db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE payment_status = 'verification_pending'").get() as any).c;
  const verified = (db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE payment_status = 'verified'").get() as any).c;
  const unpaid = (db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE payment_status = 'unpaid'").get() as any).c;
  const bookedToday = (db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE date(created_at) = date('now')").get() as any).c;
  const scheduledToday = (db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE date(appointment_date) = date('now')").get() as any).c;

  res.json({
    total,
    pending,
    confirmed,
    cancelled,
    verificationPending,
    verified,
    unpaid,
    bookedToday,
    scheduledToday,
  });
});

// API: Admin explicit appointment approval workflow (pending / confirmed / cancelled)
router.put("/api/appointments/:id/approval", requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["pending", "confirmed", "cancelled"];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: "Status must be one of: pending, confirmed, cancelled." });
  }

  const existing = db.prepare("SELECT * FROM appointments WHERE id = ?").get(id) as any;
  if (!existing) {
    return res.status(404).json({ error: "Appointment not found." });
  }

  const adminUser = (req.session as any)?.adminUsername || "admin";

  db.transaction(() => {
    db.prepare(`
      UPDATE appointments
      SET status = ?, approved_by = ?, approved_at = datetime('now')
      WHERE id = ?
    `).run(status, adminUser, id);

    db.prepare(`
      INSERT INTO appointment_events (appointment_id, event_type, admin_username, details)
      VALUES (?, 'approval_change', ?, ?)
    `).run(id, adminUser, `Appointment status changed to ${status}`);
  })();

  res.json({ success: true, status, approvedBy: adminUser });
});

// API: Admin explicit payment verification workflow (unpaid / verification_pending / verified / rejected)
router.put("/api/appointments/:id/payment", requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { paymentStatus } = req.body;

  const allowedPaymentStatuses = ["unpaid", "verification_pending", "verified", "rejected"];
  if (!allowedPaymentStatuses.includes(paymentStatus)) {
    return res.status(400).json({
      error: "Payment status must be one of: unpaid, verification_pending, verified, rejected.",
    });
  }

  const existing = db.prepare("SELECT * FROM appointments WHERE id = ?").get(id) as any;
  if (!existing) {
    return res.status(404).json({ error: "Appointment not found." });
  }

  const adminUser = (req.session as any)?.adminUsername || "admin";

  db.transaction(() => {
    db.prepare(`
      UPDATE appointments
      SET payment_status = ?, payment_verified_by = ?, payment_verified_at = datetime('now')
      WHERE id = ?
    `).run(paymentStatus, adminUser, id);

    db.prepare(`
      INSERT INTO appointment_events (appointment_id, event_type, admin_username, details)
      VALUES (?, 'payment_change', ?, ?)
    `).run(id, adminUser, `Payment status changed to ${paymentStatus}`);
  })();

  res.json({ success: true, paymentStatus, verifiedBy: adminUser });
});

// API: Backward-compatible status updater
router.put("/api/appointments/:id", requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["pending", "confirmed", "cancelled"];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: "Status must be one of: pending, confirmed, cancelled." });
  }

  const adminUser = (req.session as any)?.adminUsername || "admin";

  const result = db
    .prepare(
      "UPDATE appointments SET status = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?"
    )
    .run(status, adminUser, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Appointment not found." });
  }

  res.json({ success: true });
});

// API: Admin deletes an appointment record.
router.delete("/api/appointments/:id", requireAdminAuth, (req, res) => {
  const { id } = req.params;

  db.transaction(() => {
    db.prepare("DELETE FROM appointment_events WHERE appointment_id = ?").run(id);
    const result = db.prepare("DELETE FROM appointments WHERE id = ?").run(id);
    if (result.changes === 0) {
      throw new Error("Appointment not found.");
    }
  })();

  res.json({ success: true });
});

// API: Export filtered appointment list to CSV
router.get("/api/appointments/export-csv", requireAdminAuth, (req, res) => {
  const search = (req.query.search as string || "").trim();
  const status = (req.query.status as string || "all").trim();
  const paymentStatus = (req.query.paymentStatus as string || "all").trim();

  let sql = `
    SELECT
      appointments.*,
      doctors.name AS doctor_name,
      doctors.specialty_category AS doctor_specialty,
      doctors.fee AS doctor_fee
    FROM appointments
    LEFT JOIN doctors ON doctors.id = appointments.doctor_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (search) {
    const q = `%${search}%`;
    sql += ` AND (appointments.patient_name LIKE ? OR appointments.booking_reference LIKE ? OR appointments.patient_phone LIKE ?)`;
    params.push(q, q, q);
  }

  if (status && status !== "all") {
    sql += " AND appointments.status = ?";
    params.push(status);
  }

  if (paymentStatus && paymentStatus !== "all") {
    sql += " AND appointments.payment_status = ?";
    params.push(paymentStatus);
  }

  sql += " ORDER BY appointments.created_at DESC";

  const rows = db.prepare(sql).all(...params) as any[];

  function escapeCsv(val: any): string {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  }

  const headers = [
    "Booking Reference",
    "Patient Name",
    "Phone",
    "Doctor",
    "Specialty",
    "Doctor Fee",
    "Appointment Date",
    "Time Slot",
    "Payment Method",
    "Sender Phone",
    "Transaction ID",
    "Payment Status",
    "Appointment Status",
    "Booked Date",
    "Approved By",
  ];

  const csvRows = [headers.join(",")];

  for (const r of rows) {
    csvRows.push([
      escapeCsv(r.booking_reference),
      escapeCsv(r.patient_name),
      escapeCsv(r.patient_phone),
      escapeCsv(r.doctor_name),
      escapeCsv(r.doctor_specialty),
      escapeCsv(r.doctor_fee),
      escapeCsv(r.appointment_date),
      escapeCsv(r.time_slot || "—"),
      escapeCsv(r.payment_method),
      escapeCsv(r.payment_sender_phone || "—"),
      escapeCsv(r.transaction_id || "—"),
      escapeCsv(r.payment_status),
      escapeCsv(r.status),
      escapeCsv(r.created_at),
      escapeCsv(r.approved_by || "—"),
    ].join(","));
  }

  const csvContent = "\uFEFF" + csvRows.join("\r\n"); // UTF-8 BOM for Excel compatibility

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="citycare-appointments-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csvContent);
});

// API: Admin gets all settings
router.get("/api/admin/settings", requireAdminAuth, (_req, res) => {
  res.json(getAllSettings());
});

// API: Admin updates settings
router.put("/api/admin/settings", requireAdminAuth, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ error: "Invalid settings payload." });
  }

  for (const [key, value] of Object.entries(updates)) {
    if (typeof key === "string" && typeof value === "string") {
      updateSetting(key, value);
    }
  }

  res.json({ success: true, settings: getAllSettings() });
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

  if (typeof rawPort === "string" && isNaN(Number(rawPort))) {
    app.listen(rawPort, () => {
      console.log(`Diagnostic Center web app server listening on socket ${rawPort}`);
    });
  } else {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Diagnostic Center web app server running on port ${PORT}`);
    });
  }
}

initializeServer();