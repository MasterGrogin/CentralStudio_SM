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
var extraIdCount = 0;

var WAIVER_REQUIRED_FIELDS = ['waiverName', 'waiverAddress', 'waiverCity', 'waiverState', 'waiverZip', 'waiverPhone', 'waiverEmail'];
var agreementSigPad = null;
var waiverSigPad = null;
var waiverSubmitting = false;
var waiverSubmitted = false;

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

  if (params.name) {
    var nameInput = document.getElementById('waiverName');
    if (nameInput) nameInput.value = params.name;
  }

  var grid = document.getElementById('checkinGrid');
  TILES.forEach(function (tile) {
    tileState[tile.key] = { status: 'empty', blob: null, previewUrl: null, errorMsg: '' };
    grid.appendChild(buildTile(tile));
    renderTile(tile.key);
  });

  document.getElementById('addIdBtn').addEventListener('click', addAnotherId);

  initWaiver();
  updateSubmitState();
  loadCheckinOnFile_();
  initGuestLink_(params);
}

// Builds the shareable guest-checkin link (same booking row, so guest ID
// photos land in this booking's Drive folder) and wires up the Share button
// — Web Share API where available (so it drops straight into Messages/etc.
// on a phone), falling back to a copy-to-clipboard text field on devices/
// browsers that don't support navigator.share.
function initGuestLink_(params) {
  var guestQuery = '?row=' + encodeURIComponent(rentalRow) +
    '&name=' + encodeURIComponent(params.name) +
    '&date=' + encodeURIComponent(params.date) +
    '&time=' + encodeURIComponent(params.time);
  var guestUrl = new URL('guest-checkin.html' + guestQuery, window.location.href).toString();

  var shareBtn = document.getElementById('shareGuestLinkBtn');
  var fallback = document.getElementById('guestLinkFallback');
  var input = document.getElementById('guestLinkInput');
  var copyBtn = document.getElementById('copyGuestLinkBtn');

  shareBtn.addEventListener('click', function () {
    if (navigator.share) {
      navigator.share({
        title: 'Central Studio Guest Check-In',
        text: 'Upload your ID for our studio session:',
        url: guestUrl
      }).catch(function () { /* user cancelled share — nothing to do */ });
      return;
    }
    input.value = guestUrl;
    fallback.style.display = '';
    input.focus();
    input.select();
  });

  copyBtn.addEventListener('click', function () {
    var restore = 'Copy';
    function showCopied() {
      copyBtn.textContent = 'Copied!';
      setTimeout(function () { copyBtn.textContent = restore; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(guestUrl).then(showCopied).catch(function () {
        input.select();
        try { document.execCommand('copy'); showCopied(); } catch (err) { /* manual select/copy still works */ }
      });
    } else {
      input.select();
      try { document.execCommand('copy'); showCopied(); } catch (err) { /* manual select/copy still works */ }
    }
  });
}

// Looks up whether this customer already has a still-valid (<=6 months old)
// ID/credit card photo on file from a prior visit — matched server-side by
// email + name on the booking row itself, never by anything in the URL.
// Runs after tiles are already rendered/usable so a slow or failed lookup
// never blocks check-in: matching tiles just upgrade from "empty" to
// "on file" in place, each still individually replaceable via its own
// Update button.
function loadCheckinOnFile_() {
  return fetch(API_URL + '?action=getCheckinOnFile&row=' + encodeURIComponent(rentalRow))
    .then(function (res) { return res.json(); })
    .then(function (res) {
      if (!res.ok || !res.data || !res.data.tiles) return;
      var onFile = res.data;
      var matchedAny = false;
      TILES.forEach(function (tile) {
        var match = onFile.tiles[tile.key];
        var state = tileState[tile.key];
        if (!match || !state || state.status !== 'empty') return;
        matchedAny = true;
        state.status = 'onfile';
        state.onFileDate = onFile.dateLabel;
        renderTile(tile.key);
      });
      if (matchedAny) {
        var note = document.getElementById('checkinLastNote');
        note.textContent = 'ID/credit card on file from ' + onFile.dateLabel +
          ' — tap a photo below to update it, otherwise it will be reused for today\'s check-in.';
        note.style.display = '';
        updateSubmitState();
      }
    })
    .catch(function () {
      // Silent — check-in still works fine with a normal blank capture flow.
    });
}

// Group rentals / multiple renters on one booking sometimes need more than
// one ID captured. Each press adds one more front/back pair, numbered from
// #2 (the original pair is the implicit #1). Keys match the idFront_N /
// idBack_N pattern uploadCheckinPhoto's filename resolver expects.
function addAnotherId() {
  extraIdCount++;
  var n = extraIdCount + 1;
  var grid = document.getElementById('checkinGrid');
  [
    { key: 'idFront_' + n, label: 'Photo ID #' + n + ' — Front' },
    { key: 'idBack_' + n, label: 'Photo ID #' + n + ' — Back' }
  ].forEach(function (tile) {
    TILES.push(tile);
    tileState[tile.key] = { status: 'empty', blob: null, previewUrl: null, errorMsg: '' };
    grid.appendChild(buildTile(tile));
    renderTile(tile.key);
  });
  updateSubmitState();
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

  inner.classList.remove('is-empty', 'is-uploading', 'is-success', 'is-error', 'is-onfile');

  if (state.status === 'empty') {
    inner.classList.add('is-empty');
    inner.innerHTML = '<div class="checkin-tile-placeholder">' + PLACEHOLDER_ICON + '<span>Tap to take photo or upload</span></div>';
    status.innerHTML = '';
    return;
  }

  if (state.status === 'onfile') {
    inner.classList.add('is-onfile');
    inner.innerHTML = '<div class="checkin-tile-placeholder">' + PLACEHOLDER_ICON + '<span>On file</span></div>';
    status.innerHTML =
      '<span class="checkin-status-onfile">On file' + (state.onFileDate ? ' since ' + escapeHtml(state.onFileDate) : '') + '</span>' +
      '<button type="button" class="checkin-retake-btn" data-key="' + key + '">Update</button>';
    status.querySelector('.checkin-retake-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      resetTile(key);
    });
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
  updateSubmitState();
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
      updateSubmitState();
    }).catch(function (err) {
      var s = tileState[key];
      s.status = 'error';
      s.errorMsg = err.message || 'Network error';
      renderTile(key);
      updateSubmitState();
    });
}

function allPhotosUploaded_() {
  return TILES.every(function (t) {
    var status = tileState[t.key].status;
    return status === 'success' || status === 'onfile';
  });
}

function tilesKeptOnFile_() {
  return TILES.filter(function (t) { return tileState[t.key].status === 'onfile'; })
    .map(function (t) { return t.key; });
}

function waiverFieldsValid_() {
  return WAIVER_REQUIRED_FIELDS.every(function (id) {
    var el = document.getElementById(id);
    return el && el.value.trim() !== '';
  });
}

// Gates the Complete Check-In button on every requirement at once: every
// photo tile uploaded, every required waiver field filled in, and ink on
// both signature pads. Safe to call liberally — it's just a disabled-state
// check.
function updateSubmitState() {
  var btn = document.getElementById('completeCheckinBtn');
  if (!btn || waiverSubmitted) return;
  btn.disabled = !(allPhotosUploaded_() && waiverFieldsValid_() &&
    agreementSigPad.hasInk() && waiverSigPad.hasInk());
}

// One agreement, two separate signature blocks (Rental Agreement and Waiver
// of Liability, matching the original two-signature paper form) — this
// builds one canvas-based pad and returns handles to it rather than
// duplicating the drawing/resize/clear logic per canvas.
function createSigPad_(canvasId, placeholderId, clearBtnId) {
  var canvas = document.getElementById(canvasId);
  var placeholder = document.getElementById(placeholderId);
  var ctx = null;
  var hasInk = false;
  var drawing = false;

  function resize() {
    var ratio = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var hadInk = hasInk;
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1f2a33';
    // Resizing (e.g. an orientation change) wipes canvas pixels — best
    // effort, matches how most signature pads behave. Flag it so the submit
    // button doesn't stay enabled on a signature that's no longer there.
    if (hadInk) {
      hasInk = false;
      if (placeholder) placeholder.style.display = '';
      updateSubmitState();
    }
  }

  function pointFromEvent(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function startDraw(e) {
    e.preventDefault();
    drawing = true;
    // Pointer capture keeps this element getting move/up events for this
    // pointer even if it strays outside the canvas mid-stroke — a mouse
    // drag is far less precise than a finger and routinely dips a pixel or
    // two out of a canvas this short, which would otherwise cut the
    // stroke off right there.
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    var p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function moveDraw(e) {
    if (!drawing) return;
    e.preventDefault();
    var p = pointFromEvent(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!hasInk) {
      hasInk = true;
      if (placeholder) placeholder.style.display = 'none';
      updateSubmitState();
    }
  }
  function endDraw() { drawing = false; }

  resize();
  window.addEventListener('resize', resize);
  // Pointer Events cover mouse, touch and pen through one API instead of
  // separate mouse/touch handlers.
  canvas.addEventListener('pointerdown', startDraw);
  canvas.addEventListener('pointermove', moveDraw);
  canvas.addEventListener('pointerup', endDraw);
  canvas.addEventListener('pointercancel', endDraw);

  document.getElementById(clearBtnId).addEventListener('click', function () {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
    if (placeholder) placeholder.style.display = '';
    updateSubmitState();
  });

  return {
    hasInk: function () { return hasInk; },
    toBase64: function () { return canvas.toDataURL('image/png').split(',')[1]; }
  };
}

function initWaiver() {
  agreementSigPad = createSigPad_('agreementSigCanvas', 'agreementSigPlaceholder', 'agreementSigClear');
  waiverSigPad = createSigPad_('waiverSigCanvas', 'waiverSigPlaceholder', 'waiverSigClear');

  WAIVER_REQUIRED_FIELDS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', updateSubmitState);
  });

  document.getElementById('completeCheckinBtn').addEventListener('click', submitWaiver);
}

function submitWaiver() {
  if (waiverSubmitting || waiverSubmitted) return;
  var errorBox = document.getElementById('checkinWaiverError');
  errorBox.style.display = 'none';

  if (!allPhotosUploaded_()) {
    errorBox.textContent = 'Upload all ID and credit card photos before completing check-in.';
    errorBox.style.display = '';
    return;
  }
  if (!waiverFieldsValid_()) {
    errorBox.textContent = 'Please fill in all required fields.';
    errorBox.style.display = '';
    return;
  }
  if (!agreementSigPad.hasInk()) {
    errorBox.textContent = 'Please sign the Rental Agreement signature box.';
    errorBox.style.display = '';
    return;
  }
  if (!waiverSigPad.hasInk()) {
    errorBox.textContent = 'Please sign the Waiver of Liability signature box.';
    errorBox.style.display = '';
    return;
  }

  waiverSubmitting = true;
  var btn = document.getElementById('completeCheckinBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  var payload = {
    action: 'submitCheckinWaiver',
    row: parseInt(rentalRow, 10),
    keepOnFile: tilesKeptOnFile_(),
    name: document.getElementById('waiverName').value.trim(),
    company: document.getElementById('waiverCompany').value.trim(),
    address: document.getElementById('waiverAddress').value.trim(),
    city: document.getElementById('waiverCity').value.trim(),
    state: document.getElementById('waiverState').value.trim(),
    zip: document.getElementById('waiverZip').value.trim(),
    phone: document.getElementById('waiverPhone').value.trim(),
    email: document.getElementById('waiverEmail').value.trim(),
    agreementSignatureBase64: agreementSigPad.toBase64(),
    waiverSignatureBase64: waiverSigPad.toBase64()
  };

  fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(function (res) { return res.json(); })
    .then(function (res) {
      waiverSubmitting = false;
      if (res.ok) {
        waiverSubmitted = true;
        btn.textContent = 'Check-In Complete';
        lockCheckinForm_();
        document.getElementById('checkinDoneBanner').style.display = '';
      } else {
        btn.disabled = false;
        btn.textContent = 'Complete Check-In';
        errorBox.textContent = res.error || 'Submission failed. Please try again.';
        errorBox.style.display = '';
      }
    }).catch(function (err) {
      waiverSubmitting = false;
      btn.disabled = false;
      btn.textContent = 'Complete Check-In';
      errorBox.textContent = err.message || 'Network error. Please try again.';
      errorBox.style.display = '';
    });
}

function lockCheckinForm_() {
  var section = document.getElementById('checkinWaiverSection');
  section.querySelectorAll('input, textarea, button').forEach(function (el) {
    el.disabled = true;
  });
}

init();
