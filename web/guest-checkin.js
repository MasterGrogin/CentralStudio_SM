var API_URL = 'https://script.google.com/macros/s/AKfycbxBvB5Ew_NMCCr_gzJpF93hwj-Mzry1RqxxZFH-TPflwDPva6zSh_rmk2OClQ4QH9Io/exec';

var TILES = [
  { key: 'idFront', label: 'Photo ID — Front' },
  { key: 'idBack', label: 'Photo ID — Back' }
];

var REQUIRED_FIELDS = ['guestFirstName', 'guestLastName', 'guestEmail', 'guestPhone'];

// Keeps the actual photo blob out of anything printed/logged — same
// convention as checkin.js.
var tileState = {};
var rentalRow = null;
var submitting = false;
var submitted = false;

function getParams_() {
  var params = new URLSearchParams(window.location.search);
  return {
    row: params.get('row'),
    name: params.get('name') || '',
    date: params.get('date') || '',
    time: params.get('time') || ''
  };
}

function init() {
  var params = getParams_();
  if (!params.row || isNaN(parseInt(params.row, 10))) {
    document.getElementById('guestMissingRow').style.display = '';
    return;
  }
  rentalRow = params.row;

  document.getElementById('guestBody').style.display = '';
  document.getElementById('guestSummaryName').textContent = params.name ? 'Guest of ' + params.name : 'Guest Check-in';
  document.getElementById('guestSummaryDate').textContent =
    params.date + (params.time ? ' · ' + params.time : '');

  var grid = document.getElementById('guestGrid');
  TILES.forEach(function (tile) {
    tileState[tile.key] = { blob: null, previewUrl: null };
    grid.appendChild(buildTile(tile));
    renderTile(tile.key);
  });

  REQUIRED_FIELDS.forEach(function (id) {
    document.getElementById(id).addEventListener('input', updateSubmitState);
  });

  document.getElementById('completeGuestBtn').addEventListener('click', submitGuestCheckin);
}

function buildTile(tile) {
  var wrap = document.createElement('div');
  wrap.className = 'checkin-tile';
  wrap.id = 'tile-' + tile.key;

  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.hidden = true;
  input.id = 'input-' + tile.key;
  input.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    input.value = '';
    if (file) handlePhotoSelected(tile.key, file);
  });

  var inner = document.createElement('div');
  inner.className = 'checkin-tile-inner';
  inner.id = 'inner-' + tile.key;
  inner.addEventListener('click', function () { input.click(); });

  var label = document.createElement('div');
  label.className = 'checkin-tile-label';
  label.textContent = tile.label;

  var status = document.createElement('div');
  status.className = 'checkin-tile-status';
  status.id = 'status-' + tile.key;

  wrap.appendChild(input);
  wrap.appendChild(inner);
  wrap.appendChild(label);
  wrap.appendChild(status);

  return wrap;
}

var PLACEHOLDER_ICON =
  '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6">' +
  '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>' +
  '<circle cx="12" cy="14" r="3.3"/></svg>';

function renderTile(key) {
  var state = tileState[key];
  var inner = document.getElementById('inner-' + key);
  var status = document.getElementById('status-' + key);

  inner.classList.remove('is-empty', 'is-success');

  if (!state.blob) {
    inner.classList.add('is-empty');
    inner.innerHTML = '<div class="checkin-tile-placeholder">' + PLACEHOLDER_ICON + '<span>Tap to take photo or upload</span></div>';
    status.innerHTML = '';
    return;
  }

  inner.classList.add('is-success');
  inner.innerHTML = '<img class="checkin-thumb" src="' + state.previewUrl + '" alt="">';
  status.innerHTML =
    '<span class="checkin-status-ok">Ready</span>' +
    '<button type="button" class="checkin-retake-btn" data-key="' + key + '">Retake</button>';
  status.querySelector('.checkin-retake-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    resetTile(key);
  });
}

function resetTile(key) {
  var state = tileState[key];
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  tileState[key] = { blob: null, previewUrl: null };
  renderTile(key);
  updateSubmitState();
}

// Downscales/recompresses on-device before upload — same reasoning as
// checkin.js: phone camera photos run 4-8MB and this may be going over a
// slow connection.
function compressPhoto_(file) {
  var MAX_DIM = 1600;
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var objectUrl = URL.createObjectURL(file);
    img.onload = function () {
      var scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      var w = Math.round(img.width * scale);
      var h = Math.round(img.height * scale);
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(function (blob) {
        URL.revokeObjectURL(objectUrl);
        if (blob) resolve(blob); else reject(new Error('Could not process photo'));
      }, 'image/jpeg', 0.82);
    };
    img.onerror = function () {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read photo'));
    };
    img.src = objectUrl;
  });
}

function blobToBase64_(blob) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      resolve(dataUrl.substring(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = function () { reject(new Error('Could not read photo')); };
    reader.readAsDataURL(blob);
  });
}

function handlePhotoSelected(key, file) {
  compressPhoto_(file).then(function (blob) {
    var state = tileState[key];
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.blob = blob;
    state.previewUrl = URL.createObjectURL(blob);
    renderTile(key);
    updateSubmitState();
  }).catch(function (err) {
    var errorBox = document.getElementById('guestError');
    errorBox.textContent = err.message || 'Could not process photo';
    errorBox.style.display = '';
  });
}

function fieldsValid_() {
  return REQUIRED_FIELDS.every(function (id) {
    return document.getElementById(id).value.trim() !== '';
  });
}

function photosReady_() {
  return TILES.every(function (t) { return !!tileState[t.key].blob; });
}

function updateSubmitState() {
  var btn = document.getElementById('completeGuestBtn');
  if (!btn || submitted) return;
  btn.disabled = !(fieldsValid_() && photosReady_());
}

function submitGuestCheckin() {
  if (submitting || submitted) return;
  var errorBox = document.getElementById('guestError');
  errorBox.style.display = 'none';

  if (!fieldsValid_()) {
    errorBox.textContent = 'Please fill in your first name, last name, email, and phone.';
    errorBox.style.display = '';
    return;
  }
  if (!photosReady_()) {
    errorBox.textContent = 'Please upload both sides of your photo ID.';
    errorBox.style.display = '';
    return;
  }

  submitting = true;
  var btn = document.getElementById('completeGuestBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  Promise.all([
    blobToBase64_(tileState.idFront.blob),
    blobToBase64_(tileState.idBack.blob)
  ]).then(function (results) {
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'submitGuestCheckin',
        row: parseInt(rentalRow, 10),
        firstName: document.getElementById('guestFirstName').value.trim(),
        lastName: document.getElementById('guestLastName').value.trim(),
        email: document.getElementById('guestEmail').value.trim(),
        phone: document.getElementById('guestPhone').value.trim(),
        mimeType: 'image/jpeg',
        idFrontBase64: results[0],
        idBackBase64: results[1]
      })
    });
  }).then(function (res) { return res.json(); })
    .then(function (res) {
      submitting = false;
      if (res.ok) {
        submitted = true;
        btn.textContent = 'Check-In Complete';
        lockGuestForm_();
        document.getElementById('guestDoneBanner').style.display = '';
      } else {
        btn.disabled = false;
        btn.textContent = 'Complete Guest Check-In';
        errorBox.textContent = res.error || 'Submission failed. Please try again.';
        errorBox.style.display = '';
      }
    }).catch(function (err) {
      submitting = false;
      btn.disabled = false;
      btn.textContent = 'Complete Guest Check-In';
      errorBox.textContent = err.message || 'Network error. Please try again.';
      errorBox.style.display = '';
    });
}

function lockGuestForm_() {
  document.getElementById('guestBody').querySelectorAll('input, button').forEach(function (el) {
    el.disabled = true;
  });
}

init();
