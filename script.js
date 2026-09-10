// script.js - Interactive controls for CityCare Diagnostic & Consultation Center

// Sample Data for PDF-style Digital Reports Demo
const DEMO_REPORTS = {
  "CC-9018": {
    patientName: "Kamrul Hasan",
    age: "42 Years",
    gender: "Male",
    date: "14-Jun-2026",
    referredBy: "Dr. M. A. Rahman (MBBS, FCPS)",
    reportId: "CC-9018",
    tests: [
      { name: "Hemoglobin (Hb)", result: "14.2", unit: "g/dL", range: "13.5 - 17.5", status: "Normal" },
      { name: "Fasting Blood Sugar (FBS)", result: "7.4", unit: "mmol/L", range: "3.9 - 6.1", status: "High" },
      { name: "HbA1c (Glycated Hemoglobin)", result: "6.8", unit: "%", range: "4.0 - 5.6", status: "High" },
      { name: "Total Cholesterol", result: "215", unit: "mg/dL", range: "Desirable < 200", status: "High" },
      { name: "LDL Cholesterol", result: "134", unit: "mg/dL", range: "Optimal < 100", status: "High" },
      { name: "Serum Creatinine", result: "0.9", unit: "mg/dL", range: "0.6 - 1.2", status: "Normal" }
    ],
    summary: "Asymptomatic borderline elevated glycemic profile (suspected Early Diabetes Mellitus). Fasting blood sugar and HbA1c are above typical normal limits. Mild hypercholesterolemia noted. Recommended dietary changes, daily walks, and consultation with Dr. M. A. Rahman."
  },
  "CC-4502": {
    patientName: "Fatima Akhtar",
    age: "29 Years",
    gender: "Female",
    date: "12-Jun-2026",
    referredBy: "Dr. Nusrat Jahan (MBBS, FCPS, MS)",
    reportId: "CC-4502",
    tests: [
      { name: "Hemoglobin (Hb)", result: "11.8", unit: "g/dL", range: "12.0 - 15.5", status: "Low" },
      { name: "TSH (Thyroid Stimulating Hormone)", result: "2.45", unit: "μIU/mL", range: "0.4 - 4.5", status: "Normal" },
      { name: "Free T4 (Thyroxine)", result: "1.12", unit: "ng/dL", range: "0.8 - 1.8", status: "Normal" },
      { name: "Platelet Count", result: "245,000", unit: "cumm", range: "150,000 - 450,000", status: "Normal" },
      { name: "ESR (Westergren)", result: "18", unit: "mm/1st hr", range: "0 - 20", status: "Normal" }
    ],
    summary: "Thyroid parameters (TSH, Free T4) are perfectly normal. Borderline low hemoglobin of 11.8 g/dL is present (mild iron deficiency anemia pattern). Recommended regular inclusion of green leafy vegetables and consultation for iron-rich options with Dr. Nusrat Jahan."
  }
};

document.addEventListener("DOMContentLoaded", () => {
  // Navigation & Page Switching Controls
  const navLinks = document.querySelectorAll(".nav-link");
  const mobileNavLinks = document.querySelectorAll(".mobile-nav-link");
  const pages = document.querySelectorAll(".page-section");
  const mobileMenu = document.getElementById("mobile-menu");
  const menuBtn = document.getElementById("menu-btn");
  const closeMenuBtn = document.getElementById("close-menu-btn");

  // Mobile Menu Toggle
  function toggleMobileMenu() {
    mobileMenu.classList.toggle("hidden");
  }

  if (menuBtn && closeMenuBtn && mobileMenu) {
    menuBtn.addEventListener("click", toggleMobileMenu);
    closeMenuBtn.addEventListener("click", toggleMobileMenu);
  }

  // Page switcher
  function showPage(pageId) {
    // Hide all pages
    pages.forEach(page => {
      page.classList.add("hidden");
    });

    // Show the active page
    const targetPage = document.getElementById(pageId);
    if (targetPage) {
      targetPage.classList.remove("hidden");
      window.scrollTo(0, 0);
    }

    // Update primary navigation active styles
    navLinks.forEach(link => {
      if (link.getAttribute("data-page") === pageId) {
        link.classList.add("text-sky-600", "border-b-2", "border-sky-600", "font-bold");
        link.classList.remove("text-slate-600", "hover:text-sky-600");
      } else {
        link.classList.remove("text-sky-600", "border-b-2", "border-sky-600", "font-bold");
        link.classList.add("text-slate-600", "hover:text-sky-600");
      }
    });

    // Close mobile menu if active
    if (mobileMenu && !mobileMenu.classList.contains("hidden")) {
      mobileMenu.classList.add("hidden");
    }
  }

  // Setup click listeners for desktop nav links
  navLinks.forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const pageId = link.getAttribute("data-page");
      showPage(pageId);
    });
  });

  // Setup click listeners for mobile nav links
  mobileNavLinks.forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const pageId = link.getAttribute("data-page");
      showPage(pageId);
    });
  });

  // Expose showPage globally so we can trigger navigation from HTML onclick attributes easily
  window.navigateToPage = function(pageId, preFillValue = null, preFillType = null) {
    showPage(pageId);
    
    if (preFillValue && pageId === "appointment-page") {
      const selectElement = document.getElementById("book-selection");
      if (selectElement) {
        // Find matching option (case insensitive match)
        for (let i = 0; i < selectElement.options.length; i++) {
          const option = selectElement.options[i];
          if (option.text.toLowerCase().includes(preFillValue.toLowerCase()) || 
              option.value.toLowerCase().includes(preFillValue.toLowerCase())) {
            selectElement.selectedIndex = i;
            break;
          }
        }
      }
    }
  };

  // Appointment Booking Form Submission Handling
  const appointmentForm = document.getElementById("appointment-form");
  const appointmentSuccess = document.getElementById("appointment-success");
  const appointmentReceiptBox = document.getElementById("appointment-receipt");

  if (appointmentForm && appointmentSuccess) {
    appointmentForm.addEventListener("submit", (e) => {
      e.preventDefault();

      const name = document.getElementById("book-name").value.trim();
      const phone = document.getElementById("book-phone").value.trim();
      const selection = document.getElementById("book-selection").value;
      const date = document.getElementById("book-date").value;
      const time = document.getElementById("book-time").value;

      if (!name || !phone || !selection || !date) {
        alert("অনুগ্রহ করে সব তথ্য দিন।");
        return;
      }

      // Generate a dynamic booking ID
      const bookingPrefix = "CC-APP-";
      const randomNumber = Math.floor(1000 + Math.random() * 9000);
      const bookingId = bookingPrefix + randomNumber;

      // Render details in the success voucher
      document.getElementById("v-id").textContent = bookingId;
      document.getElementById("v-name").textContent = name;
      document.getElementById("v-phone").textContent = phone;
      document.getElementById("v-service").textContent = selection;
      document.getElementById("v-date").textContent = date;
      document.getElementById("v-time").textContent = time || "১০:০০ AM - ১২:০০ PM (সাধারণ স্লট)";

      // Reset form controls
      appointmentForm.reset();

      // Show success voucher
      appointmentSuccess.classList.remove("hidden");
      appointmentForm.classList.add("hidden");

      // Setup dynamic WhatsApp submit query button
      const watsappSubmitBtn = document.getElementById("whatsapp-submit-btn");
      if (watsappSubmitBtn) {
        const textMessage = `হ্যালো সিটি কেয়ার, আমি একটি অ্যাপয়েন্টমেন্ট বুক করেছি।
বুকিং তথ্য নিচে দেওয়া হলো:
বুকিং আইডি: ${bookingId}
নাম: ${name}
ফোন নম্বর: ${phone}
ডাক্তার/পরীক্ষা: ${selection}
তারিখ: ${date}
সময়: ${time || "১০:০০ AM - ১২:০০ PM"}
অনুগ্রহ করে এটি নিশ্চিত করুন। ধন্যবাদ!`;

        const encodedMessage = encodeURIComponent(textMessage);
        // Bangladesh context hospital support line (using dummy real country code format)
        watsappSubmitBtn.href = `https://wa.me/8801789555666?text=${encodedMessage}`;
      }
    });
  }

  // Function to book again (resets the booking panel)
  window.resetBookingForm = function() {
    if (appointmentForm && appointmentSuccess) {
      appointmentSuccess.classList.add("hidden");
      appointmentForm.classList.remove("hidden");
    }
  };

  // Report Search Mechanism
  const reportForm = document.getElementById("report-search-form");
  const reportLoader = document.getElementById("report-loader");
  const reportNotFound = document.getElementById("report-not-found");
  const reportDetailsBox = document.getElementById("report-details-box");

  if (reportForm) {
    reportForm.addEventListener("submit", (e) => {
      e.preventDefault();

      const phone = document.getElementById("report-phone").value.trim();
      const reportId = document.getElementById("report-id").value.trim().toUpperCase();

      if (!phone || !reportId) {
        alert("অনুগ্রহ করে মোবাইল নম্বর এবং রিপোর্ট আইডি দিন।");
        return;
      }

      // Reset states
      reportNotFound.classList.add("hidden");
      reportDetailsBox.classList.add("hidden");
      reportLoader.classList.remove("hidden");

      // Simulate a small, nice loader
      setTimeout(() => {
        reportLoader.classList.add("hidden");

        const matchedReport = DEMO_REPORTS[reportId];

        if (matchedReport) {
          // Fill details
          document.getElementById("rep-patient-name").textContent = matchedReport.patientName;
          document.getElementById("rep-age-gender").textContent = `${matchedReport.age} / ${matchedReport.gender}`;
          document.getElementById("rep-date").textContent = matchedReport.date;
          document.getElementById("rep-id-text").textContent = matchedReport.reportId;
          document.getElementById("rep-referred").textContent = matchedReport.referredBy;
          document.getElementById("rep-summary").textContent = matchedReport.summary;

          // Render tests rows inside table
          const testsBody = document.getElementById("rep-tests-body");
          testsBody.innerHTML = "";

          matchedReport.tests.forEach(test => {
            const row = document.createElement("tr");
            row.className = "border-b border-slate-100 hover:bg-slate-50";

            let refBadgeColor = "text-emerald-700 bg-emerald-50";
            if (test.status === "High") {
              refBadgeColor = "text-rose-700 bg-rose-50 font-bold";
            } else if (test.status === "Low") {
              refBadgeColor = "text-amber-700 bg-amber-50 font-bold";
            }

            row.innerHTML = `
              <td class="py-3 px-4 text-sm font-medium text-slate-800">${test.name}</td>
              <td class="py-3 px-4 text-sm text-slate-800 font-semibold text-center">${test.result}</td>
              <td class="py-3 px-4 text-sm text-slate-500 text-center">${test.unit}</td>
              <td class="py-3 px-4 text-sm text-slate-500 text-center">${test.range}</td>
              <td class="py-3 px-4 text-center">
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${refBadgeColor}">
                  ${test.status}
                </span>
              </td>
            `;
            testsBody.appendChild(row);
          });

          // Show report block
          reportDetailsBox.classList.remove("hidden");
          // Scroll smoothly to report details
          reportDetailsBox.scrollIntoView({ behavior: "smooth" });

        } else {
          // Show error
          reportNotFound.classList.remove("hidden");
        }
      }, 750);
    });
  }

  // Print Report Handler
  window.printDiagnosticReport = function() {
    window.print();
  };

  // Lead feedback support form on Contact Page
  const contactForm = document.getElementById("contact-feedback-form");
  const contactSuccess = document.getElementById("contact-success-banner");

  if (contactForm && contactSuccess) {
    contactForm.addEventListener("submit", (e) => {
      e.preventDefault();
      
      // Reset form and show success
      contactForm.reset();
      contactSuccess.classList.remove("hidden");
      setTimeout(() => {
        contactSuccess.classList.add("hidden");
      }, 5000);
    });
  }

  // Initialize standard date limits for appointment form (min date = today)
  const bookDateInput = document.getElementById("book-date");
  if (bookDateInput) {
    const today = new Date().toISOString().split("T")[0];
    bookDateInput.min = today;
    bookDateInput.value = today;
  }
});
