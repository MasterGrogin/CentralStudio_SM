const CONFIG = {
  SHEET_ID: '1LGDQdKhiiGAxpnn_YkQJgZefhJQD5rkwffWdeZTO2Pg',
  BOOKINGS_TAB: 'bookings',
  INQUIRY_TAB: 'inquiry',
  HISTORICAL_TAB: 'historical',
  // Drive folder that all check-in photo subfolders get created inside.
  // Create/designate this folder in Drive (owned by whoever deploys this
  // script), copy its ID out of the folder's URL, and paste it here — see
  // manual.html#checkin for the full setup checklist.
  CHECKIN_PARENT_FOLDER_ID: '1h1CEAKVJEdzIKUg9_hviLD6EzPGN3S1U',
  // Where the "customer finished uploading ID/card photos" notification goes.
  CHECKIN_NOTIFY_EMAIL: 'info@centralstudioalbany.com',
};

// One-time manual step: in the Apps Script editor, select this function in
// the function dropdown and click Run, then approve the permissions prompt
// (Review permissions -> your account -> Advanced -> Go to project (unsafe)
// -> Allow). The waiver PDF feature calls DocumentApp, a scope this project
// didn't need before, and the deploying account has to explicitly grant it
// once before the live web app can use it for anyone (staff or customers).
// Safe to re-run — it just creates and immediately deletes a throwaway Doc.
function authorizeDocumentAppScope() {
  const doc = DocumentApp.create('auth-check-delete-me');
  DriveApp.getFileById(doc.getId()).setTrashed(true);
}

// Same one-time-run-in-editor deal as authorizeDocumentAppScope above, but
// for MailApp — apparently each newly-used Apps Script service needs its own
// explicit run-and-approve, not just one project-wide grant. This one also
// doubles as a real test: if CONFIG.CHECKIN_NOTIFY_EMAIL receives this,
// that confirms both the scope is granted AND mail from this script isn't
// getting caught by that inbox's spam filter.
function authorizeMailScope() {
  MailApp.sendEmail(
    CONFIG.CHECKIN_NOTIFY_EMAIL,
    'Central Studio — authorization test',
    'This is a one-time test email confirming Apps Script can send mail from this project. Safe to ignore.'
  );
}

// JSON API. Front end lives as static HTML/CSS/JS hosted on Ionos and calls this
// via fetch(): GET ?action=getData for reads, POST with a JSON body for writes.

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = e.parameter.action;
  try {
    if (action === 'getData') {
      return jsonOutput_({ ok: true, data: getDashboardData() });
    }
    if (action === 'getRevenue') {
      return jsonOutput_({ ok: true, data: getRevenueStats() });
    }
    if (action === 'getStudioHealth') {
      return jsonOutput_({ ok: true, data: getStudioHealth() });
    }
    return jsonOutput_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOutput_({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'toggleBookingCalled') {
      return jsonOutput_({ ok: true, data: toggleBookingCalled(body.row, body.value) });
    }
    if (body.action === 'completeBooking') {
      return jsonOutput_({ ok: true, data: completeBooking(body.row, body.amount) });
    }
    if (body.action === 'updateInquiry') {
      return jsonOutput_({ ok: true, data: updateInquiry(body.row, body.note, body.close) });
    }
    if (body.action === 'applyChrisPayment') {
      return jsonOutput_({ ok: true, data: applyChrisSessionPayment() });
    }
    if (body.action === 'uploadCheckinPhoto') {
      return jsonOutput_({ ok: true, data: uploadCheckinPhoto(body.row, body.photoType, body.mimeType, body.dataBase64) });
    }
    if (body.action === 'submitCheckinWaiver') {
      return jsonOutput_({ ok: true, data: submitCheckinWaiver(body) });
    }
    return jsonOutput_({ ok: false, error: 'Unknown action: ' + body.action });
  } catch (err) {
    return jsonOutput_({ ok: false, error: err.message });
  }
}

function getSheet_(tabName) {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  return sheet;
}

// Reads a tab into an array of objects keyed by header name (not column position),
// so reordering columns in the sheet won't break this.
function readRows_(tabName) {
  const sheet = getSheet_(tabName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 1) return [];
  const headers = values[0];
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const rowValues = values[r];
    if (rowValues.every(v => v === '')) continue;
    const obj = { _row: r + 1 };
    headers.forEach((h, i) => {
      if (h) obj[h] = rowValues[i];
    });
    rows.push(obj);
  }
  return rows;
}

function fullName_(row) {
  return (row['Invitee Name'] || '').toString().trim() || '(no name)';
}

function isDate_(val) {
  return !!val && typeof val.getTime === 'function' && Object.prototype.toString.call(val) === '[object Date]';
}

function parseDateValue_(val) {
  if (isDate_(val)) return val;
  if (!val) return null;
  const parsed = new Date(val);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Event Date holds a full date+time value (no separate Event Time column).
function parseEventDateTime_(row) {
  return parseDateValue_(row['Event Date']);
}

function formatDate_(val, pattern) {
  if (isDate_(val)) return Utilities.formatDate(val, Session.getScriptTimeZone(), pattern);
  return val || '';
}

// Chris pre-pays a flat rate at booking time (see the calendar-sync script),
// so his rows get Total Paid filled in immediately instead of waiting for a
// manual "Complete & Close." For everyone else that would hide the booking
// right away — for Chris specifically we keep it visible in Vetted Upcoming
// Rentals until the event date passes, then let it drop off like normal.
const CHRIS_AUTO_SYNC_EMAIL = 'chris@chrisconnellyphotography.com';

// Chris doesn't pay per session — he settles up in blocks of 25, invoiced
// roughly when the unpaid count hits 15 (see manual.html#chris-payments).
// "Total Paid" stays hardcoded to $150/session at sync time (that's revenue
// bookkeeping); this column is the separate, real record of when a block was
// actually paid. Must exist as a header on the bookings tab — see
// setupChrisPaymentColumn().
const CHRIS_PAID_DATE_COL = 'Session Paid Date';
const CHRIS_SESSIONS_PER_BLOCK = 25;

function getDashboardData() {
  const bookings = readRows_(CONFIG.BOOKINGS_TAB);
  const inquiries = readRows_(CONFIG.INQUIRY_TAB);

  // Regular-customer detection: count bookings per email across full history.
  const emailCounts = {};
  bookings.forEach(b => {
    const email = (b['Invitee Email'] || '').toString().trim().toLowerCase();
    if (!email) return;
    emailCounts[email] = (emailCounts[email] || 0) + 1;
  });

  // Regulars don't need ID/card re-collected every visit — surface the most
  // recent completed check-in for this email across ALL their bookings (not
  // just this one) so staff can see it's already on file and skip re-shooting it.
  const lastCheckinByEmail = {};
  bookings.forEach(b => {
    const email = (b['Invitee Email'] || '').toString().trim().toLowerCase();
    const completedDate = parseDateValue_(b[CHECKIN_COMPLETED_COL]);
    if (!email || !completedDate) return;
    if (!lastCheckinByEmail[email] || completedDate.getTime() > lastCheckinByEmail[email].getTime()) {
      lastCheckinByEmail[email] = completedDate;
    }
  });

  const activeBookings = bookings.filter(b => {
    const status = (b['Booking Status'] || '').toString().toLowerCase();
    return status.indexOf('cancel') === -1;
  });

  const enriched = activeBookings.map(b => {
    const email = (b['Invitee Email'] || '').toString().trim().toLowerCase();
    const eventDateTime = parseEventDateTime_(b);
    return {
      row: b._row,
      name: fullName_(b),
      email: b['Invitee Email'] || '',
      phone: b['Phone'] || '',
      dateBooked: formatDate_(b['Date Booked'], 'MMM d, yyyy'),
      eventType: b['Event Type'] || '',
      eventDate: formatDate_(b['Event Date'], 'EEE, MMM d, yyyy'),
      eventTime: formatDate_(b['Event Date'], 'h:mm a'),
      eventTimestamp: eventDateTime ? eventDateTime.getTime() : Number.MAX_SAFE_INTEGER,
      amountPaid: b['Amount Paid'] || '',
      paymentTerms: b['Payment Terms'] || '',
      groupOver8: b['Group Over 8'] || '',
      typeOfWork: b['Type of Work'] || '',
      lighting: b['Lighting Equipment'] || '',
      needsHousePhotographer: b['Needs House Photographer'] || '',
      beenToStudioBefore: b['Been to Studio Before'] || '',
      firstTimeRenting: b['First Time Renting'] || '',
      totalPriceQuoted: b['Total Price Quoted'] || '',
      anythingToKnow: b['Anything We Need to Know'] || '',
      notes: b['Notes'] || '',
      called: !!b['Date Called'],
      dateCalled: formatDate_(b['Date Called'], 'MMM d, yyyy'),
      completed: !!b['Total Paid'],
      finalPayment: b['Total Paid'] || '',
      isRegular: email ? emailCounts[email] > 1 : false,
      bookingsCount: email ? emailCounts[email] : 1,
      lastCheckinDate: email && lastCheckinByEmail[email]
        ? formatDate_(lastCheckinByEmail[email], 'MMM d, yyyy')
        : '',
    };
  });

  enriched.sort((a, b) => a.eventTimestamp - b.eventTimestamp);

  // Bookings only leave the dashboard when explicitly marked complete (Total Paid entered) —
  // a past event date alone does not hide them, since past bookings may still need calling/closing.
  // Exception: Chris's auto-synced rows are pre-marked complete at booking time, so for those
  // specifically, still show them until their event date passes rather than immediately.
  const now = Date.now();
  const activeEnriched = enriched.filter(b => {
    if (!b.completed) return true;
    const isChrisAutoSync = b.email.toString().trim().toLowerCase() === CHRIS_AUTO_SYNC_EMAIL;
    return isChrisAutoSync && b.eventTimestamp > now;
  });
  const needsCall = activeEnriched.filter(b => !b.called);
  const vettedUpcoming = activeEnriched.filter(b => b.called);

  const enrichedInquiries = inquiries.map(i => ({
    row: i._row,
    name: i['data__Name'] || '',
    phone: i['data__Phone Number'] || '',
    email: i['data__Email'] || '',
    desiredRentalDate: formatDate_(i['data__Desired Rental Date'], 'EEE, MMM d, yyyy'),
    description: i['data__Project Description'] || '',
    dateReceived: formatDate_(i['Submitted At'], 'MMM d, yyyy'),
    contacted: !!i['Date Contacted'],
    dateContacted: formatDate_(i['Date Contacted'], 'MMM d, yyyy'),
    notes: i['Notes'] || '',
    lastContactAttempt: !!i['Last Contact Attempt'],
    lastContactAttemptDate: formatDate_(i['Last Contact Attempt'], 'MMM d, yyyy'),
  }));

  const openInquiries = enrichedInquiries.filter(i => !i.contacted);

  return {
    needsCall: needsCall,
    vettedUpcoming: vettedUpcoming,
    openInquiries: openInquiries,
    chrisPaymentStatus: getChrisPaymentStatus_(),
    generatedAt: formatDate_(new Date(), 'EEE, MMM d, yyyy h:mm a'),
  };
}

function toggleBookingCalled(rowNumber, shouldBeCalled) {
  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = headers.indexOf('Date Called') + 1;
  if (col === 0) throw new Error('Date Called column not found');
  sheet.getRange(rowNumber, col).setValue(shouldBeCalled ? new Date() : '');
  return getDashboardData();
}

// Recording a final payment amount is what marks a booking done — it then drops
// off the dashboard entirely (both Needs a Call and Vetted Upcoming Rentals).
function completeBooking(rowNumber, finalPaymentAmount) {
  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = headers.indexOf('Total Paid') + 1;
  if (col === 0) throw new Error('Total Paid column not found');
  sheet.getRange(rowNumber, col).setValue(finalPaymentAmount);
  return getDashboardData();
}

// Logs an optional note (appended, timestamped, so repeat follow-up attempts build
// a history instead of overwriting each other) and optionally closes the inquiry.
function updateInquiry(rowNumber, note, close) {
  const sheet = getSheet_(CONFIG.INQUIRY_TAB);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  const attemptCol = headers.indexOf('Last Contact Attempt') + 1;
  if (attemptCol === 0) throw new Error('Last Contact Attempt column not found');
  sheet.getRange(rowNumber, attemptCol).setValue(new Date());

  if (note) {
    const notesCol = headers.indexOf('Notes') + 1;
    if (notesCol === 0) throw new Error('Notes column not found');
    const existing = sheet.getRange(rowNumber, notesCol).getValue();
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, yyyy h:mm a');
    const entry = stamp + ' — ' + note;
    sheet.getRange(rowNumber, notesCol).setValue(existing ? (existing + '\n' + entry) : entry);
  }

  if (close) {
    const contactedCol = headers.indexOf('Date Contacted') + 1;
    if (contactedCol === 0) throw new Error('Date Contacted column not found');
    sheet.getRange(rowNumber, contactedCol).setValue(new Date());
  }

  return getDashboardData();
}

// Header that stores the Drive folder ID created for a booking's check-in
// photos. Must exist as a header on the bookings tab — see
// setupCheckinFolderColumn(). Storing the ID directly (rather than matching
// on folder name) is what makes re-running check-in for the same booking
// reuse the same folder instead of risking a name collision with another
// booking that shares a renter name and date.
const CHECKIN_FOLDER_COL = 'Checkin Folder ID';

// Stamped once all four check-in photos finish uploading for a booking. Used
// to surface "ID/card already on file as of <date>" for regulars — see
// lastCheckinByEmail in getDashboardData(). Must exist as a header on the
// bookings tab — see setupCheckinCompletedColumn().
const CHECKIN_COMPLETED_COL = 'Checkin Completed Date';

const CHECKIN_PHOTO_FILENAMES = {
  idFront: 'id-front.jpg',
  idBack: 'id-back.jpg',
  cardFront: 'card-front.jpg',
  cardBack: 'card-back.jpg',
};

// Group rentals can capture more than one ID — the check-in page's "Add
// Another ID" button sends additional photoTypes as idFront_2/idBack_2,
// idFront_3/idBack_3, etc. Falls back to the fixed map above for the
// original (unnumbered) four tiles.
function checkinPhotoFilename_(photoType) {
  if (CHECKIN_PHOTO_FILENAMES[photoType]) return CHECKIN_PHOTO_FILENAMES[photoType];
  const match = /^(idFront|idBack)_(\d+)$/.exec(photoType);
  if (!match) return null;
  const side = match[1] === 'idFront' ? 'front' : 'back';
  return 'id-' + side + '-' + match[2] + '.jpg';
}

// Returns the Drive folder for this booking's check-in photos, creating it
// (and recording its ID back on the row) the first time. Safe to call
// repeatedly for the same row — later calls just reuse the stored ID.
function getOrCreateCheckinFolder_(rowNumber) {
  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const folderCol = headers.indexOf(CHECKIN_FOLDER_COL) + 1;
  if (folderCol === 0) throw new Error(CHECKIN_FOLDER_COL + ' column not found — run setupCheckinFolderColumn() once from the Apps Script editor.');

  const existingId = sheet.getRange(rowNumber, folderCol).getValue();
  if (existingId) {
    try {
      return DriveApp.getFolderById(existingId);
    } catch (err) {
      // Folder was deleted/moved out of reach since we recorded it — fall
      // through and create a fresh one rather than failing check-in.
    }
  }

  const rowValues = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
  const rowObj = {};
  headers.forEach((h, i) => { if (h) rowObj[h] = rowValues[i]; });

  const name = fullName_(rowObj);
  const eventDateTime = parseEventDateTime_(rowObj);
  const dateLabel = eventDateTime
    ? Utilities.formatDate(eventDateTime, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : 'no-date';
  const folderName = dateLabel + ' - ' + name;

  const parent = DriveApp.getFolderById(CONFIG.CHECKIN_PARENT_FOLDER_ID);
  const folder = parent.createFolder(folderName);
  sheet.getRange(rowNumber, folderCol).setValue(folder.getId());
  return folder;
}

// Saves one check-in photo into the booking's Drive folder. Overwrites
// (trashes) any prior file of the same name first, so retaking a photo
// during the same check-in — or re-running check-in later — doesn't leave
// duplicate files behind.
function uploadCheckinPhoto(rowNumber, photoType, mimeType, dataBase64) {
  const filename = checkinPhotoFilename_(photoType);
  if (!filename) throw new Error('Unknown photo type: ' + photoType);

  const folder = getOrCreateCheckinFolder_(rowNumber);

  const existing = folder.getFilesByName(filename);
  while (existing.hasNext()) existing.next().setTrashed(true);

  const blob = Utilities.newBlob(Utilities.base64Decode(dataBase64), mimeType || 'image/jpeg', filename);
  const file = folder.createFile(blob);

  return { fileName: filename, fileId: file.getId(), folderId: folder.getId() };
}

// One-time setup utility — run manually from the Apps Script editor (Run >
// setupCheckinFolderColumn). Adds the "Checkin Folder ID" header to the
// bookings tab if it isn't already there. Safe to re-run — a no-op once the
// column exists.
function setupCheckinFolderColumn() {
  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf(CHECKIN_FOLDER_COL) !== -1) return;
  sheet.getRange(1, lastCol + 1).setValue(CHECKIN_FOLDER_COL);
}

// One-time setup utility — run manually from the Apps Script editor (Run >
// setupCheckinCompletedColumn). Adds the "Checkin Completed Date" header to
// the bookings tab if it isn't already there. Safe to re-run — a no-op once
// the column exists.
function setupCheckinCompletedColumn() {
  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf(CHECKIN_COMPLETED_COL) !== -1) return;
  sheet.getRange(1, lastCol + 1).setValue(CHECKIN_COMPLETED_COL);
}

const WAIVER_REQUIRED_KEYS_ = ['name', 'address', 'city', 'state', 'zip', 'phone', 'email'];

// Full text of "Central Studio Agreement and Waiver (v4)", broken into
// sections for rendering into the signed PDF (see buildWaiverPdf_). The
// customer-facing copy in web/checkin.html must be kept in sync by hand if
// the underlying agreement (the .docx in the repo root) ever changes.
const WAIVER_TEXT_AGREEMENT_ = [
  {
    heading: 'General Information',
    paragraphs: [
      'The Central Studio Rental Agreement and Waiver of Liability sets out the terms of the arrangement between you, the client, and Central Studio. This agreement sets out the amount of rental, any required deposit, the hours and length of studio rental use, and a waiver of liability clause.',
      'Please read and sign these forms prior to studio usage, as they set out the rental terms and the studio\'s liability limitations in the event of accidents or injuries while the studio is being rented.'
    ]
  },
  {
    heading: 'Requirements',
    paragraphs: [
      'Renter must be 18 years of age or older.',
      'No one under 18 years of age is allowed in the studio without a parent or legal guardian.',
      'Renter must provide a valid US-issued photo ID at check-in.',
      'Renter must provide a valid credit card for incidentals at check-in.'
    ]
  },
  {
    heading: 'Rental Agreement',
    paragraphs: [
      'Additional Services — Pre-Set Add-On for Photography Package: lights, background, and props can be preset to a certain setup for the client before arrival so they can arrive and be ready to shoot. Cost: $50.',
      'Additional Services — Technical Assistance: have our staff on hand to assist with the shoot, manage equipment, set/adjust lights and camera settings, consult, etc. Cost: $30/hr.',
      'Classes/Seminars/Workshops/Meet-ups/etc.: rentals for the purpose of group gathering for educational, training, teaching, or meet-up events will be subject to special rates. Please contact the studio with your request and we will build a package for you. The above rates are not valid for these types of rentals.',
      'Deposit: a deposit is required to secure the dates and times requested and will be applied toward the final balance due. No dates will be held without a signed contract and deposit.',
      'Length of Use: rental periods are pre-arranged with Central Studio. Time includes set-up and break-down. The studio must be cleaned and vacated by the end of the rental period. No prior drop-off and/or pick-up after completion of the shoot, of equipment, props, etc. unless negotiated at the time of the rental contract.',
      'Cancellations: cancellations of confirmed bookings will result in the following charges — 72 hours or more prior to the rental date, the deposit can be applied toward a rescheduled date within 2 weeks; less than 72 hours, no refunds. Central Studio is not liable for acts out of its control that affect the shoot, such as equipment failures, power outages, weather, acts of God, or emergencies. In such cases, Central Studio will refund the client any unused rental hours.',
      'Cyclorama Wall: the wall curve is not for climbing, running, or walking; any damage that occurs due to improper use is the renter\'s responsibility, with a repair fee of up to $1,000. Heavy markings or scratching of the white cyclorama floor and wall is subject to a $150 repainting fee. Even though all efforts are made to provide a clean cyclorama (cyc), the cyc wall comes as-is. Clients can request a fresh coat of paint up to 72 hours before rental at a cost of $150.',
      'Damage / Cleanup: the client will leave the studio clean and neat, just as they found it — furniture put back, all lights, sound system, and equipment turned off. If not, a minimum $50 cleaning fee will be applied.',
      'Renter also agrees that if any equipment, furniture, fixtures, etc. are mishandled, broken, ruined, or stolen during their rental period, they will be responsible for replacing the items (with equivalent or better) or paying for repair/replacement costs. Client agrees to notify Central Studio immediately of any malfunction, damage, or other issues with the equipment. The client is advised to bring a cell phone. Wi-Fi internet service is available during the rental period. All modeling lights and receivers are to be turned off when not in use.',
      'Central Studio will dispose of trash collected in the supplied trash cans. The client must discard larger items, such as personal props and set pieces. All items brought to the premises by the client are to be removed by the client. Items left after 7 days will be assumed abandoned and may be discarded or kept by Central Studio, with no compensation due to the client, at the discretion of Central Studio.'
    ]
  },
  {
    heading: 'Studio Rules',
    paragraphs: [
      'No smoking whatsoever is allowed in the building.',
      'No alcoholic beverages or non-prescription or illegal drugs allowed on the premises.',
      'Music/voices are to be kept at reasonable levels and must not contain vulgar or offensive lyrics or words.',
      'No one who is drunk or under the influence of illegal substances will be admitted.',
      'No pets allowed without prior consent of Central Studio.',
      'Maximum of eight people in the client\'s party — ask ahead if you will have a larger group.',
      'This is a shared studio and we maintain a professional environment. The client shall be solely responsible for the conduct and welfare of all persons accompanying the client while on Central Studio\'s property. The client agrees that a Central Studio representative may, at Central Studio\'s discretion, be present at all times. If the representative observes or otherwise becomes aware of dangerous, pornographic, illegal, or negligent practices or activities, the representative reserves the right to stop the shoot and may require the client and client\'s party to leave immediately. The authorities will be alerted to any illegal activities witnessed by the Central Studio representative. In such case, no refund will be given for unused time. However, Central Studio and representatives assume no responsibility to act in such cases.',
      'It is the renter\'s responsibility to notify and make aware any clients, models, or guests as to the presence of active security cameras.'
    ]
  },
  {
    heading: 'Miscellaneous',
    paragraphs: [
      'The client shall comply in all respects with all federal, state, county, city, or other local laws, regulations, and ordinances and all rules and regulations of any governmental authority, in connection with this agreement. This agreement incorporates the entire understanding and agreement between the client and Central Studio. Any modifications of this agreement must be in writing and signed by both parties. Any waiver of a breach or default hereunder shall not be deemed a waiver of a subsequent breach or default of either the same provision or any other provision of this agreement. The laws of the State of New York shall govern this agreement. Any signatures constitute a legal and binding agreement between the client and Central Studio.'
    ]
  }
];

const WAIVER_TEXT_LIABILITY_ = [
  {
    heading: 'Waiver of Liability',
    paragraphs: [
      'Central Studio rents its studio, including agreed-upon equipment, to its clients with the understanding that in no event shall Central Studio, its owners, agents, employees, affiliated independent contractors, management, bookers, or any other related personnel, the company and any of its subsidiaries be held liable for direct, indirect, incidental, or consequential damage due to the use of this building, facility, or equipment used by its clients.',
      'You agree to release Central Studio, its owners, agents, employees, affiliated independent contractors, management, bookers, or any other related personnel, the company and any of its subsidiaries of any and all liability for any injuries, whether physical or mental, while in participation of, working and/or shooting in the studios, or any other activity in conjunction with this space, or situations that you encounter while renting the studio space.',
      'You agree not to sue or file suit against Central Studio, its owners, agents, employees, affiliated independent contractors, management, bookers, or any other related personnel, the company and any of its subsidiaries for claims arising out of said participation and/or photo or video shoots while in participation of, working and/or shooting in the studios.',
      'You waive Central Studio of any liabilities arising out of the use of the studio. Central Studio will not be held liable for any injuries, accidents, loss, or damage that occurs in the studio or on the building premises. It is your responsibility as the renter to carry liability insurance. We may require a copy of the renter\'s certificate of insurance with Central Studio added as an additional insured with respect to operations of the named insured and added as a loss payee "as their interests may appear." It must include a 30-day cancellation clause and proof of risk replacement cost.',
      'Central Studio will only be liable for the amount of your paid fees if your shoot is delayed or cancelled as a result of a situation that arises in or on the building premises that is out of our control.',
      'Central Studio expressly prohibits any illegal activity on its premises during the course of any rental.',
      'You waive and hold harmless Central Studio from any incidents or accidents which may occur to or by persons either renting or associated with the renting of the studio facilities located at 1095 Central Avenue, Albany NY on the date(s) noted.',
      'You agree to be solely responsible for the conduct and welfare of all persons accompanying you while on our premises.',
      'You agree that someone representing Central Studio may be present in the building or studio at the times you are using it.',
      'You agree that Central Studio has multiple active security cameras operating at all times which are visible by management.',
      'You agree that Central Studio is a Smoke-Free facility and you and all persons accompanying you will refrain from the use of chemical cleaners or agents, or products which contain strong odors. Violation of this policy will result in an hourly charge of $25 per hour for each hour the studio cannot be used while airing out, as well as any clean-up costs.',
      'You agree to the terms above and agree to make your representatives responsible for these terms.'
    ]
  }
];

// Called once a customer (or front desk, on their behalf) finishes the
// digital Rental Agreement & Waiver of Liability at check-in — the frontend
// only enables this once all photo tiles have uploaded and every required
// field + the signature pad are filled in, but required fields are checked
// again here since nothing stops a direct API call from skipping the UI.
// Renders the full agreement with the client's info and signature into a
// PDF, saves it alongside the ID/card photos, stamps the row, and emails
// the studio.
function submitCheckinWaiver(body) {
  const rowNumber = body.row;
  WAIVER_REQUIRED_KEYS_.forEach(function (key) {
    if (!body[key] || !String(body[key]).trim()) throw new Error('Missing required field: ' + key);
  });
  if (!body.agreementSignatureBase64) throw new Error('Missing Rental Agreement signature');
  if (!body.waiverSignatureBase64) throw new Error('Missing Waiver of Liability signature');

  const folder = getOrCreateCheckinFolder_(rowNumber);

  const agreementSigBlob = saveSignatureFile_(folder, 'rental-agreement-signature.png', body.agreementSignatureBase64);
  const waiverSigBlob = saveSignatureFile_(folder, 'waiver-of-liability-signature.png', body.waiverSignatureBase64);

  const pdfFile = buildWaiverPdf_(folder, body, agreementSigBlob, waiverSigBlob);

  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const col = headers.indexOf(CHECKIN_COMPLETED_COL) + 1;
  if (col === 0) throw new Error(CHECKIN_COMPLETED_COL + ' column not found — run setupCheckinCompletedColumn() once from the Apps Script editor.');
  sheet.getRange(rowNumber, col).setValue(new Date());

  notifyCheckinComplete_(rowNumber, sheet, headers, lastCol, pdfFile, folder);

  return { row: rowNumber, waiverPdfUrl: pdfFile.getUrl() };
}

// Saves one signature PNG into the booking's check-in folder, overwriting
// (trashing) any prior file of the same name — same retake-safe pattern as
// uploadCheckinPhoto.
function saveSignatureFile_(folder, filename, signatureBase64) {
  const blob = Utilities.newBlob(Utilities.base64Decode(signatureBase64), 'image/png', filename);
  const existing = folder.getFilesByName(filename);
  while (existing.hasNext()) existing.next().setTrashed(true);
  folder.createFile(blob);
  return blob;
}

// Renders the agreement text + the client's typed info + their two
// signatures (Rental Agreement, then Waiver of Liability — matching the
// original two-signature paper form) into a PDF. Apps Script has no direct
// text/HTML-to-PDF call, so this builds the content into a throwaway Google
// Doc, exports that to PDF, then deletes the Doc — only the PDF (and the raw
// signature PNGs saved by the caller) stick around in the check-in folder.
function buildWaiverPdf_(folder, body, agreementSigBlob, waiverSigBlob) {
  const doc = DocumentApp.create('waiver-temp-' + new Date().getTime());
  const docBody = doc.getBody();
  docBody.setMarginTop(36).setMarginBottom(36).setMarginLeft(54).setMarginRight(54);

  docBody.appendParagraph('Central Studio — Rental Agreement & Waiver of Liability')
    .setHeading(DocumentApp.ParagraphHeading.HEADING1);

  docBody.appendTable([
    ['Name', body.name],
    ['Company', body.company || '—'],
    ['Address', body.address],
    ['City / State / Zip', body.city + ', ' + body.state + ' ' + body.zip],
    ['Phone', body.phone],
    ['Email', body.email]
  ]);

  const signedStamp = 'Signed electronically on ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, yyyy h:mm a');

  WAIVER_TEXT_AGREEMENT_.forEach(function (section) {
    docBody.appendParagraph(section.heading).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    section.paragraphs.forEach(function (p) { docBody.appendParagraph(p); });
  });
  docBody.appendParagraph('Rental Agreement Signature').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  docBody.appendImage(agreementSigBlob).setWidth(240).setHeight(90);
  docBody.appendParagraph(signedStamp);

  WAIVER_TEXT_LIABILITY_.forEach(function (section) {
    docBody.appendParagraph(section.heading).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    section.paragraphs.forEach(function (p) { docBody.appendParagraph(p); });
  });
  docBody.appendParagraph('Waiver of Liability Signature').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  docBody.appendImage(waiverSigBlob).setWidth(240).setHeight(90);
  docBody.appendParagraph(signedStamp);

  doc.saveAndClose();

  const pdfBlob = DriveApp.getFileById(doc.getId()).getAs('application/pdf');
  const existingPdf = folder.getFilesByName('signed-waiver.pdf');
  while (existingPdf.hasNext()) existingPdf.next().setTrashed(true);
  const pdfFile = folder.createFile(pdfBlob).setName('signed-waiver.pdf');

  DriveApp.getFileById(doc.getId()).setTrashed(true);
  return pdfFile;
}

// Preferred display order for the photos/signatures inlined into the
// completion email — the primary four tiles in their natural front/back
// order, then both signatures. Anything else found in the folder (extra IDs
// from a group rental's "+ Add Another ID") is appended after, since there's
// no fixed count for those.
const NOTIFY_IMAGE_ORDER_ = [
  [CHECKIN_PHOTO_FILENAMES.idFront, 'Photo ID — Front'],
  [CHECKIN_PHOTO_FILENAMES.idBack, 'Photo ID — Back'],
  [CHECKIN_PHOTO_FILENAMES.cardFront, 'Credit Card — Front'],
  [CHECKIN_PHOTO_FILENAMES.cardBack, 'Credit Card — Back'],
  ['rental-agreement-signature.png', 'Rental Agreement Signature'],
  ['waiver-of-liability-signature.png', 'Waiver of Liability Signature']
];

// Best-effort email to the studio when a customer finishes their own
// check-in (ID + credit card photos + signed waiver) from the link texted to
// them. A failure here never fails check-in itself — the photos, signatures
// and waiver PDF are already safely in Drive by the time this runs. Inlines
// every photo/signature directly in the email body (so staff can eyeball
// whether the customer submitted legible, correct images without opening
// Drive) and attaches the signed waiver PDF.
function notifyCheckinComplete_(rowNumber, sheet, headers, lastCol, pdfFile, folder) {
  try {
    const rowValues = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
    const rowObj = {};
    headers.forEach((h, i) => { if (h) rowObj[h] = rowValues[i]; });

    const name = fullName_(rowObj);
    const eventDateTime = parseEventDateTime_(rowObj);
    const dateLabel = eventDateTime
      ? Utilities.formatDate(eventDateTime, Session.getScriptTimeZone(), 'MMM d, yyyy')
      : (rowObj['Event Date'] || 'no date on file');

    const folderCol = headers.indexOf(CHECKIN_FOLDER_COL) + 1;
    const folderId = folderCol ? sheet.getRange(rowNumber, folderCol).getValue() : '';
    const folderUrl = folderId ? 'https://drive.google.com/drive/folders/' + folderId : '(no folder on file)';

    const remainingFiles = {};
    if (folder) {
      const iter = folder.getFiles();
      while (iter.hasNext()) {
        const f = iter.next();
        const mime = f.getMimeType();
        if (mime === 'image/jpeg' || mime === 'image/png') remainingFiles[f.getName()] = f;
      }
    }

    const ordered = [];
    NOTIFY_IMAGE_ORDER_.forEach(function (pair) {
      if (remainingFiles[pair[0]]) {
        ordered.push({ file: remainingFiles[pair[0]], label: pair[1] });
        delete remainingFiles[pair[0]];
      }
    });
    Object.keys(remainingFiles).sort().forEach(function (fname) {
      ordered.push({ file: remainingFiles[fname], label: fname.replace(/\.(jpg|jpeg|png)$/i, '').replace(/[-_]/g, ' ') });
    });

    const inlineImages = {};
    let imagesHtml = '';
    ordered.forEach(function (item, i) {
      const cid = 'checkinImg' + i;
      inlineImages[cid] = item.file.getBlob();
      imagesHtml += '<div style="display:inline-block;margin:6px;text-align:center;vertical-align:top;">' +
        '<img src="cid:' + cid + '" style="max-width:220px;max-height:220px;border:1px solid #ccc;border-radius:6px;display:block;">' +
        '<div style="font-size:11px;color:#555;margin-top:4px;">' + item.label + '</div>' +
        '</div>';
    });

    const linksHtml = '<a href="' + folderUrl + '">Open Drive folder</a>' +
      (pdfFile ? ' &nbsp;|&nbsp; <a href="' + pdfFile.getUrl() + '">Signed waiver PDF</a>' : '');

    MailApp.sendEmail({
      to: CONFIG.CHECKIN_NOTIFY_EMAIL,
      subject: 'Check-in complete: ' + name + ' (' + dateLabel + ')',
      body: name + ' just finished check-in (ID/card photos + signed waiver) for their ' + dateLabel + ' booking.\n\n' +
        'Photos & waiver folder: ' + folderUrl + '\n' +
        (pdfFile ? 'Signed waiver PDF: ' + pdfFile.getUrl() : ''),
      htmlBody: '<p>' + name + ' just finished check-in (ID/card photos + signed waiver) for their ' + dateLabel + ' booking.</p>' +
        '<p>' + linksHtml + '</p>' +
        '<div>' + imagesHtml + '</div>',
      inlineImages: inlineImages,
      attachments: pdfFile ? [pdfFile.getBlob()] : []
    });
  } catch (err) {
    // Swallow from the caller's point of view (see comment above) — but
    // surface it somewhere a non-technical person can actually find: a note
    // on the row's "Checkin Completed Date" cell (small red triangle,
    // visible on hover, right in the sheet) rather than only the Apps
    // Script Executions log, which has proven awkward to dig through.
    console.error('notifyCheckinComplete_ failed: ' + err.message + '\n' + err.stack);
    try {
      const col = headers.indexOf(CHECKIN_COMPLETED_COL) + 1;
      if (col) {
        sheet.getRange(rowNumber, col).setNote(
          'Notification email failed at ' + new Date().toLocaleString() + ': ' + err.message
        );
      }
    } catch (noteErr) {
      // Nothing more we can do here.
    }
  }
}

// Chris's active (non-cancelled) session rows, in raw sheet-row order — the
// same "is this a Chris booking" rule the revenue category cards use, reused
// here so the two never disagree about what counts as one of his sessions.
function getChrisSessionRows_(bookings) {
  return bookings.filter(function (b) {
    const status = (b['Booking Status'] || '').toString().toLowerCase();
    if (status.indexOf('cancel') !== -1) return false;
    return categorizeBooking_(b) === 'chris';
  });
}

function sortByEventDateAsc_(rows) {
  rows.sort(function (a, b) {
    const ea = parseEventDateTime_(a);
    const eb = parseEventDateTime_(b);
    const ta = ea ? ea.getTime() : Number.MAX_SAFE_INTEGER;
    const tb = eb ? eb.getTime() : Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
  return rows;
}

// Unpaid Chris sessions that have actually happened (Event Date in the past),
// oldest first. A future booking isn't "owed" yet just because it's unpaid —
// he hasn't shown up for it. Rows with no parseable Event Date are excluded
// too, since there's no way to confirm they're in the past. Shared by the
// gauge (count) and Apply Payment (which rows to mark) so they never disagree.
function getChrisUnpaidPastSessions_(bookings) {
  const now = Date.now();
  return sortByEventDateAsc_(getChrisSessionRows_(bookings).filter(function (b) {
    if (b[CHRIS_PAID_DATE_COL]) return false;
    const eventDate = parseEventDateTime_(b);
    return !!eventDate && eventDate.getTime() < now;
  }));
}

// Powers the payment gauge: how many of Chris's already-happened sessions have
// no CHRIS_PAID_DATE_COL value yet, plus when the most recent block was paid.
function getChrisPaymentStatus_() {
  const bookings = readRows_(CONFIG.BOOKINGS_TAB);
  const unpaid = getChrisUnpaidPastSessions_(bookings);

  let lastPaymentDate = null;
  getChrisSessionRows_(bookings).forEach(function (b) {
    const paid = parseDateValue_(b[CHRIS_PAID_DATE_COL]);
    if (paid && (!lastPaymentDate || paid > lastPaymentDate)) lastPaymentDate = paid;
  });

  return {
    unpaidCount: unpaid.length,
    blockSize: CHRIS_SESSIONS_PER_BLOCK,
    lastPaymentDate: lastPaymentDate ? formatDate_(lastPaymentDate, 'MMM d, yyyy') : null,
  };
}

// Marks the oldest (by Event Date) unpaid, already-happened Chris sessions as
// paid today, up to one block of 25 — matches how he actually pays (a lump
// sum covering whatever's oldest and unpaid, not necessarily an exact
// multiple of 25 if he kept booking while an invoice was outstanding).
function applyChrisSessionPayment() {
  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = headers.indexOf(CHRIS_PAID_DATE_COL) + 1;
  if (col === 0) {
    throw new Error(
      '"' + CHRIS_PAID_DATE_COL + '" column not found on the bookings tab — ' +
      'run setupChrisPaymentColumn() once from the Apps Script editor.'
    );
  }

  const bookings = readRows_(CONFIG.BOOKINGS_TAB);
  const toMark = getChrisUnpaidPastSessions_(bookings).slice(0, CHRIS_SESSIONS_PER_BLOCK);

  const today = new Date();
  toMark.forEach(function (b) { sheet.getRange(b._row, col).setValue(today); });

  return getDashboardData();
}

// One-time setup utility — run manually from the Apps Script editor (Run >
// setupChrisPaymentColumn). Adds the "Session Paid Date" header to the
// bookings tab if it isn't already there. Safe to re-run — a no-op once the
// column exists.
function setupChrisPaymentColumn() {
  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf(CHRIS_PAID_DATE_COL) !== -1) return;
  sheet.getRange(1, lastCol + 1).setValue(CHRIS_PAID_DATE_COL);
}

// One-time setup utility — run manually from the Apps Script editor (Run > setupBookingsPastEventFormatting).
// Adds a conditional format rule that grays out any bookings row whose Event Date has
// already passed. Uses TODAY() in the formula so it keeps working automatically as dates
// roll by — no need to re-run this after adding new bookings.
function setupBookingsPastEventFormatting() {
  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const eventDateCol = headers.indexOf('Event Date') + 1;
  if (eventDateCol === 0) throw new Error('Event Date column not found');

  const lastCol = sheet.getLastColumn();
  const dataRange = sheet.getRange(2, 1, sheet.getMaxRows() - 1, lastCol);
  const eventDateColLetter = columnToLetter_(eventDateCol);

  const rules = sheet.getConditionalFormatRules().filter(r => {
    return !r.getRanges().some(rg => rg.getA1Notation() === dataRange.getA1Notation());
  });

  const pastEventRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$' + eventDateColLetter + '2 < TODAY()')
    .setBackground('#e8e8e8')
    .setRanges([dataRange])
    .build();

  rules.push(pastEventRule);
  sheet.setConditionalFormatRules(rules);
}

// ---------------------------------------------------------------------------
// One-time fix: Calendly bookings (everyone except Chris) arrive via a Zap
// that writes the Calendly UTC start-time straight into the sheet without
// converting it to Eastern first. Google Sheets then reads e.g. "18:00:00"
// as if it were already 6:00 PM America/New_York, when it actually meant
// 6:00 PM UTC (= 2:00 PM Eastern during EDT). Every Calendly-sourced row is
// shifted by a fixed few hours as a result; Chris's rows are unaffected
// since those come from the Calendar API as real timezone-aware instants,
// never as an unconverted UTC string.
//
// The fix: take the wrong stored instant, read off its Eastern wall-clock
// digits (that's the original UTC value Calendly sent, carried through
// unchanged), and rebuild a new instant treating those same digits as UTC.
// This is DST-safe automatically — no manual 4-vs-5-hour table needed —
// because Utilities.formatDate already applies the correct rule for
// whatever date each row happens to fall on.
//
// Run previewCalendlyTimezoneFix() FIRST and check the log (View > Logs /
// Executions) against a few bookings you know the real time of. Only run
// applyCalendlyTimezoneFix() once you're confident the preview is right —
// it writes to the sheet and cannot be undone by re-running it (a second
// run would shift everything again, which is why it refuses to run twice).
// ---------------------------------------------------------------------------

function reinterpretEasternDigitsAsUtc_(date) {
  const parts = Utilities.formatDate(date, 'America/New_York', 'yyyy-MM-dd-HH-mm-ss').split('-');
  return new Date(Date.UTC(
    Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]),
    Number(parts[3]), Number(parts[4]), Number(parts[5])
  ));
}

function runCalendlyTimezoneFix_(dryRun) {
  const sheet = getSheet_(CONFIG.BOOKINGS_TAB);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const eventDateCol = headers.indexOf('Event Date') + 1;
  const dateBookedCol = headers.indexOf('Date Booked') + 1;
  if (eventDateCol === 0) throw new Error('Event Date column not found');
  if (dateBookedCol === 0) throw new Error('Date Booked column not found');

  const rows = readRows_(CONFIG.BOOKINGS_TAB);
  let correctedRows = 0, skippedChris = 0, skippedNoDate = 0;

  rows.forEach(r => {
    const email = (r['Invitee Email'] || '').toString().trim().toLowerCase();
    if (email === CHRIS_AUTO_SYNC_EMAIL) { skippedChris++; return; }

    let touchedThisRow = false;
    [['Event Date', eventDateCol], ['Date Booked', dateBookedCol]].forEach(([field, col]) => {
      const original = r[field];
      if (!isDate_(original)) return;
      const corrected = reinterpretEasternDigitsAsUtc_(original);
      touchedThisRow = true;
      Logger.log(
        'Row %s (%s) — %s: %s -> %s',
        r._row, fullName_(r), field,
        Utilities.formatDate(original, 'America/New_York', 'MMM d, yyyy h:mm a'),
        Utilities.formatDate(corrected, 'America/New_York', 'MMM d, yyyy h:mm a')
      );
      if (!dryRun) sheet.getRange(r._row, col).setValue(corrected);
    });

    if (touchedThisRow) correctedRows++; else skippedNoDate++;
  });

  Logger.log(
    '%s — %s row(s) corrected, %s Chris row(s) skipped, %s row(s) had no date to fix.',
    dryRun ? 'DRY RUN (nothing written)' : 'APPLIED', correctedRows, skippedChris, skippedNoDate
  );
}

// Run this first. Logs every change it WOULD make without writing anything.
function previewCalendlyTimezoneFix() {
  runCalendlyTimezoneFix_(true);
}

// Run this only after reviewing previewCalendlyTimezoneFix()'s log. Writes
// the corrected dates to the sheet. Refuses to run a second time so an
// accidental re-run can't shift already-corrected rows again — clear the
// 'calendlyTzFixAppliedAt' script property yourself if you really need to.
function applyCalendlyTimezoneFix() {
  const props = PropertiesService.getScriptProperties();
  const already = props.getProperty('calendlyTzFixAppliedAt');
  if (already) {
    throw new Error('Already applied on ' + already + '. Delete the "calendlyTzFixAppliedAt" script property if you really need to run this again.');
  }
  runCalendlyTimezoneFix_(false);
  props.setProperty('calendlyTzFixAppliedAt', new Date().toISOString());
}

function columnToLetter_(column) {
  let temp, letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 2) / 26;
  }
  return letter;
}

const MONTH_ABBR_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// historical tab rows show as "Jan-26" but Sheets silently misreads that as
// "month DD" (no year) rather than "month YY" and auto-converts to a Date,
// defaulting the year to whenever the conversion happened and dumping the
// original two-digit year into the day-of-month slot instead. E.g. "Oct-25"
// (meant Oct 2025) becomes a Date for Oct 25 of some unrelated year. The day
// number is reliably the real YY though, so recover from that, not getFullYear().
function parseHistoricalMonth_(label) {
  if (isDate_(label)) {
    return { year: 2000 + label.getDate(), month: label.getMonth() };
  }
  const parts = String(label || '').split('-');
  if (parts.length !== 2) return null;
  const monthIdx = MONTH_ABBR_.indexOf(parts[0]);
  const yy = parseInt(parts[1], 10);
  if (monthIdx === -1 || isNaN(yy)) return null;
  return { year: 2000 + yy, month: monthIdx };
}

function toNumber_(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function sumKnown_(values) {
  return values.filter(v => v !== null).reduce((a, v) => a + v, 0);
}

function quarterOf_(monthValues, quarterIdx) {
  const vals = [monthValues[quarterIdx * 3], monthValues[quarterIdx * 3 + 1], monthValues[quarterIdx * 3 + 2]];
  const known = vals.filter(v => v !== null);
  return known.length ? sumKnown_(vals) : null;
}

function pctChange_(current, base) {
  if (current === null || base === null || base === 0) return null;
  return ((current - base) / base) * 100;
}

function historicalMonthLabel_(year, month) {
  return MONTH_ABBR_[month] + '-' + String(year).slice(-2);
}

// Sums Total Paid for active (non-cancelled) bookings whose Event Date falls
// in the given month/year — this is what "revenue" means for a given month.
function sumPaidForMonth_(bookings, year, month) {
  return bookings.reduce((total, b) => {
    const status = (b['Booking Status'] || '').toString().toLowerCase();
    if (status.indexOf('cancel') !== -1) return total;
    const eventDate = parseEventDateTime_(b);
    if (!eventDate || eventDate.getFullYear() !== year || eventDate.getMonth() !== month) return total;
    return total + toNumber_(b['Total Paid']);
  }, 0);
}

// Revenue category split — the three buckets always sum to total revenue:
// Chris Connelly (by Invitee Name), Monster Productions (by Event Type), and
// Studio Rentals (everything else).
function categorizeBooking_(b) {
  const name = (b['Invitee Name'] || '').toString().trim().toLowerCase();
  if (name === 'chris connelly') return 'chris';
  const eventType = (b['Event Type'] || '').toString().trim().toLowerCase();
  if (eventType === 'monster productions shoot') return 'monster';
  return 'rentals';
}

// Sums Total Paid per category for active bookings whose Event Date falls in
// the given year, optionally narrowed to a single month (null = whole year).
function sumCategoryRevenue_(bookings, year, month) {
  const totals = { chris: 0, monster: 0, rentals: 0 };
  bookings.forEach(b => {
    const status = (b['Booking Status'] || '').toString().toLowerCase();
    if (status.indexOf('cancel') !== -1) return;
    const eventDate = parseEventDateTime_(b);
    if (!eventDate || eventDate.getFullYear() !== year) return;
    if (month !== null && eventDate.getMonth() !== month) return;
    totals[categorizeBooking_(b)] += toNumber_(b['Total Paid']);
  });
  return totals;
}

// Keeps the historical tab's current-month row in sync with actual bookings
// revenue (Total Paid by Event Date), and italicizes it to flag that the month
// isn't closed out yet — the total will keep moving until the month rolls over.
// Any other row that's still italic from a prior run (last month, before it
// closed out) gets reset to normal font here too. Runs on a time-driven trigger
// (see setupHistoricalRevenueSync) rather than on every page load.
function syncCurrentMonthRevenue_() {
  const sheet = getSheet_(CONFIG.HISTORICAL_TAB);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const monthCol = headers.indexOf('Month') + 1;
  const revenueCol = headers.indexOf('Revenue') + 1;
  if (monthCol === 0) throw new Error('Month column not found');
  if (revenueCol === 0) throw new Error('Revenue column not found');

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  const rows = readRows_(CONFIG.HISTORICAL_TAB);
  let currentMonthRow = null;
  rows.forEach(r => {
    const parsed = parseHistoricalMonth_(r['Month']);
    if (!parsed) return;
    if (parsed.year === currentYear && parsed.month === currentMonth) {
      currentMonthRow = r._row;
    } else {
      sheet.getRange(r._row, revenueCol).setFontStyle('normal');
    }
  });

  if (!currentMonthRow) {
    currentMonthRow = sheet.getLastRow() + 1;
    sheet.getRange(currentMonthRow, monthCol).setValue(historicalMonthLabel_(currentYear, currentMonth));
  }

  const bookings = readRows_(CONFIG.BOOKINGS_TAB);
  const total = sumPaidForMonth_(bookings, currentYear, currentMonth);

  const revenueCell = sheet.getRange(currentMonthRow, revenueCol);
  revenueCell.setValue(total);
  revenueCell.setFontStyle('italic');
}

// One-time setup utility — run manually from the Apps Script editor
// (Run > setupHistoricalRevenueSync). Installs an hourly trigger that keeps
// the current month's historical revenue row synced and italicized, and runs
// it once immediately.
function setupHistoricalRevenueSync() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncCurrentMonthRevenue_')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncCurrentMonthRevenue_')
    .timeBased()
    .everyHours(1)
    .create();
  syncCurrentMonthRevenue_();
}

function getRevenueStats() {
  const rows = readRows_(CONFIG.HISTORICAL_TAB);
  const byYear = {};
  rows.forEach(r => {
    const parsed = parseHistoricalMonth_(r['Month']);
    if (!parsed) return;
    if (!byYear[parsed.year]) byYear[parsed.year] = new Array(12).fill(null);
    byYear[parsed.year][parsed.month] = toNumber_(r['Revenue']);
  });

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthIdx = now.getMonth();
  const lastYear = currentYear - 1;

  // Full history, oldest to newest, for the "since opening" trend chart —
  // stops at the current (in-progress) month, excludes not-yet-reached months.
  const allMonths = rows
    .map(r => {
      const parsed = parseHistoricalMonth_(r['Month']);
      return parsed ? { year: parsed.year, month: parsed.month, value: toNumber_(r['Revenue']) } : null;
    })
    .filter(m => m !== null)
    .filter(m => (m.year * 12 + m.month) <= (currentYear * 12 + currentMonthIdx))
    .sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month))
    .map(m => ({ label: historicalMonthLabel_(m.year, m.month), value: m.value }));

  const thisYearMonths = byYear[currentYear] || new Array(12).fill(null);
  const lastYearMonths = byYear[lastYear] || new Array(12).fill(null);

  const lastYearTotal = sumKnown_(lastYearMonths);
  const lastYearAvg = lastYearTotal / 12;

  const months = MONTH_NAMES_.map((name, idx) => {
    const thisYearAmt = thisYearMonths[idx];
    const lastYearAmt = lastYearMonths[idx];
    const prevAmt = idx === 0 ? null : thisYearMonths[idx - 1];
    return {
      name: name,
      thisYear: thisYearAmt,
      lastYear: lastYearAmt,
      pctOfPrevMonth: (thisYearAmt === null || prevAmt === null) ? null : pctChange_(thisYearAmt, prevAmt) + 100,
      pctOfLYAvg: (thisYearAmt === null || lastYearAvg === 0) ? null : (thisYearAmt / lastYearAvg) * 100,
      pctChange: pctChange_(thisYearAmt, lastYearAmt),
    };
  });

  const knownThisYear = thisYearMonths.filter(v => v !== null);
  const ytdThisYear = sumKnown_(thisYearMonths);
  const thisYearAvgSoFar = knownThisYear.length ? ytdThisYear / knownThisYear.length : 0;
  const ytdComparisonDiff = ytdThisYear - lastYearTotal;
  const ytdComparisonPct = lastYearTotal === 0 ? null : (ytdComparisonDiff / lastYearTotal) * 100;

  const quarters = ['Q1', 'Q2', 'Q3', 'Q4'].map((label, qIdx) => {
    const ty = quarterOf_(thisYearMonths, qIdx);
    const ly = quarterOf_(lastYearMonths, qIdx);
    return { label: label, thisYear: ty, lastYear: ly, pctChange: pctChange_(ty, ly) };
  });

  const bookings = readRows_(CONFIG.BOOKINGS_TAB);
  const categoryMonth = sumCategoryRevenue_(bookings, currentYear, now.getMonth());
  const categoryYear = sumCategoryRevenue_(bookings, currentYear, null);
  const categories = {
    chrisConnelly: { label: 'Chris Connelly', month: categoryMonth.chris, year: categoryYear.chris },
    monsterProductions: { label: 'Monster Productions', month: categoryMonth.monster, year: categoryYear.monster },
    studioRentals: { label: 'Studio Rentals', month: categoryMonth.rentals, year: categoryYear.rentals },
  };

  return {
    currentYear: currentYear,
    lastYear: lastYear,
    months: months,
    lastYearAvg: lastYearAvg,
    lastYearTotal: lastYearTotal,
    thisYearAvgSoFar: thisYearAvgSoFar,
    ytdThisYear: ytdThisYear,
    ytdComparisonDiff: ytdComparisonDiff,
    ytdComparisonPct: ytdComparisonPct,
    quarters: quarters,
    categories: categories,
    allMonths: allMonths,
    generatedAt: formatDate_(new Date(), 'EEE, MMM d, yyyy h:mm a'),
  };
}

function normalizePhone_(val) {
  const digits = (val || '').toString().replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : '';
}

// value vs baseline -> 'great' (>=110%), 'okay' (80-110%), 'low' (<80%), or
// 'neutral' when there's not enough data yet to judge (no baseline, or no value).
function tierFor_(value, baseline) {
  if (value === null || value === undefined || baseline === null || baseline === undefined) return 'neutral';
  if (baseline === 0) return value > 0 ? 'great' : 'neutral';
  const ratio = value / baseline;
  if (ratio >= 1.10) return 'great';
  if (ratio >= 0.80) return 'okay';
  return 'low';
}

// Studio Health — this month's inquiries, rentals, unique customers, lead-conversion
// rate, and repeat-customer rate, each measured against a baseline (this year's
// monthly average, or last month) and scored great/okay/low against it.
function getStudioHealth() {
  const bookings = readRows_(CONFIG.BOOKINGS_TAB);
  const inquiries = readRows_(CONFIG.INQUIRY_TAB);

  const activeBookings = bookings.filter(b => {
    const status = (b['Booking Status'] || '').toString().toLowerCase();
    return status.indexOf('cancel') === -1;
  });

  // All-time regular-customer detection (mirrors getDashboardData's isRegular logic).
  const emailCounts = {};
  bookings.forEach(b => {
    const email = (b['Invitee Email'] || '').toString().trim().toLowerCase();
    if (!email) return;
    emailCounts[email] = (emailCounts[email] || 0) + 1;
  });

  // All-time contact sets, so an inquiry can be matched to a booking it became
  // even if that booking happened in a different month than the inquiry.
  const bookedEmails = new Set();
  const bookedPhones = new Set();
  activeBookings.forEach(b => {
    const email = (b['Invitee Email'] || '').toString().trim().toLowerCase();
    if (email) bookedEmails.add(email);
    const phone = normalizePhone_(b['Phone']);
    if (phone) bookedPhones.add(phone);
  });

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthIdx = now.getMonth();

  function countsForYear_(rows, dateField, year) {
    const counts = new Array(12).fill(0);
    rows.forEach(r => {
      const d = parseDateValue_(r[dateField]);
      if (d && d.getFullYear() === year) counts[d.getMonth()]++;
    });
    return counts;
  }

  const inquiryCounts = countsForYear_(inquiries, 'Submitted At', currentYear);
  const rentalCounts = countsForYear_(activeBookings, 'Event Date', currentYear);

  const repeatRateByMonth = new Array(12).fill(null);
  const conversionRateByMonth = new Array(12).fill(null);

  for (let m = 0; m < 12; m++) {
    const monthBookings = activeBookings.filter(b => {
      const d = parseEventDateTime_(b);
      return d && d.getFullYear() === currentYear && d.getMonth() === m;
    });
    if (monthBookings.length) {
      const repeatCount = monthBookings.filter(b => {
        const email = (b['Invitee Email'] || '').toString().trim().toLowerCase();
        return email && emailCounts[email] > 1;
      }).length;
      repeatRateByMonth[m] = (repeatCount / monthBookings.length) * 100;
    }

    const monthInquiries = inquiries.filter(i => {
      const d = parseDateValue_(i['Submitted At']);
      return d && d.getFullYear() === currentYear && d.getMonth() === m;
    });
    if (monthInquiries.length) {
      const convertedCount = monthInquiries.filter(i => {
        const email = (i['data__Email'] || '').toString().trim().toLowerCase();
        const phone = normalizePhone_(i['data__Phone Number']);
        return (email && bookedEmails.has(email)) || (phone && bookedPhones.has(phone));
      }).length;
      conversionRateByMonth[m] = (convertedCount / monthInquiries.length) * 100;
    }
  }

  function uniqueCustomersForMonth_(year, month) {
    const keys = new Set();
    activeBookings.forEach(b => {
      const d = parseEventDateTime_(b);
      if (!d || d.getFullYear() !== year || d.getMonth() !== month) return;
      const email = (b['Invitee Email'] || '').toString().trim().toLowerCase();
      keys.add(email || ('name:' + fullName_(b).toLowerCase()));
    });
    return keys.size;
  }

  // Baseline is the average of this year's *completed* months only — the
  // in-progress current month never gets compared against itself.
  function avgOfCompletedMonths_(counts) {
    if (currentMonthIdx === 0) return null;
    const completed = counts.slice(0, currentMonthIdx);
    return completed.reduce((a, v) => a + v, 0) / completed.length;
  }

  function avgOfCompletedRates_(rates) {
    const completed = rates.slice(0, currentMonthIdx).filter(v => v !== null);
    return completed.length ? completed.reduce((a, v) => a + v, 0) / completed.length : null;
  }

  const inquiriesThisMonth = inquiryCounts[currentMonthIdx];
  const rentalsThisMonth = rentalCounts[currentMonthIdx];
  const inquiriesAvg = avgOfCompletedMonths_(inquiryCounts);
  const rentalsAvg = avgOfCompletedMonths_(rentalCounts);

  const uniqueThisMonth = uniqueCustomersForMonth_(currentYear, currentMonthIdx);
  let prevYear = currentYear, prevMonth = currentMonthIdx - 1;
  if (prevMonth < 0) { prevMonth = 11; prevYear = currentYear - 1; }
  const uniquePrevMonth = uniqueCustomersForMonth_(prevYear, prevMonth);

  const conversionThisMonth = conversionRateByMonth[currentMonthIdx];
  const conversionAvg = avgOfCompletedRates_(conversionRateByMonth);

  const repeatThisMonth = repeatRateByMonth[currentMonthIdx];
  const repeatAvg = avgOfCompletedRates_(repeatRateByMonth);

  return {
    monthLabel: MONTH_NAMES_[currentMonthIdx],
    inquiries: {
      label: 'Inquiries This Month', value: inquiriesThisMonth, baseline: inquiriesAvg,
      baselineLabel: 'Monthly Avg', tier: tierFor_(inquiriesThisMonth, inquiriesAvg),
    },
    rentals: {
      label: 'Rentals This Month', value: rentalsThisMonth, baseline: rentalsAvg,
      baselineLabel: 'Monthly Avg', tier: tierFor_(rentalsThisMonth, rentalsAvg),
    },
    uniqueCustomers: {
      label: 'Unique Customers', value: uniqueThisMonth, baseline: uniquePrevMonth,
      baselineLabel: 'Last Month', tier: tierFor_(uniqueThisMonth, uniquePrevMonth),
    },
    conversionRate: {
      label: 'Inquiry -> Booking Rate', value: conversionThisMonth, baseline: conversionAvg,
      baselineLabel: 'Monthly Avg', tier: tierFor_(conversionThisMonth, conversionAvg), isPercent: true,
    },
    repeatCustomerRate: {
      label: 'Repeat Customer Rate', value: repeatThisMonth, baseline: repeatAvg,
      baselineLabel: 'Monthly Avg', tier: tierFor_(repeatThisMonth, repeatAvg), isPercent: true,
    },
  };
}

