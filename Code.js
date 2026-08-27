const CONFIG = {
  SHEET_ID: '1LGDQdKhiiGAxpnn_YkQJgZefhJQD5rkwffWdeZTO2Pg',
  BOOKINGS_TAB: 'bookings',
  INQUIRY_TAB: 'inquiry',
  HISTORICAL_TAB: 'historical',
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
    if (action === 'getRevenue') {
      return jsonOutput_({ ok: true, data: getRevenueStats() });
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

// Event Date holds a full date+time value (no separate Event Time column).
function parseEventDateTime_(row) {
  const dateVal = row['Event Date'];
  if (isDate_(dateVal)) return dateVal;
  if (!dateVal) return null;
  const parsed = new Date(dateVal);
  return isNaN(parsed.getTime()) ? null : parsed;
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
  const lastYear = currentYear - 1;

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
    generatedAt: formatDate_(new Date(), 'EEE, MMM d, yyyy h:mm a'),
  };
}

