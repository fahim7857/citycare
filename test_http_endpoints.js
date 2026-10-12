async function runHttpTests() {
  console.log('--- TESTING HTTP ENDPOINTS ON PORT 3055 ---');
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      console.log(`[PASS] ${msg}`);
      passed++;
    } else {
      console.error(`[FAIL] ${msg}`);
      failed++;
    }
  }

  const BASE = 'http://localhost:3055/citycare';

  try {
    // 1. Static HTML Pages
    const pages = [
      '',
      '/doctors.html',
      '/appointment.html',
      '/appointment-history.html',
      '/reports.html',
      '/contact.html',
      '/admin-login.html'
    ];

    for (const p of pages) {
      const res = await fetch(`${BASE}${p}`);
      assert(res.status === 200, `Page ${p || '/'} returned HTTP 200`);
    }

    // 2. Payment Config API
    const payConfigRes = await fetch(`${BASE}/api/payment-config`);
    assert(payConfigRes.status === 200, 'GET /api/payment-config returned 200');
    const payConfigJson = await payConfigRes.json();
    assert(payConfigJson.bkash && typeof payConfigJson.bkash === 'object', 'Payment config has bkash object');
    assert(!!payConfigJson.bkash.number, `bKash number exposed in config: ${payConfigJson.bkash.number}`);
    assert(payConfigJson.payAtCenter.enabled === true, 'Pay at Center enabled');

    // 3. Doctors API (dynamic from SQLite)
    const docsRes = await fetch(`${BASE}/api/doctors`);
    assert(docsRes.status === 200, 'GET /api/doctors returned 200');
    const docs = await docsRes.json();
    assert(Array.isArray(docs) && docs.length > 0, `GET /api/doctors returned ${docs.length} active doctors from SQLite`);
    const testDoc = docs[0];

    // 4. Booking API - Pay at Center
    const bookCenterRes = await fetch(`${BASE}/api/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientName: 'HTTP Test Center Patient',
        patientPhone: '01899112233',
        doctorId: testDoc.id,
        appointmentDate: '2026-10-25',
        paymentMethod: 'center',
        notes: 'Test note'
      })
    });
    assert(bookCenterRes.status === 200, 'POST /api/appointments (center) returned 200');
    const bookCenterJson = await bookCenterRes.json();
    assert(bookCenterJson.success === true, 'Booking center successful');
    assert(bookCenterJson.status === 'pending', 'Booking status is pending');
    assert(bookCenterJson.paymentStatus === 'unpaid', 'Payment status is unpaid');
    assert(!!bookCenterJson.bookingReference, `Generated booking reference: ${bookCenterJson.bookingReference}`);
    assert(!!bookCenterJson.accessToken, `Generated access token: ${bookCenterJson.accessToken}`);

    // 5. Booking API - Mobile payment validation (missing trxId)
    const bookBkashFailRes = await fetch(`${BASE}/api/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientName: 'HTTP Test Fail Patient',
        patientPhone: '01799112233',
        doctorId: testDoc.id,
        appointmentDate: '2026-10-25',
        paymentMethod: 'bkash',
        senderPhone: '01799112233'
        // transactionId omitted
      })
    });
    assert(bookBkashFailRes.status === 400, 'POST /api/appointments (bkash missing trxId) rejected with 400 Bad Request');

    // 6. Booking API - bKash with valid fields
    const bookBkashRes = await fetch(`${BASE}/api/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientName: 'HTTP Test bKash Patient',
        patientPhone: '01799112233',
        doctorId: testDoc.id,
        appointmentDate: '2026-10-26',
        paymentMethod: 'bkash',
        senderPhone: '01799112233',
        transactionId: 'TRX-HTTP-12345'
      })
    });
    assert(bookBkashRes.status === 200, 'POST /api/appointments (bkash) returned 200');
    const bookBkashJson = await bookBkashRes.json();
    assert(bookBkashJson.paymentStatus === 'verification_pending', 'Payment status is verification_pending (not auto verified)');

    // 7. Track Appointments
    const trackRes = await fetch(`${BASE}/api/appointments/track?phone=01899112233`);
    assert(trackRes.status === 200, 'GET /api/appointments/track returned 200');
    const trackJson = await trackRes.json();
    assert(trackJson.success === true && trackJson.appointments.length >= 1, 'Found booked appointment via phone search');
    assert(trackJson.appointments[0].patientPhoneMasked && trackJson.appointments[0].patientPhoneMasked.includes('****'), `Phone number properly masked in public tracking API: ${trackJson.appointments[0].patientPhoneMasked}`);

    // 8. Public Receipt Page
    const receiptRes = await fetch(`${BASE}/receipt/${bookCenterJson.accessToken}`);
    assert(receiptRes.status === 200, 'GET /receipt/:token returned 200 (printable voucher slip)');

    console.log(`\n======================================================`);
    console.log(`HTTP TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log(`======================================================`);

  } catch (err) {
    console.error('HTTP Test error:', err);
    failed++;
  }
}

runHttpTests();
