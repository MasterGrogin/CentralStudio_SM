var API_URL = 'https://script.google.com/macros/s/AKfycbxBvB5Ew_NMCCr_gzJpF93hwj-Mzry1RqxxZFH-TPflwDPva6zSh_rmk2OClQ4QH9Io/exec';

var TILES = [
  { key: 'idFront', label: 'Photo ID — Front' },
  { key: 'idBack', label: 'Photo ID — Back' },
  { key: 'cardFront', label: 'Credit Card — Front' },
  { key: 'cardBack', label: 'Credit Card — Back' }
];

// Keeps the actual photo blob out of the DOM/state object printed anywhere —
// tileState only ever holds what's needed to render + retry, never gets logged.
var tileState = {};
var rentalRow = null;
var checkinCompleteNotified = false;

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getParams_() {
  var params = new URLSearchParams(window.location.search);
  return {
    row: params.get('row'),
    name: params.get('name') || '',
    date: params.get('date') || '',
    time: params.get('time') || '',
    lastCheckin: params.get('lastCheckin') || ''
  };
}

function init() {
  var params = getParams_();
  if (!params.row || isNaN(parseInt(params.row, 10))) {
    document.getElementById('checkinMissingRow').style.display = '';
    return;
  }
  rentalRow = params.row;

  document.getElementById('checkinBody').style.display = '';
  document.getElementById('checkinName').textContent = params.name || '(no name on file)';
  document.getElementById('checkinDate').textContent =
    params.date + (params.time ? ' · ' + params.time : '');

  if (params.lastCheckin) {
    var lastCheckinNote = document.getElementById('checkinLastNote');
    lastCheckinNote.textContent = 'ID/card last on file: ' + params.lastCheckin + ' — may not need to be redone today.';
    lastCheckinNote.style.display = '';
  }

  var grid = document.getElementById('checkinGrid');
  TILES.forEach(function (tile) {
    tileState[tile.key] = { status: 'empty', blob: null, previewUrl: null, errorMsg: '' };
    grid.appendChild(buildTile(tile));
    renderTile(tile.key);
  });
}

function buildTile(tile) {
  var wrap = document.createElement('div');
  wrap.className = 'checkin-tile';
  wrap.id = 'tile-' + tile.key;

  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
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
  inner.addEventListener('click', function () {
    var state = tileState[tile.key];
    if (state.status === 'uploading') return;
    input.click();
  });

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

  inner.classList.remove('is-empty', 'is-uploading', 'is-success', 'is-error');

  if (state.status === 'empty') {
    inner.classList.add('is-empty');
    inner.innerHTML = '<div class="checkin-tile-placeholder">' + PLACEHOLDER_ICON + '<span>Tap to take photo</span></div>';
    status.innerHTML = '';
    return;
  }

  var thumb = '<img class="checkin-thumb" src="' + state.previewUrl + '" alt="">';

  if (state.status === 'uploading') {
    inner.classList.add('is-uploading');
    inner.innerHTML = thumb + '<div class="checkin-tile-overlay">Uploading…</div>';
    status.innerHTML = '';
  } else if (state.status === 'success') {
    inner.classList.add('is-success');
    inner.innerHTML = thumb;
    status.innerHTML =
      '<span class="checkin-status-ok">Uploaded</span>' +
      '<button type="button" class="checkin-retake-btn" data-key="' + key + '">Retake</button>';
    status.querySelector('.checkin-retake-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      resetTile(key);
    });
  } else if (state.status === 'error') {
    inner.classList.add('is-error');
    inner.innerHTML = thumb + '<div class="checkin-tile-overlay checkin-tile-overlay-error">Upload failed</div>';
    status.innerHTML =
      '<span class="checkin-status-fail">' + escapeHtml(state.errorMsg || 'Upload failed') + '</span>' +
      '<button type="button" class="checkin-retry-btn" data-key="' + key + '">Retry</button>' +
      '<button type="button" class="checkin-retake-btn" data-key="' + key + '">Retake</button>';
    status.querySelector('.checkin-retry-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      uploadTile(key);
    });
    status.querySelector('.checkin-retake-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      resetTile(key);
    });
  }
}

function resetTile(key) {
  var state = tileState[key];
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  tileState[key] = { status: 'empty', blob: null, previewUrl: null, errorMsg: '' };
  renderTile(key);
  updateDoneBanner();
}

// Downscales/recompresses on-device before upload — phone camera photos can
// run 4-8MB, and this is going over whatever wifi/cellular connection the
// front-desk device has at check-in. Keeps the actual card/ID contents fully
// legible while making the upload fast and reliable.
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
    state.status = 'uploading';
    state.errorMsg = '';
    renderTile(key);
    uploadTile(key);
  }).catch(function (err) {
    var state = tileState[key];
    state.status = 'error';
    state.errorMsg = err.message || 'Could not process photo';
    renderTile(key);
  });
}

function uploadTile(key) {
  var state = tileState[key];
  if (!state.blob) return;
  state.status = 'uploading';
  state.errorMsg = '';
  renderTile(key);

  blobToBase64_(state.blob).then(function (base64) {
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'uploadCheckinPhoto',
        row: parseInt(rentalRow, 10),
        photoType: key,
        mimeType: 'image/jpeg',
        dataBase64: base64
      })
    });
  }).then(function (res) { return res.json(); })
    .then(function (res) {
      var s = tileState[key];
      if (res.ok) {
        s.status = 'success';
      } else {
        s.status = 'error';
        s.errorMsg = res.error || 'Upload failed';
      }
      renderTile(key);
      updateDoneBanner();
    }).catch(function (err) {
      var s = tileState[key];
      s.status = 'error';
      s.errorMsg = err.message || 'Network error';
      renderTile(key);
      updateDoneBanner();
    });
}

function updateDoneBanner() {
  var allDone = TILES.every(function (t) { return tileState[t.key].status === 'success'; });
  document.getElementById('checkinDoneBanner').style.display = allDone ? '' : 'none';
  if (allDone && !checkinCompleteNotified) {
    checkinCompleteNotified = true;
    notifyCheckinComplete_();
  }
}

// Records "when we last had this renter's ID/card on file" for next time.
// Best-effort: the photos are already safely uploaded by the time this runs,
// so a failure here doesn't affect check-in itself — it just means the
// "last on file" note won't be up to date on their next visit.
function notifyCheckinComplete_() {
  fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'markCheckinComplete', row: parseInt(rentalRow, 10) })
  }).catch(function () {});
}

init();
