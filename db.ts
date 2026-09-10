import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Folder where our database file and uploaded report files will live.
// This folder is OUTSIDE any folder that gets served to the public website,
// so files inside it can only be reached through our own backend code —
// never by guessing a URL.
const DATA_DIR = path.join(process.cwd(), "private-data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

// Create these folders automatically if they don't exist yet.
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "citycare.db");

export const db = new Database(DB_PATH);

// Table 1: every uploaded report
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    report_id TEXT,
    patient_name TEXT NOT NULL,
    patient_phone TEXT NOT NULL,
    test_date TEXT NOT NULL,
    file_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    sms_status TEXT NOT NULL DEFAULT 'pending', -- reserved for future SMS feature, not yet wired up
    view_count INTEGER NOT NULL DEFAULT 0,
    download_count INTEGER NOT NULL DEFAULT 0,
    last_viewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const existingReportColumns = db
  .prepare("PRAGMA table_info(reports)")
  .all()
  .map((row: any) => row.name);

if (!existingReportColumns.includes("report_id")) {
  db.exec(`ALTER TABLE reports ADD COLUMN report_id TEXT;`);
}

// Table 2: history log used for the tracking page (every view + every download)
db.exec(`
  CREATE TABLE IF NOT EXISTS report_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_time TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (report_id) REFERENCES reports(id)
  );
`);

// Table 3: admin/operator login accounts
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
`);

// Table 4: doctors — manageable from the admin dashboard (add/edit/delete).
// specialty_category groups doctors for the two-step "pick category, then
// pick doctor" booking flow on the public site (e.g. "Medicine", "Cardiology").
// `active` lets an admin hide a doctor from the public booking form without
// deleting them outright (keeps history intact for any existing appointments).
db.exec(`
  CREATE TABLE IF NOT EXISTS doctors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    specialty_category TEXT NOT NULL,
    degree TEXT,
    experience TEXT,
    chamber_time TEXT,
    fee INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Table 5: patient appointment bookings made from the public site.
// Linked to a specific doctor; status lets the admin track pending vs
// confirmed vs cancelled without needing a separate workflow system.
db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT NOT NULL,
    patient_phone TEXT NOT NULL,
    doctor_id INTEGER NOT NULL,
    appointment_date TEXT NOT NULL,
    time_slot TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (doctor_id) REFERENCES doctors(id)
  );
`);

// One-time seed: if no doctors exist yet (fresh install, or first run after
// this feature was added), pre-populate with the doctors that used to be
// hardcoded on the homepage, so the booking form and dashboard aren't empty
// on day one. Safe to run every boot — only fires when the table is empty.
const doctorCount = (
  db.prepare("SELECT COUNT(*) AS count FROM doctors").get() as any
).count;

if (doctorCount === 0) {
  const seedDoctor = db.prepare(`
    INSERT INTO doctors (name, specialty_category, degree, experience, chamber_time, fee, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  const seedDoctors = [
    [
      "Dr. M. A. Rahman",
      "Medicine",
      "MBBS, FCPS (Medicine)",
      "১০+ বছর",
      "৫:০০ PM - ৯:০০ PM (শনি - বুধ)",
      800,
    ],
    [
      "Dr. Nusrat Jahan",
      "Gynae & Obstetrics",
      "MBBS, FCPS, MS (Gynae)",
      "৮+ বছর",
      "৪:০০ PM - ৮:০০ PM (রবি - বৃহস্পতি)",
      800,
    ],
    [
      "Prof. Dr. Kamal Uddin",
      "Cardiology",
      "MBBS, MD (NICVD), FACC",
      "১৫+ বছর",
      "৬:০০ PM - ৯:৩০ PM (শনি, সোম, বুধ)",
      1000,
    ],
    [
      "Dr. Amit Hasan",
      "Sonologist & Radiologist",
      "MBBS, DMUD (Ultrasound)",
      "৬+ বছর",
      "৭:০০ AM - ৩:০০ PM (শনি - বৃহস্পতি)",
      700,
    ],
  ];

  for (const doctor of seedDoctors) {
    seedDoctor.run(...doctor);
  }
}

export { UPLOADS_DIR };