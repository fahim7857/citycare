import bcrypt from "bcryptjs";
import { db } from "./db";

// This script creates (or resets) one admin login account.
// Run it from the terminal like this:
//   npx tsx create-admin.ts yourUsername yourPassword
const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.log("Please provide a username and password.");
  console.log("Example: npx tsx create-admin.ts admin MySecurePass123");
  process.exit(1);
}

const passwordHash = bcrypt.hashSync(password, 10);

const existing = db
  .prepare("SELECT id FROM admin_users WHERE username = ?")
  .get(username);

if (existing) {
  db.prepare("UPDATE admin_users SET password_hash = ? WHERE username = ?").run(
    passwordHash,
    username
  );
  console.log(`Password updated for existing admin user "${username}".`);
} else {
  db.prepare(
    "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)"
  ).run(username, passwordHash);
  console.log(`Admin user "${username}" created successfully.`);
}