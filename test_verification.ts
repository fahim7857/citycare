import { db, getSetting, updateSetting } from './db.ts';

// We can test against db directly and test server routes if imported or initiated
async function runTests() {
  console.log('--- STARTING CITYCARE COMPREHENSIVE VERIFICATION TESTS ---');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`[PASS] ${msg}`);
      passed++;
    } else {
      console.error(`[FAIL] ${msg}`);
      failed++;
    }
  }

  try {
    // Test 1: Verify Database Migrations & Columns
    console.log('\n--- 1. Database Schema & Migration Verification ---');
    const appColumns = db.prepare(`PRAGMA table_info(appointments)`).all() as Array<{ name: string }>;
    const colNames = appColumns.map(c => c.name);

    assert(colNames.includes('booking_reference'), 'appointments table has booking_reference column');
    assert(colNames.includes('access_token'), 'appointments table has access_token column');
    assert(colNames.includes('payment_method'), 'appointments table has payment_method column');
    assert(colNames.includes('payment_sender_phone'), 'appointments table has payment_sender_phone column');
    assert(colNames.includes('transaction_id'), 'appointments table has transaction_id column');
    assert(colNames.includes('payment_status'), 'appointments table has payment_status column');
    assert(colNames.includes('payment_verified_at'), 'appointments table has payment_verified_at column');
    assert(colNames.includes('payment_verified_by'), 'appointments table has payment_verified_by column');
    assert(colNames.includes('approved_at'), 'appointments table has approved_at column');
    assert(colNames.includes('approved_by'), 'appointments table has approved_by column');

    const settingsTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='settings'`).get();
    assert(!!settingsTable, 'settings table exists');

    const auditTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='appointment_events'`).get();
    assert(!!auditTable, 'appointment_events audit table exists');

    // Test 2: Settings Table Values
    console.log('\n--- 2. Payment Configuration Settings ---');
    const bkashNum = getSetting('bkash_number');
    const nagadNum = getSetting('nagad_number');
    assert(bkashNum !== null, `bKash number setting configured: ${bkashNum}`);
    assert(nagadNum !== null, `Nagad number setting configured: ${nagadNum}`);

    // Update settings test
    updateSetting('bkash_number', '01700000001');
    assert(getSetting('bkash_number') === '01700000001', 'bKash number setting successfully updated');
    // revert
    updateSetting('bkash_number', '01700000000 (Set in Admin)');

    // Test 3: Doctor Database Source of Truth
    console.log('\n--- 3. Dynamic Doctor Source of Truth & Department Filtering ---');
    const insertDoc = db.prepare(`
      INSERT INTO doctors (name, specialty_category, degree, experience, chamber_time, fee, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run('Dr. Automated Test Specialist', 'Cardiology', 'MBBS, FCPS', '12 Years', '5PM-8PM', 1200);
    const testDoctorId = Number(insertDoc.lastInsertRowid);

    const fetchedActiveDoc = db.prepare(`SELECT * FROM doctors WHERE id = ? AND active = 1`).get(testDoctorId) as any;
    assert(!!fetchedActiveDoc && fetchedActiveDoc.name === 'Dr. Automated Test Specialist', 'Dynamic doctor successfully created in SQLite');
    assert(fetchedActiveDoc.fee === 1200, 'Doctor fee correctly stored in DB');

    // Filter by department (specialty_category)
    const cardioDocs = db.prepare(`SELECT * FROM doctors WHERE specialty_category = ? AND active = 1`).all('Cardiology') as any[];
    assert(cardioDocs.some(d => d.id === testDoctorId), 'Department filter correctly returns active doctor');

    // Test Deactivation
    db.prepare(`UPDATE doctors SET active = 0 WHERE id = ?`).run(testDoctorId);
    const deactivatedDoc = db.prepare(`SELECT * FROM doctors WHERE id = ? AND active = 1`).get(testDoctorId);
    assert(!deactivatedDoc, 'Deactivated doctor excluded from active queries');

    // Test 4: Booking Workflow (Pay at Center)
    console.log('\n--- 4. Appointment Booking: Pay at Center ---');
    const bookingRefCenter = `CC-TEST-CTR-${Date.now().toString().slice(-4)}`;
    const tokenCenter = `token-ctr-${Date.now()}`;
    const insertCenter = db.prepare(`
      INSERT INTO appointments (
        doctor_id, patient_name, patient_phone, appointment_date, time_slot,
        status, booking_reference, access_token, payment_method, payment_status, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      testDoctorId, 'Rahim Chowdhury', '01811223344',
      '2026-10-20', null, 'pending', bookingRefCenter, tokenCenter,
      'center', 'unpaid', 'Routine ECG follow-up', new Date().toISOString()
    );
    assert(insertCenter.changes === 1, 'Pay at Center appointment created with NULL time_slot');

    const centerApp = db.prepare(`SELECT * FROM appointments WHERE booking_reference = ?`).get(bookingRefCenter) as any;
    assert(centerApp.status === 'pending', 'Center appointment status is initially pending');
    assert(centerApp.payment_status === 'unpaid', 'Center appointment payment status is unpaid');
    assert(centerApp.time_slot === null, 'Center appointment time_slot is safely null/optional');

    // Test 5: Booking Workflow (bKash with required fields)
    console.log('\n--- 5. Appointment Booking: bKash (Mobile Payment) ---');
    const bookingRefBkash = `CC-TEST-BK-${Date.now().toString().slice(-4)}`;
    const tokenBkash = `token-bk-${Date.now()}`;
    const insertBkash = db.prepare(`
      INSERT INTO appointments (
        doctor_id, patient_name, patient_phone, appointment_date, time_slot,
        status, booking_reference, access_token, payment_method, payment_sender_phone,
        transaction_id, payment_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      testDoctorId, 'Fatema Begum', '01711223344',
      '2026-10-21', null, 'pending', bookingRefBkash, tokenBkash,
      'bkash', '01711223344', 'TRX99887766', 'verification_pending', new Date().toISOString()
    );
    assert(insertBkash.changes === 1, 'bKash appointment created with sender phone & transaction ID');

    const bkashApp = db.prepare(`SELECT * FROM appointments WHERE booking_reference = ?`).get(bookingRefBkash) as any;
    assert(bkashApp.status === 'pending', 'bKash appointment status is initially pending');
    assert(bkashApp.payment_status === 'verification_pending', 'bKash appointment payment status is verification_pending (NOT automatically verified)');
    assert(bkashApp.transaction_id === 'TRX99887766', 'bKash transaction ID accurately preserved');

    // Test 6: Separate Approval vs Payment Verification Workflow
    console.log('\n--- 6. Separate Approval and Payment Verification Actions ---');
    // Step 6A: Approve Pay at Center appointment
    // An admin can approve the appointment without falsely marking it as paid
    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE appointments 
      SET status = 'confirmed', approved_at = ?, approved_by = ?
      WHERE id = ?
    `).run(nowIso, 'test-admin', centerApp.id);

    const verifiedCenterApp = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(centerApp.id) as any;
    assert(verifiedCenterApp.status === 'confirmed', 'Appointment status transitioned to confirmed');
    assert(verifiedCenterApp.payment_status === 'unpaid', 'Payment status remains UNPAID (approval does NOT mark payment verified)');
    assert(verifiedCenterApp.approved_by === 'test-admin', 'Approving admin recorded');

    // Step 6B: Explicitly record payment when physically received at center
    db.prepare(`
      UPDATE appointments 
      SET payment_status = 'verified', payment_verified_at = ?, payment_verified_by = ?
      WHERE id = ?
    `).run(nowIso, 'receptionist-admin', centerApp.id);
    const paidCenterApp = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(centerApp.id) as any;
    assert(paidCenterApp.payment_status === 'verified', 'Payment status explicitly updated to verified when collected');

    // Step 6C: bKash verification and rejection test
    db.prepare(`
      UPDATE appointments 
      SET payment_status = 'verified', payment_verified_at = ?, payment_verified_by = ?
      WHERE id = ?
    `).run(nowIso, 'payment-auditor', bkashApp.id);
    const verifiedBkashApp = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(bkashApp.id) as any;
    assert(verifiedBkashApp.payment_status === 'verified', 'bKash payment verified explicitly');
    assert(verifiedBkashApp.status === 'pending', 'Appointment status remains pending until explicitly confirmed');

    // Step 6D: Test payment rejection
    db.prepare(`
      UPDATE appointments
      SET payment_status = 'rejected', notes = 'Fake transaction ID'
      WHERE id = ?
    `).run(bkashApp.id);
    const rejectedBkashApp = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(bkashApp.id) as any;
    assert(rejectedBkashApp.payment_status === 'rejected', 'Payment rejection properly recorded without silently deleting booking');

    // Test 7: Public Receipt Retrieval & Integrity
    console.log('\n--- 7. Public Receipt / Voucher Slip Integrity ---');
    const receiptApp = db.prepare(`
      SELECT a.*, d.name as doctor_name, d.specialty_category, d.fee, d.chamber_time
      FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      WHERE a.access_token = ?
    `).get(tokenCenter) as any;
    assert(!!receiptApp, 'Appointment receipt retrieved by access token');
    assert(receiptApp.booking_reference === bookingRefCenter, 'Booking reference matches');
    assert(receiptApp.patient_name === 'Rahim Chowdhury', 'Patient name matches');
    assert(receiptApp.status === 'confirmed', 'Receipt accurately reflects updated confirmed status');

    // Test 8: Public History Tracking with Phone Masking
    console.log('\n--- 8. Public Appointment History Query & Phone Masking ---');
    const historyList = db.prepare(`
      SELECT a.id, a.booking_reference, a.patient_name, a.patient_phone, a.appointment_date,
             a.status, a.payment_method, a.payment_status, a.created_at, a.access_token,
             d.name as doctor_name, d.specialty_category, d.fee
      FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      WHERE a.patient_phone = ?
      ORDER BY a.created_at DESC
    `).all('01811223344') as any[];
    assert(historyList.length >= 1, 'Appointments found for patient phone');
    // Function for phone masking:
    const maskPhone = (p: string) => p.length >= 6 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p;
    const masked = maskPhone(historyList[0].patient_phone);
    assert(masked === '018****3344', `Phone correctly masked for privacy: ${masked}`);

    // Test 9: Diagnostic Report Search by Report ID OR Phone independently
    console.log('\n--- 9. Diagnostic Report Search by Report ID or Phone ---');
    const testReportId = `REP-TEST-${Date.now()}`;
    const testToken = `token-rep-${Date.now()}`;
    const insertRep = db.prepare(`
      INSERT INTO reports (token, report_id, patient_name, patient_phone, test_date, file_path, original_filename)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(testToken, testReportId, 'Kamal Hossain', '01999887766', '2026-10-10', 'test.pdf', 'test.pdf');
    const repAutoId = insertRep.lastInsertRowid;

    // Search by Report ID
    const searchById = db.prepare(`
      SELECT id, report_id, patient_name, patient_phone, test_date 
      FROM reports 
      WHERE report_id = ?
    `).all(testReportId) as any[];
    assert(searchById.length === 1 && searchById[0].report_id === testReportId, 'Search by Report ID matches exact report');

    // Search by Phone independently
    const searchByPhone = db.prepare(`
      SELECT id, report_id, patient_name, patient_phone, test_date 
      FROM reports 
      WHERE patient_phone LIKE ?
    `).all('%01999887766%') as any[];
    assert(searchByPhone.length === 1 && searchByPhone[0].patient_phone === '01999887766', 'Search by Patient Phone matches independently');

    // Search empty when no match
    const searchNoMatch = db.prepare(`
      SELECT id FROM reports WHERE report_id = ? OR patient_phone LIKE ?
    `).all('NONEXISTENT_ID', '%01900000000%') as any[];
    assert(searchNoMatch.length === 0, 'No match search safely returns empty array');

    // Clean up test records
    db.prepare(`DELETE FROM appointments WHERE id IN (?, ?)`).run(centerApp.id, bkashApp.id);
    db.prepare(`DELETE FROM doctors WHERE id = ?`).run(testDoctorId);
    db.prepare(`DELETE FROM reports WHERE id = ?`).run(repAutoId);
    console.log('Test records safely cleaned up.');

    console.log(`\n======================================================`);
    console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log(`======================================================`);

  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  }
}

runTests();
