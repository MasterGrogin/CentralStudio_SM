var API_URL = 'https://script.google.com/macros/s/AKfycbxBvB5Ew_NMCCr_gzJpF93hwj-Mzry1RqxxZFH-TPflwDPva6zSh_rmk2OClQ4QH9Io/exec';

var inFlight = {};

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// navigator.clipboard is only defined in secure (https) contexts and on
// modern browsers — calling it when undefined throws immediately, before a
// .catch ever runs. Falls back to the old execCommand('copy') trick, then to
// a manual prompt so there's always something the user can do.
function copyToClipboard_(text, btn, restoreLabel) {
  function showCopied() {
    btn.textContent = 'Copied!';
    setTimeout(function () { btn.textContent = restoreLabel; }, 1500);
  }
  function legacyCopy() {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(showCopied).catch(function () {
      if (legacyCopy()) showCopied(); else window.prompt('Copy this link:', text);
    });
    return;
  }
  if (legacyCopy()) showCopied(); else window.prompt('Copy this link:', text);
}

function phoneMarkup(phone) {
  if (!phone) return '';
  var display = String(phone);
  var digits = display.replace(/[^\d+]/g, '');
  return '<details class="phone-details">' +
    '<summary class="phone-summary">' + escapeHtml(display) + '</summary>' +
    '<span class="phone-options">' +
      '<a href="tel:' + digits + '" class="phone-action">Call</a>' +
      '<a href="sms:' + digits + '" class="phone-action">Text</a>' +
    '</span>' +
  '</details>';
}

function loadDashboard() {
  document.getElementById('loading').style.display = '';
  document.getElementById('content').style.display = 'none';
  document.getElementById('errorBox').style.display = 'none';

  fetch(API_URL + '?action=getData')
    .then(function (res) { return res.json(); })
    .then(function (res) {
      if (res.ok) {
        renderDashboard(res.data);
      } else {
        showError(res.error);
      }
    })
    .catch(function (err) { showError(err.message || err); });
}

function showError(message) {
  document.getElementById('loading').style.display = 'none';
  var box = document.getElementById('errorBox');
  box.style.display = '';
  box.textContent = 'Something went wrong loading the dashboard: ' + message;
}

function renderDashboard(data) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('content').style.display = '';
  document.getElementById('generatedAt').textContent = 'Updated ' + data.generatedAt;

  document.getElementById('needsCallCount').textContent = data.needsCall.length;
  document.getElementById('vettedCount').textContent = data.vettedUpcoming.length;
  document.getElementById('inquiryCount').textContent = data.openInquiries.length;

  renderBookingList('needsCallList', data.needsCall, false);
  renderVettedList('vettedList', data.vettedUpcoming);
  renderInquiryList('inquiryList', data.openInquiries);
  renderChrisPayment(data.chrisPaymentStatus);
}

var CHRIS_INVOICE_THRESHOLD = 15;
var chrisPendingCount = 0;

function chrisTierFor(count, blockSize) {
  if (count >= blockSize) return 'danger';
  if (count >= CHRIS_INVOICE_THRESHOLD) return 'warn';
  return 'safe';
}

// Gauge fills 0-25 and clamps visually at a full bar past 25, but the number
// itself keeps counting up past 25 — Chris can keep booking sessions while an
// invoice is outstanding, so "more than a block owed" is a real state to show.
function renderChrisPayment(status) {
  if (!status) return;
  var count = status.unpaidCount;
  var blockSize = status.blockSize || 25;
  var tier = chrisTierFor(count, blockSize);

  var countEl = document.getElementById('chrisUnpaidCount');
  countEl.textContent = count;
  countEl.className = 'chris-gauge-number tier-' + tier;

  document.getElementById('chrisLastPayment').textContent = status.lastPaymentDate
    ? ('Last payment applied ' + status.lastPaymentDate)
    : 'No payments recorded yet';

  var fillPct = Math.min(100, (count / blockSize) * 100);
  var fillEl = document.getElementById('chrisGaugeFill');
  fillEl.style.width = fillPct + '%';
  fillEl.className = 'chris-gauge-fill tier-' + tier;

  document.getElementById('chrisGaugeTick').style.left =
    Math.min(100, (CHRIS_INVOICE_THRESHOLD / blockSize) * 100) + '%';

  chrisPendingCount = Math.min(count, blockSize);
  document.getElementById('chrisApplyPaymentBtn').disabled = chrisPendingCount === 0;
}

function renderBookingList(containerId, items, isCalledList) {
  var container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<div class="empty-note">Nothing here.</div>';
    return;
  }
  items.forEach(function (b) {
    container.appendChild(buildBookingCard(b, isCalledList));
  });
}

var VETTED_WINDOW_DAYS = 5;

// Vetted Upcoming Rentals only shows bookings within the next few days by
// default (the list can otherwise get long and push everything else down);
// the rest are one click away behind a "Show more" button instead of hidden
// entirely. Items with no parseable event date sort last (see eventTimestamp
// in Code.js) and land in the "more" bucket along with everything further out.
function renderVettedList(containerId, items) {
  var container = document.getElementById(containerId);
  container.innerHTML = '';

  if (!items.length) {
    container.innerHTML = '<div class="empty-note">Nothing here.</div>';
    return;
  }

  var cutoff = Date.now() + VETTED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  var visible = items.filter(function (b) { return b.eventTimestamp <= cutoff; });
  var hidden = items.filter(function (b) { return b.eventTimestamp > cutoff; });

  if (!visible.length) {
    container.innerHTML = '<div class="empty-note">Nothing in the next ' + VETTED_WINDOW_DAYS + ' days.</div>';
  } else {
    visible.forEach(function (b) {
      container.appendChild(buildBookingCard(b, true));
    });
  }

  if (hidden.length) {
    var moreBtn = document.createElement('button');
    moreBtn.className = 'action-btn undo show-more-btn';
    moreBtn.textContent = 'Show ' + hidden.length + ' more';
    moreBtn.onclick = function () {
      hidden.forEach(function (b) {
        container.insertBefore(buildBookingCard(b, true), moreBtn);
      });
      moreBtn.remove();
    };
    container.appendChild(moreBtn);
  }
}

function buildBookingCard(b, isVettedList) {
  var card = document.createElement('div');
  card.className = 'card ' + (isVettedList ? 'is-called' : 'is-needs-call');

  var badge = b.isRegular ? '<span class="badge">Regular (' + b.bookingsCount + ')</span>' : '';
  var checkinBadge = '<span class="badge checkin-status-badge ' +
    (b.checkinCompleted ? 'badge-checkin-done' : 'badge-checkin-pending') + '">' +
    (b.checkinCompleted ? 'Checked In' : 'Not Checked In') + '</span>';

  var bookedMetaParts = [];
  if (b.dateBooked) bookedMetaParts.push('Booked ' + escapeHtml(b.dateBooked));
  if (b.phone) bookedMetaParts.push(phoneMarkup(b.phone));

  var summary = document.createElement('div');
  summary.className = 'card-summary';
  summary.innerHTML =
    '<div class="card-top">' +
      '<div><span class="card-name">' + escapeHtml(b.name) + '</span>' + badge + checkinBadge + '</div>' +
      '<span class="expand-caret">&#9656;</span>' +
    '</div>' +
    '<div class="card-date">Rental: ' + escapeHtml(b.eventDate) + (b.eventTime ? ' &middot; ' + escapeHtml(b.eventTime) : '') + '</div>' +
    '<div class="card-meta">' + bookedMetaParts.join(' &middot; ') + '</div>';

  var detailFields = [];
  if (b.eventType) detailFields.push(['Event Type', b.eventType]);
  if (b.email) detailFields.push(['Email', b.email]);
  if (isVettedList && b.dateCalled) detailFields.push(['Called', b.dateCalled]);
  if (b.amountPaid) detailFields.push(['Amount Paid', b.amountPaid]);
  if (b.paymentTerms) detailFields.push(['Payment Terms', b.paymentTerms]);
  if (b.totalPriceQuoted) detailFields.push(['Total Price Quoted', b.totalPriceQuoted]);
  if (b.typeOfWork) detailFields.push(['Type of Work', b.typeOfWork]);
  if (b.groupOver8) detailFields.push(['Group Over 8', b.groupOver8]);
  if (b.lighting) detailFields.push(['Lighting', b.lighting]);
  if (b.needsHousePhotographer) detailFields.push(['House Photographer', b.needsHousePhotographer]);
  if (b.beenToStudioBefore) detailFields.push(['Been to Studio Before', b.beenToStudioBefore]);
  if (b.firstTimeRenting) detailFields.push(['First Time Renting', b.firstTimeRenting]);
  if (b.anythingToKnow) detailFields.push(['Anything to Know', b.anythingToKnow]);

  var detailRowsHtml = detailFields.map(function (f) {
    return '<div class="detail-row"><span class="detail-label">' + escapeHtml(f[0]) + '</span>' +
      '<span class="detail-value">' + escapeHtml(String(f[1])) + '</span></div>';
  }).join('');

  var notesHtml = b.notes ? '<div class="card-notes">' + escapeHtml(b.notes) + '</div>' : '';

  var detail = document.createElement('div');
  detail.className = 'card-detail';
  detail.style.display = 'none';
  detail.innerHTML =
    '<div class="detail-grid">' + detailRowsHtml + '</div>' +
    notesHtml +
    '<div class="card-actions"></div>';

  var actions = detail.querySelector('.card-actions');

  var checkinQuery = '?row=' + encodeURIComponent(b.row) +
    '&name=' + encodeURIComponent(b.name) +
    '&date=' + encodeURIComponent(b.eventDate) +
    '&time=' + encodeURIComponent(b.eventTime) +
    '&lastCheckin=' + encodeURIComponent(b.lastCheckinDate || '');
  var checkinUrl = new URL('checkin.html' + checkinQuery, window.location.href).toString();

  var checkinBtn = document.createElement('a');
  checkinBtn.className = 'action-btn undo';
  checkinBtn.textContent = 'Check-in';
  checkinBtn.target = '_blank';
  checkinBtn.rel = 'noopener';
  checkinBtn.href = checkinUrl;
  actions.appendChild(checkinBtn);

  // Lets front desk send the same check-in page straight to the customer's
  // phone so they can upload their own ID/card photos before arriving,
  // instead of someone at the desk doing it for them.
  if (b.phone) {
    var textDigits = String(b.phone).replace(/[^\d+]/g, '');
    var textMsg = 'Please complete check-in for your ' + (b.eventDate || 'upcoming') + ' booking here: ' + checkinUrl;
    var textLinkBtn = document.createElement('a');
    textLinkBtn.className = 'action-btn undo';
    textLinkBtn.textContent = 'Text Check-in Link';
    textLinkBtn.href = 'sms:' + textDigits + '?&body=' + encodeURIComponent(textMsg);
    actions.appendChild(textLinkBtn);
  }

  var copyLinkBtn = document.createElement('button');
  copyLinkBtn.type = 'button';
  copyLinkBtn.className = 'action-btn undo';
  copyLinkBtn.textContent = 'Copy Check-in Link';
  copyLinkBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    copyToClipboard_(checkinUrl, copyLinkBtn, 'Copy Check-in Link');
  });
  actions.appendChild(copyLinkBtn);

  if (isVettedList) {
    var undoBtn = document.createElement('button');
    undoBtn.className = 'action-btn undo';
    undoBtn.textContent = 'Undo Call';
    undoBtn.onclick = function () { toggleBooking(b.row, false, undoBtn); };
    actions.appendChild(undoBtn);

    var completeBtn = document.createElement('button');
    completeBtn.className = 'action-btn call';
    completeBtn.textContent = 'Complete & Close';
    completeBtn.onclick = function () { openPaymentModal(b.row, b.name); };
    actions.appendChild(completeBtn);
  } else {
    var callBtn = document.createElement('button');
    callBtn.className = 'action-btn call';
    callBtn.textContent = 'Mark Called';
    callBtn.onclick = function () { toggleBooking(b.row, true, callBtn); };
    actions.appendChild(callBtn);
  }

  summary.addEventListener('click', function (e) {
    if (e.target.closest('.phone-details') || e.target.closest('.checkin-status-badge')) return;
    var isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : '';
    summary.querySelector('.expand-caret').innerHTML = isOpen ? '&#9656;' : '&#9662;';
  });

  summary.querySelector('.checkin-status-badge').addEventListener('click', function (e) {
    e.stopPropagation();
    openCheckinStatusModal(b);
  });

  card.appendChild(summary);
  card.appendChild(detail);

  return card;
}

function postAction(payload) {
  return fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(function (res) { return res.json(); });
}

function toggleBooking(row, shouldBeCalled, btn) {
  if (inFlight[row]) return;
  inFlight[row] = true;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  postAction({ action: 'toggleBookingCalled', row: row, value: shouldBeCalled })
    .then(function (res) {
      inFlight[row] = false;
      if (res.ok) {
        renderDashboard(res.data);
      } else {
        btn.disabled = false;
        showError(res.error);
      }
    })
    .catch(function (err) {
      inFlight[row] = false;
      btn.disabled = false;
      showError(err.message || err);
    });
}

function renderInquiryList(containerId, items) {
  var container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<div class="empty-note">Nothing here.</div>';
    return;
  }
  items.forEach(function (i) {
    container.appendChild(buildInquiryCard(i));
  });
}

function buildInquiryCard(i) {
  var div = document.createElement('div');
  div.className = 'card is-inquiry' + (i.lastContactAttempt ? ' is-followed-up' : '');

  var metaParts = [];
  if (i.phone) metaParts.push(phoneMarkup(i.phone));
  if (i.email) metaParts.push(escapeHtml(i.email));
  if (i.desiredRentalDate) metaParts.push('Wants: ' + escapeHtml(i.desiredRentalDate));

  var badge = i.lastContactAttempt
    ? '<span class="badge">Followed Up ' + escapeHtml(i.lastContactAttemptDate) + '</span>'
    : '';

  var descHtml = i.description ? '<div class="card-notes">' + escapeHtml(i.description) + '</div>' : '';
  var notesHtml = i.notes
    ? '<details class="notes-details"><summary class="notes-summary">View note</summary>' +
      '<div class="card-notes existing-notes">' + escapeHtml(i.notes) + '</div></details>'
    : '';

  div.innerHTML =
    '<div class="card-body">' +
      '<div class="card-top">' +
        '<div><span class="card-name">' + escapeHtml(i.name || '(no name)') + '</span>' + badge + '</div>' +
        '<div class="card-date">' + escapeHtml(i.dateReceived) + '</div>' +
      '</div>' +
      '<div class="card-meta">' + metaParts.join(' &middot; ') + '</div>' +
      descHtml +
      notesHtml +
      '<div class="card-actions"></div>' +
    '</div>';

  var actions = div.querySelector('.card-actions');
  var btn = document.createElement('button');
  btn.className = 'action-btn call';
  btn.textContent = 'Log Contact';
  btn.onclick = function () { openInquiryModal(i.row, i.name); };
  actions.appendChild(btn);

  return div;
}

var modalOverlay = document.getElementById('inquiryModal');
var modalName = document.getElementById('modalName');
var modalNote = document.getElementById('modalNote');
var modalCloseInquiryBtn = document.getElementById('modalCloseInquiry');
var modalLeaveOpenBtn = document.getElementById('modalLeaveOpen');
var modalCancelBtn = document.getElementById('modalCancel');
var modalRow = null;

function openInquiryModal(row, name) {
  modalRow = row;
  modalName.textContent = name || '(no name)';
  modalNote.value = '';
  modalOverlay.style.display = 'flex';
}

function closeInquiryModal() {
  modalOverlay.style.display = 'none';
  modalRow = null;
}

function submitInquiryUpdate(close) {
  if (modalRow === null || inFlight['inq-' + modalRow]) return;
  var row = modalRow;
  var note = modalNote.value.trim();
  var key = 'inq-' + row;
  inFlight[key] = true;
  modalCloseInquiryBtn.disabled = true;
  modalLeaveOpenBtn.disabled = true;

  postAction({ action: 'updateInquiry', row: row, note: note, close: close })
    .then(function (res) {
      inFlight[key] = false;
      modalCloseInquiryBtn.disabled = false;
      modalLeaveOpenBtn.disabled = false;
      if (res.ok) {
        closeInquiryModal();
        renderDashboard(res.data);
      } else {
        showError(res.error);
      }
    })
    .catch(function (err) {
      inFlight[key] = false;
      modalCloseInquiryBtn.disabled = false;
      modalLeaveOpenBtn.disabled = false;
      showError(err.message || err);
    });
}

modalCloseInquiryBtn.addEventListener('click', function () { submitInquiryUpdate(true); });
modalLeaveOpenBtn.addEventListener('click', function () { submitInquiryUpdate(false); });
modalCancelBtn.addEventListener('click', closeInquiryModal);

var paymentModalOverlay = document.getElementById('paymentModal');
var paymentModalName = document.getElementById('paymentModalName');
var paymentAmountInput = document.getElementById('paymentAmount');
var paymentSubmitBtn = document.getElementById('paymentSubmit');
var paymentCancelBtn = document.getElementById('paymentCancel');
var paymentRow = null;

function openPaymentModal(row, name) {
  paymentRow = row;
  paymentModalName.textContent = name || '(no name)';
  paymentAmountInput.value = '';
  paymentModalOverlay.style.display = 'flex';
}

function closePaymentModal() {
  paymentModalOverlay.style.display = 'none';
  paymentRow = null;
}

paymentSubmitBtn.addEventListener('click', function () {
  if (paymentRow === null) return;
  var amount = paymentAmountInput.value.trim();
  if (!amount) {
    showError('Enter a payment amount before closing this booking.');
    return;
  }
  var row = paymentRow;
  var key = 'pay-' + row;
  if (inFlight[key]) return;
  inFlight[key] = true;
  paymentSubmitBtn.disabled = true;

  postAction({ action: 'completeBooking', row: row, amount: amount })
    .then(function (res) {
      inFlight[key] = false;
      paymentSubmitBtn.disabled = false;
      if (res.ok) {
        closePaymentModal();
        renderDashboard(res.data);
      } else {
        showError(res.error);
      }
    })
    .catch(function (err) {
      inFlight[key] = false;
      paymentSubmitBtn.disabled = false;
      showError(err.message || err);
    });
});

paymentCancelBtn.addEventListener('click', closePaymentModal);

var checkinStatusModalOverlay = document.getElementById('checkinStatusModal');
var checkinStatusName = document.getElementById('checkinStatusName');
var checkinStatusSummary = document.getElementById('checkinStatusSummary');
var checkinStatusGuestsWrap = document.getElementById('checkinStatusGuestsWrap');
var checkinStatusGuestList = document.getElementById('checkinStatusGuestList');
var checkinStatusCloseBtn = document.getElementById('checkinStatusClose');

function openCheckinStatusModal(b) {
  checkinStatusName.textContent = b.name || '(no name)';
  checkinStatusSummary.textContent = b.checkinCompleted
    ? 'Check-in completed ' + b.checkinCompletedDate
    : 'Check-in not yet completed.';
  checkinStatusGuestsWrap.style.display = 'none';
  checkinStatusGuestList.innerHTML = '';
  checkinStatusModalOverlay.style.display = 'flex';

  fetch(API_URL + '?action=getGuestCheckins&row=' + encodeURIComponent(b.row))
    .then(function (res) { return res.json(); })
    .then(function (res) {
      if (!res.ok) { showError(res.error); return; }
      if (!res.data.length) return;
      checkinStatusGuestsWrap.style.display = '';
      res.data.forEach(function (g) {
        var li = document.createElement('li');
        li.textContent = g.name + (g.date ? ' — ' + g.date : '');
        checkinStatusGuestList.appendChild(li);
      });
    })
    .catch(function (err) { showError(err.message || err); });
}

function closeCheckinStatusModal() {
  checkinStatusModalOverlay.style.display = 'none';
}

checkinStatusCloseBtn.addEventListener('click', closeCheckinStatusModal);

var chrisPaymentModalOverlay = document.getElementById('chrisPaymentModal');
var chrisPaymentModalText = document.getElementById('chrisPaymentModalText');
var chrisPaymentConfirmBtn = document.getElementById('chrisPaymentConfirm');
var chrisPaymentCancelBtn = document.getElementById('chrisPaymentCancel');
var chrisPaymentInFlight = false;

document.getElementById('chrisApplyPaymentBtn').addEventListener('click', function () {
  if (chrisPendingCount === 0) return;
  chrisPaymentModalText.textContent = 'This marks the oldest ' + chrisPendingCount +
    ' unpaid session' + (chrisPendingCount === 1 ? '' : 's') + ' as paid today.';
  chrisPaymentModalOverlay.style.display = 'flex';
});

chrisPaymentCancelBtn.addEventListener('click', function () {
  chrisPaymentModalOverlay.style.display = 'none';
});

chrisPaymentConfirmBtn.addEventListener('click', function () {
  if (chrisPaymentInFlight) return;
  chrisPaymentInFlight = true;
  chrisPaymentConfirmBtn.disabled = true;
  chrisPaymentConfirmBtn.textContent = 'Applying…';

  postAction({ action: 'applyChrisPayment' })
    .then(function (res) {
      chrisPaymentInFlight = false;
      chrisPaymentConfirmBtn.disabled = false;
      chrisPaymentConfirmBtn.textContent = 'Confirm — Mark Paid';
      if (res.ok) {
        chrisPaymentModalOverlay.style.display = 'none';
        renderDashboard(res.data);
      } else {
        showError(res.error);
      }
    })
    .catch(function (err) {
      chrisPaymentInFlight = false;
      chrisPaymentConfirmBtn.disabled = false;
      chrisPaymentConfirmBtn.textContent = 'Confirm — Mark Paid';
      showError(err.message || err);
    });
});

function formatCurrency(val) {
  if (val === null || val === undefined) return '—';
  var sign = val < 0 ? '-' : '';
  return sign + '$' + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(val) {
  if (val === null || val === undefined) return '—';
  return val.toFixed(0) + '%';
}

function gainLossClass(val, threshold) {
  if (val === null || val === undefined) return '';
  return val >= threshold ? 'cell-gain' : 'cell-loss';
}

function loadRevenue() {
  document.getElementById('revenueLoading').style.display = '';
  document.getElementById('revenueContent').style.display = 'none';
  document.getElementById('revenueErrorBox').style.display = 'none';

  fetch(API_URL + '?action=getRevenue')
    .then(function (res) { return res.json(); })
    .then(function (res) {
      if (res.ok) {
        renderRevenue(res.data);
      } else {
        showRevenueError(res.error);
      }
    })
    .catch(function (err) { showRevenueError(err.message || err); });
}

function showRevenueError(message) {
  document.getElementById('revenueLoading').style.display = 'none';
  var box = document.getElementById('revenueErrorBox');
  box.style.display = '';
  box.textContent = 'Could not load revenue data: ' + message;
}

function renderRevenue(data) {
  document.getElementById('revenueLoading').style.display = 'none';
  document.getElementById('revenueContent').style.display = '';
  document.getElementById('revenueYearLabel').textContent = data.currentYear;
  document.getElementById('thisYearHeader').textContent = data.currentYear;
  document.getElementById('lastYearHeader').textContent = data.lastYear;
  document.getElementById('qThisYearHeader').textContent = data.currentYear;
  document.getElementById('qLastYearHeader').textContent = data.lastYear;

  document.getElementById('statYtd').textContent = formatCurrency(data.ytdThisYear);
  document.getElementById('statAvg').textContent = formatCurrency(data.thisYearAvgSoFar);
  document.getElementById('statLastYearAvg').textContent = 'LY Avg: ' + formatCurrency(data.lastYearAvg);
  document.getElementById('statLastYearTotal').textContent = formatCurrency(data.lastYearTotal);

  var compEl = document.getElementById('statComparison');
  compEl.textContent = formatCurrency(data.ytdComparisonDiff) +
    (data.ytdComparisonPct === null ? '' : ' (' + formatPercent(data.ytdComparisonPct) + ')');
  compEl.className = 'stat-value ' + (data.ytdComparisonPct === null ? '' : (data.ytdComparisonPct >= 0 ? 'gain' : 'loss'));

  var now = new Date();
  var currentMonthIdx = (now.getFullYear() === data.currentYear) ? now.getMonth() : -1;

  var tbody = document.getElementById('revenueTableBody');
  tbody.innerHTML = '';
  data.months.forEach(function (m, idx) {
    var tr = document.createElement('tr');
    if (idx === currentMonthIdx) tr.className = 'current-month';
    tr.innerHTML =
      '<td>' + escapeHtml(m.name) + '</td>' +
      '<td>' + formatCurrency(m.thisYear) + '</td>' +
      '<td class="' + gainLossClass(m.pctOfPrevMonth, 100) + '">' + formatPercent(m.pctOfPrevMonth) + '</td>' +
      '<td class="' + gainLossClass(m.pctOfLYAvg, 100) + '">' + formatPercent(m.pctOfLYAvg) + '</td>' +
      '<td>' + formatCurrency(m.lastYear) + '</td>' +
      '<td class="' + gainLossClass(m.pctChange, 0) + '">' + formatPercent(m.pctChange) + '</td>';
    tbody.appendChild(tr);
  });

  var qBody = document.getElementById('quarterTableBody');
  qBody.innerHTML = '';
  data.quarters.forEach(function (q) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + escapeHtml(q.label) + '</td>' +
      '<td>' + formatCurrency(q.thisYear) + '</td>' +
      '<td>' + formatCurrency(q.lastYear) + '</td>' +
      '<td class="' + gainLossClass(q.pctChange, 0) + '">' + formatPercent(q.pctChange) + '</td>';
    qBody.appendChild(tr);
  });

  var c = data.categories;
  document.getElementById('catChrisYear').textContent = formatCurrency(c.chrisConnelly.year);
  document.getElementById('catChrisMonth').textContent = 'This Month: ' + formatCurrency(c.chrisConnelly.month);
  document.getElementById('catMonsterYear').textContent = formatCurrency(c.monsterProductions.year);
  document.getElementById('catMonsterMonth').textContent = 'This Month: ' + formatCurrency(c.monsterProductions.month);
  document.getElementById('catRentalsYear').textContent = formatCurrency(c.studioRentals.year);
  document.getElementById('catRentalsMonth').textContent = 'This Month: ' + formatCurrency(c.studioRentals.month);

  renderCategoryPie([
    { name: 'Chris Connelly', value: c.chrisConnelly.year, color: 'var(--cat-chris)' },
    { name: 'Monster Productions', value: c.monsterProductions.year, color: 'var(--cat-monster)' },
    { name: 'Studio Rentals', value: c.studioRentals.year, color: 'var(--cat-rentals)' },
  ]);

  var chartMonths = data.months.map(function (m, idx) {
    if (currentMonthIdx !== -1 && idx > currentMonthIdx) {
      return Object.assign({}, m, { thisYear: null });
    }
    return m;
  });
  renderIncomeChart(chartMonths, data.lastYearAvg);
  renderSinceOpeningChart(data.allMonths);
}

function polarToCartesian_(cx, cy, r, angleDeg) {
  var rad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function donutSlicePath_(cx, cy, rOuter, rInner, startAngle, endAngle) {
  var startOuter = polarToCartesian_(cx, cy, rOuter, endAngle);
  var endOuter = polarToCartesian_(cx, cy, rOuter, startAngle);
  var startInner = polarToCartesian_(cx, cy, rInner, endAngle);
  var endInner = polarToCartesian_(cx, cy, rInner, startAngle);
  var largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
  return [
    'M', startOuter.x, startOuter.y,
    'A', rOuter, rOuter, 0, largeArc, 0, endOuter.x, endOuter.y,
    'L', endInner.x, endInner.y,
    'A', rInner, rInner, 0, largeArc, 1, startInner.x, startInner.y,
    'Z',
  ].join(' ');
}

function renderCategoryPie(slices) {
  var svg = document.getElementById('categoryPie');
  var emptyEl = document.getElementById('categoryPieEmpty');
  var legendEl = document.getElementById('categoryPieLegend');
  svg.innerHTML = '';
  legendEl.innerHTML = '';

  var total = slices.reduce(function (sum, s) { return sum + Math.max(0, s.value || 0); }, 0);

  if (total <= 0) {
    svg.style.display = 'none';
    emptyEl.style.display = '';
  } else {
    svg.style.display = '';
    emptyEl.style.display = 'none';

    var cx = 110, cy = 110, rOuter = 100, rInner = 58;
    var gapDeg = 2;
    var angle = 0;
    var ns = 'http://www.w3.org/2000/svg';

    slices.forEach(function (s) {
      var value = Math.max(0, s.value || 0);
      var sweep = (value / total) * 360;
      if (value > 0 && sweep > gapDeg) {
        var start = angle + gapDeg / 2;
        var end = angle + sweep - gapDeg / 2;
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', donutSlicePath_(cx, cy, rOuter, rInner, start, end));
        path.setAttribute('fill', s.color);
        path.setAttribute('class', 'pie-slice');
        var title = document.createElementNS(ns, 'title');
        title.textContent = s.name + ': ' + formatCurrency(value) + ' (' + Math.round((value / total) * 100) + '%)';
        path.appendChild(title);
        svg.appendChild(path);
      }
      angle += sweep;
    });
  }

  slices.forEach(function (s) {
    var value = Math.max(0, s.value || 0);
    var pct = total > 0 ? Math.round((value / total) * 100) : 0;
    var li = document.createElement('li');
    li.innerHTML =
      '<span class="swatch" style="background:' + s.color + '"></span>' +
      '<span class="pie-legend-name">' + escapeHtml(s.name) + '</span>' +
      '<span class="pie-legend-value">' + formatCurrency(value) + '</span>' +
      '<span class="pie-legend-pct">' + pct + '%</span>';
    legendEl.appendChild(li);
  });
}

function linearRegression_(points) {
  var n = points.length;
  if (n < 2) return null;
  var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  points.forEach(function (p) {
    sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumXX += p.x * p.x;
  });
  var denom = (n * sumXX - sumX * sumX);
  if (denom === 0) return null;
  var slope = (n * sumXY - sumX * sumY) / denom;
  var intercept = (sumY - slope * sumX) / n;
  return { slope: slope, intercept: intercept };
}

function niceStep_(rawStep) {
  if (rawStep <= 0) return 1;
  var exponent = Math.floor(Math.log(rawStep) / Math.LN10);
  var fraction = rawStep / Math.pow(10, exponent);
  var niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * Math.pow(10, exponent);
}

function buildLinePath_(points) {
  var d = '';
  var drawing = false;
  points.forEach(function (p) {
    if (p === null) { drawing = false; return; }
    d += (drawing ? ' L ' : ' M ') + p.x + ' ' + p.y;
    drawing = true;
  });
  return d.trim();
}

function renderIncomeChart(months, lastYearAvg) {
  var svg = document.getElementById('incomeChart');
  var tooltip = document.getElementById('incomeTooltip');
  svg.innerHTML = '';
  var ns = 'http://www.w3.org/2000/svg';

  var W = 860, H = 320, padL = 60, padR = 20, padT = 20, padB = 30;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var n = months.length;

  var trend = linearRegression_(
    months.map(function (m, i) { return { x: i, y: m.thisYear }; }).filter(function (p) { return p.y !== null; })
  );
  var trendVals = trend ? months.map(function (m, i) { return trend.slope * i + trend.intercept; }) : null;

  var allVals = [];
  months.forEach(function (m) {
    if (m.thisYear !== null) allVals.push(m.thisYear);
    if (m.lastYear !== null) allVals.push(m.lastYear);
  });
  if (lastYearAvg !== null && lastYearAvg !== undefined) allVals.push(lastYearAvg);
  if (trendVals) allVals = allVals.concat(trendVals);
  if (!allVals.length) allVals = [0, 1];

  var rawMin = Math.min.apply(null, allVals.concat([0]));
  var rawMax = Math.max.apply(null, allVals);
  var step = niceStep_((rawMax - rawMin) / 5 || 1);
  var yMin = Math.floor(rawMin / step) * step;
  var yMax = Math.ceil(rawMax / step) * step;
  if (yMax === yMin) yMax = yMin + step;

  function xAt(i) { return padL + (i / (n - 1)) * plotW; }
  function yAt(v) { return padT + (1 - (v - yMin) / (yMax - yMin)) * plotH; }

  // Gridlines + y-axis labels
  for (var v = yMin; v <= yMax + 1e-9; v += step) {
    var gy = yAt(v);
    var line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
    line.setAttribute('y1', gy); line.setAttribute('y2', gy);
    line.setAttribute('class', Math.abs(v) < 1e-9 ? 'income-baseline' : 'income-gridline');
    svg.appendChild(line);

    var label = document.createElementNS(ns, 'text');
    label.setAttribute('x', padL - 8);
    label.setAttribute('y', gy + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'income-axis-label');
    label.textContent = '$' + Math.round(v).toLocaleString('en-US');
    svg.appendChild(label);
  }

  // X-axis month labels
  months.forEach(function (m, i) {
    var label = document.createElementNS(ns, 'text');
    label.setAttribute('x', xAt(i));
    label.setAttribute('y', H - padB + 18);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'income-axis-label');
    label.textContent = m.name.slice(0, 3);
    svg.appendChild(label);
  });

  function seriesPoints(key) {
    return months.map(function (m, i) { return m[key] === null ? null : { x: xAt(i), y: yAt(m[key]) }; });
  }

  var lastYearPath = document.createElementNS(ns, 'path');
  lastYearPath.setAttribute('d', buildLinePath_(seriesPoints('lastYear')));
  lastYearPath.setAttribute('class', 'income-line-lastyear');
  svg.appendChild(lastYearPath);

  if (lastYearAvg !== null && lastYearAvg !== undefined) {
    var avgPath = document.createElementNS(ns, 'path');
    avgPath.setAttribute('d', 'M ' + padL + ' ' + yAt(lastYearAvg) + ' L ' + (W - padR) + ' ' + yAt(lastYearAvg));
    avgPath.setAttribute('class', 'income-line-avg');
    svg.appendChild(avgPath);

    var avgLabel = document.createElementNS(ns, 'text');
    avgLabel.setAttribute('x', W - padR);
    avgLabel.setAttribute('y', yAt(lastYearAvg) - 6);
    avgLabel.setAttribute('text-anchor', 'end');
    avgLabel.setAttribute('class', 'income-avg-label');
    avgLabel.textContent = 'LY Avg';
    svg.appendChild(avgLabel);
  }

  if (trendVals) {
    var trendPath = document.createElementNS(ns, 'path');
    trendPath.setAttribute('d', 'M ' + xAt(0) + ' ' + yAt(trendVals[0]) + ' L ' + xAt(n - 1) + ' ' + yAt(trendVals[n - 1]));
    trendPath.setAttribute('class', 'income-line-trend');
    svg.appendChild(trendPath);
  }

  var thisYearPath = document.createElementNS(ns, 'path');
  thisYearPath.setAttribute('d', buildLinePath_(seriesPoints('thisYear')));
  thisYearPath.setAttribute('class', 'income-line-thisyear');
  svg.appendChild(thisYearPath);

  // Crosshair
  var crosshair = document.createElementNS(ns, 'line');
  crosshair.setAttribute('y1', padT);
  crosshair.setAttribute('y2', H - padB);
  crosshair.setAttribute('class', 'income-crosshair');
  svg.appendChild(crosshair);

  // Hover hit columns — one per month, full plot height
  months.forEach(function (m, i) {
    var colW = plotW / n;
    var rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', xAt(i) - colW / 2);
    rect.setAttribute('y', padT);
    rect.setAttribute('width', colW);
    rect.setAttribute('height', plotH);
    rect.setAttribute('class', 'income-hit-rect');

    rect.addEventListener('mouseenter', function () { showIncomeTooltip_(i); });
    rect.addEventListener('mousemove', function () { showIncomeTooltip_(i); });
    rect.addEventListener('mouseleave', function () {
      crosshair.style.opacity = 0;
      tooltip.style.display = 'none';
    });
    svg.appendChild(rect);
  });

  function showIncomeTooltip_(i) {
    var m = months[i];
    crosshair.setAttribute('x1', xAt(i));
    crosshair.setAttribute('x2', xAt(i));
    crosshair.style.opacity = 1;

    var rows = [
      { name: 'This Year', value: m.thisYear, color: 'var(--chart-thisyear)' },
      { name: 'Last Year', value: m.lastYear, color: 'var(--chart-lastyear)' },
    ];
    if (trendVals) rows.push({ name: 'Trend', value: trendVals[i], color: 'var(--chart-trend)' });
    if (lastYearAvg !== null && lastYearAvg !== undefined) rows.push({ name: 'LY Avg', value: lastYearAvg, color: 'var(--chart-avg)' });

    var html = '<div class="tt-month">' + escapeHtml(m.name) + '</div>';
    rows.forEach(function (r) {
      html += '<div class="tt-row"><span class="tt-key" style="background:' + r.color + '"></span>' +
        '<span class="tt-name">' + escapeHtml(r.name) + '</span>' +
        '<span class="tt-value">' + formatCurrency(r.value) + '</span></div>';
    });
    tooltip.innerHTML = html;
    tooltip.style.display = '';

    var svgRect = svg.getBoundingClientRect();
    var wrapRect = svg.parentElement.getBoundingClientRect();
    var scaleX = svgRect.width / W;
    var pxLeft = (xAt(i) * scaleX) + (svgRect.left - wrapRect.left);
    var tooltipWidth = tooltip.offsetWidth || 140;
    var left = pxLeft + 12;
    if (left + tooltipWidth > wrapRect.width) left = pxLeft - tooltipWidth - 12;
    tooltip.style.left = Math.max(0, left) + 'px';
    tooltip.style.top = '8px';
  }
}

function renderSinceOpeningChart(allMonths) {
  var svg = document.getElementById('sinceOpeningChart');
  var tooltip = document.getElementById('sinceOpeningTooltip');
  svg.innerHTML = '';
  if (!allMonths || !allMonths.length) return;
  var ns = 'http://www.w3.org/2000/svg';

  var W = 860, H = 320, padL = 60, padR = 20, padT = 20, padB = 30;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var n = allMonths.length;

  var trend = linearRegression_(allMonths.map(function (m, i) { return { x: i, y: m.value }; }));
  var trendVals = trend ? allMonths.map(function (m, i) { return trend.slope * i + trend.intercept; }) : null;

  var allVals = allMonths.map(function (m) { return m.value; });
  if (trendVals) allVals = allVals.concat(trendVals);

  var rawMin = Math.min.apply(null, allVals.concat([0]));
  var rawMax = Math.max.apply(null, allVals);
  var step = niceStep_((rawMax - rawMin) / 5 || 1);
  var yMin = Math.floor(rawMin / step) * step;
  var yMax = Math.ceil(rawMax / step) * step;
  if (yMax === yMin) yMax = yMin + step;

  function xAt(i) { return n > 1 ? padL + (i / (n - 1)) * plotW : padL + plotW / 2; }
  function yAt(v) { return padT + (1 - (v - yMin) / (yMax - yMin)) * plotH; }

  for (var v = yMin; v <= yMax + 1e-9; v += step) {
    var gy = yAt(v);
    var line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
    line.setAttribute('y1', gy); line.setAttribute('y2', gy);
    line.setAttribute('class', Math.abs(v) < 1e-9 ? 'income-baseline' : 'income-gridline');
    svg.appendChild(line);

    var label = document.createElementNS(ns, 'text');
    label.setAttribute('x', padL - 8);
    label.setAttribute('y', gy + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'income-axis-label');
    label.textContent = '$' + Math.round(v).toLocaleString('en-US');
    svg.appendChild(label);
  }

  var maxLabels = Math.max(1, Math.floor(plotW / 42));
  var labelSkip = Math.max(1, Math.ceil(n / maxLabels));
  allMonths.forEach(function (m, i) {
    var isTick = i % labelSkip === 0;
    var isLast = i === n - 1;
    if (!isTick && !isLast) return;
    if (isTick && !isLast && (n - 1 - i) < labelSkip) return;
    var label = document.createElementNS(ns, 'text');
    label.setAttribute('x', xAt(i));
    label.setAttribute('y', H - padB + 18);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'income-axis-label');
    label.textContent = m.label;
    svg.appendChild(label);
  });

  if (trendVals) {
    var trendPath = document.createElementNS(ns, 'path');
    trendPath.setAttribute('d', 'M ' + xAt(0) + ' ' + yAt(trendVals[0]) + ' L ' + xAt(n - 1) + ' ' + yAt(trendVals[n - 1]));
    trendPath.setAttribute('class', 'income-line-trend-mono');
    svg.appendChild(trendPath);
  }

  var actualPath = document.createElementNS(ns, 'path');
  actualPath.setAttribute('d', buildLinePath_(allMonths.map(function (m, i) { return { x: xAt(i), y: yAt(m.value) }; })));
  actualPath.setAttribute('class', 'income-line-thisyear');
  svg.appendChild(actualPath);

  var crosshair = document.createElementNS(ns, 'line');
  crosshair.setAttribute('y1', padT);
  crosshair.setAttribute('y2', H - padB);
  crosshair.setAttribute('class', 'income-crosshair');
  svg.appendChild(crosshair);

  var colW = plotW / n;
  allMonths.forEach(function (m, i) {
    var rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', xAt(i) - colW / 2);
    rect.setAttribute('y', padT);
    rect.setAttribute('width', colW);
    rect.setAttribute('height', plotH);
    rect.setAttribute('class', 'income-hit-rect');

    rect.addEventListener('mouseenter', function () { showSinceOpeningTooltip_(i); });
    rect.addEventListener('mousemove', function () { showSinceOpeningTooltip_(i); });
    rect.addEventListener('mouseleave', function () {
      crosshair.style.opacity = 0;
      tooltip.style.display = 'none';
    });
    svg.appendChild(rect);
  });

  function showSinceOpeningTooltip_(i) {
    var m = allMonths[i];
    crosshair.setAttribute('x1', xAt(i));
    crosshair.setAttribute('x2', xAt(i));
    crosshair.style.opacity = 1;

    var html = '<div class="tt-month">' + escapeHtml(m.label) + '</div>' +
      '<div class="tt-row"><span class="tt-key" style="background:var(--chart-thisyear)"></span>' +
      '<span class="tt-name">Gross</span>' +
      '<span class="tt-value">' + formatCurrency(m.value) + '</span></div>';
    if (trendVals) {
      html += '<div class="tt-row"><span class="tt-key" style="background:var(--chart-thisyear)"></span>' +
        '<span class="tt-name">Trend</span>' +
        '<span class="tt-value">' + formatCurrency(trendVals[i]) + '</span></div>';
    }
    tooltip.innerHTML = html;
    tooltip.style.display = '';

    var svgRect = svg.getBoundingClientRect();
    var wrapRect = svg.parentElement.getBoundingClientRect();
    var scaleX = svgRect.width / W;
    var pxLeft = (xAt(i) * scaleX) + (svgRect.left - wrapRect.left);
    var tooltipWidth = tooltip.offsetWidth || 140;
    var left = pxLeft + 12;
    if (left + tooltipWidth > wrapRect.width) left = pxLeft - tooltipWidth - 12;
    tooltip.style.left = Math.max(0, left) + 'px';
    tooltip.style.top = '8px';
  }
}

function loadStudioHealth() {
  document.getElementById('healthLoading').style.display = '';
  document.getElementById('healthContent').style.display = 'none';
  document.getElementById('healthErrorBox').style.display = 'none';

  fetch(API_URL + '?action=getStudioHealth')
    .then(function (res) { return res.json(); })
    .then(function (res) {
      if (res.ok) {
        renderStudioHealth(res.data);
      } else {
        showStudioHealthError(res.error);
      }
    })
    .catch(function (err) { showStudioHealthError(err.message || err); });
}

function showStudioHealthError(message) {
  document.getElementById('healthLoading').style.display = 'none';
  var box = document.getElementById('healthErrorBox');
  box.style.display = '';
  box.textContent = 'Could not load studio health: ' + message;
}

var HEALTH_STATUS_TEXT = { great: 'Great', okay: 'On Pace', low: 'Needs Attention', neutral: 'No Data Yet' };
var HEALTH_STATUS_ICON = { great: '▲', okay: '●', low: '▼', neutral: '–' };

function formatHealthValue_(metric) {
  if (metric.value === null || metric.value === undefined) return '—';
  return metric.isPercent ? Math.round(metric.value) + '%' : metric.value.toLocaleString('en-US');
}

function formatHealthBaseline_(metric) {
  if (metric.baseline === null || metric.baseline === undefined) return metric.baselineLabel + ': —';
  var baselineText = metric.isPercent ? Math.round(metric.baseline) + '%' : metric.baseline.toFixed(1);
  return metric.baselineLabel + ': ' + baselineText;
}

function renderStudioHealth(data) {
  document.getElementById('healthLoading').style.display = 'none';
  document.getElementById('healthContent').style.display = '';
  document.getElementById('healthMonthLabel').textContent = data.monthLabel;

  ['inquiries', 'rentals', 'uniqueCustomers', 'conversionRate', 'repeatCustomerRate'].forEach(function (key) {
    var metric = data[key];
    var tile = document.getElementById('healthTile-' + key);
    tile.className = 'health-tile tier-' + metric.tier;
    document.getElementById('health-' + key + '-value').textContent = formatHealthValue_(metric);
    var statusEl = document.getElementById('health-' + key + '-status');
    statusEl.className = 'health-status tier-' + metric.tier;
    statusEl.textContent = HEALTH_STATUS_ICON[metric.tier] + ' ' + HEALTH_STATUS_TEXT[metric.tier];
    document.getElementById('health-' + key + '-baseline').textContent = formatHealthBaseline_(metric);
  });
}

document.getElementById('refreshBtn').addEventListener('click', function () {
  loadDashboard();
  loadRevenue();
  loadStudioHealth();
});
loadStudioHealth();
loadDashboard();
loadRevenue();
