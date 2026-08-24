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
  document.getElementById('calledCount').textContent = data.alreadyCalled.length;
  document.getElementById('inquiryCount').textContent = data.openInquiries.length;

  renderBookingList('needsCallList', data.needsCall, false);
  renderBookingList('calledList', data.alreadyCalled, true);
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

function buildBookingCard(b, isCalledList) {
  var div = document.createElement('div');
  div.className = 'card ' + (isCalledList ? 'is-called' : 'is-needs-call');

  var metaParts = [];
  if (b.eventType) metaParts.push(escapeHtml(b.eventType));
  if (b.location) metaParts.push(escapeHtml(b.location));
  if (b.phone) metaParts.push(phoneMarkup(b.phone));
  if (b.email) metaParts.push(escapeHtml(b.email));
  if (b.groupOver8) metaParts.push('Group over 8: ' + escapeHtml(b.groupOver8));
  if (b.lighting) metaParts.push('Lighting: ' + escapeHtml(b.lighting));
  if (b.needsHousePhotographer) metaParts.push('House photographer: ' + escapeHtml(b.needsHousePhotographer));
  if (b.totalPriceQuoted) metaParts.push('Quoted: ' + escapeHtml(b.totalPriceQuoted));

  var badge = b.isRegular ? '<span class="badge">Regular (' + b.bookingsCount + ')</span>' : '';
  var notesHtml = b.notes ? '<div class="card-notes">' + escapeHtml(b.notes) + '</div>' : '';
  var calledNoteHtml = isCalledList ? '<div class="called-note">Called ' + escapeHtml(b.dateCalled) + '</div>' : '';

  div.innerHTML =
    '<div class="card-top">' +
      '<div><span class="card-name">' + escapeHtml(b.name) + '</span>' + badge + '</div>' +
      '<div class="card-date">' + escapeHtml(b.eventDate) + (b.eventTime ? ' &middot; ' + escapeHtml(b.eventTime) : '') + '</div>' +
    '</div>' +
    '<div class="card-meta">' + metaParts.join(' &middot; ') + '</div>' +
    notesHtml +
    calledNoteHtml +
    '<div class="card-actions"></div>';

  var actions = div.querySelector('.card-actions');
  var btn = document.createElement('button');
  btn.className = 'action-btn ' + (isCalledList ? 'undo' : 'call');
  btn.textContent = isCalledList ? 'Undo' : 'Mark Called';
  btn.onclick = function () { toggleBooking(b.row, !isCalledList, btn); };
  actions.appendChild(btn);

  return div;
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
    '<div class="card-top">' +
      '<div><span class="card-name">' + escapeHtml(i.name || '(no name)') + '</span>' + badge + '</div>' +
      '<div class="card-date">' + escapeHtml(i.dateReceived) + '</div>' +
    '</div>' +
    '<div class="card-meta">' + metaParts.join(' &middot; ') + '</div>' +
    descHtml +
    notesHtml +
    '<div class="card-actions"></div>';

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

document.getElementById('refreshBtn').addEventListener('click', loadDashboard);
loadDashboard();
