var API_URL = 'https://script.google.com/macros/s/AKfycbxBvB5Ew_NMCCr_gzJpF93hwj-Mzry1RqxxZFH-TPflwDPva6zSh_rmk2OClQ4QH9Io/exec';

var inFlight = {};

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  var bookedMetaParts = [];
  if (b.dateBooked) bookedMetaParts.push('Booked ' + escapeHtml(b.dateBooked));
  if (b.phone) bookedMetaParts.push(phoneMarkup(b.phone));

  var summary = document.createElement('div');
  summary.className = 'card-summary';
  summary.innerHTML =
    '<div class="card-top">' +
      '<div><span class="card-name">' + escapeHtml(b.name) + '</span>' + badge + '</div>' +
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
    if (e.target.closest('.phone-details')) return;
    var isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : '';
    summary.querySelector('.expand-caret').innerHTML = isOpen ? '&#9656;' : '&#9662;';
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
}

document.getElementById('refreshBtn').addEventListener('click', function () {
  loadDashboard();
  loadRevenue();
});
loadDashboard();
loadRevenue();
