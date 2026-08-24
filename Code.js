const CONFIG = {
  SHEET_ID: '1LGDQdKhiiGAxpnn_YkQJgZefhJQD5rkwffWdeZTO2Pg',
  BOOKINGS_TAB: 'bookings',
  INQUIRY_TAB: 'inquiry',
};

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
    if (body.action === 'updateInquiry') {
      return jsonOutput_({ ok: true, data: updateInquiry(body.row, body.note, body.close) });
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
  const first = row['Invitee First Name'] || '';
  const last = row['Invitee Last Name'] || '';
  const combined = (first + ' ' + last).trim();
  return combined || row['Invitee Name'] || '(no name)';
}

function isDate_(val) {
  return !!val && typeof val.getTime === 'function' && Object.prototype.toString.call(val) === '[object Date]';
}

function parseEventDateTime_(row) {
  const dateVal = row['Event Date'];
  const timeVal = row['Event Time'];
  if (isDate_(dateVal)) {
    const d = new Date(dateVal.getTime());
    if (isDate_(timeVal)) {
      d.setHours(timeVal.getHours(), timeVal.getMinutes(), timeVal.getSeconds(), 0);
    }
    return d;
  }
  if (!dateVal) return null;
  const combined = timeVal ? (dateVal + ' ' + timeVal) : dateVal;
  const parsed = new Date(combined);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate_(val, pattern) {
  if (isDate_(val)) return Utilities.formatDate(val, Session.getScriptTimeZone(), pattern);
  return val || '';
}

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
      phone: b['Phone Number'] || '',
      eventType: b['Event Type'] || '',
      eventDate: formatDate_(b['Event Date'], 'EEE, MMM d, yyyy'),
      eventTime: formatDate_(b['Event Time'], 'h:mm a'),
      eventTimestamp: eventDateTime ? eventDateTime.getTime() : Number.MAX_SAFE_INTEGER,
      location: b['Location'] || '',
      groupOver8: b['Group Over 8'] || '',
      lighting: b['Lighting Equipment'] || '',
      needsHousePhotographer: b['Needs House Photographer'] || '',
      totalPriceQuoted: b['Total Price Quoted'] || '',
      notes: b['Notes'] || '',
      called: !!b['Date Called'],
      dateCalled: formatDate_(b['Date Called'], 'MMM d, yyyy'),
      isRegular: email ? emailCounts[email] > 1 : false,
      bookingsCount: email ? emailCounts[email] : 1,
    };
  });

  enriched.sort((a, b) => a.eventTimestamp - b.eventTimestamp);

  const needsCall = enriched.filter(b => !b.called);
  const alreadyCalled = enriched.filter(b => b.called);

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
    alreadyCalled: alreadyCalled,
    openInquiries: openInquiries,
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

