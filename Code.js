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

