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

export { UPLOADS_DIR };