// PebbleKit JS — runs inside the Pebble phone app.
// Sends each dictated phrase to the backend /translate endpoint and returns the
// English translation to the watch. No API keys live here — the backend holds
// them. Each phrase is independent (no history): the watch loops dictation and
// we translate one utterance at a time for a rolling, live-ish transcript.
//
// Config + secrets live in secrets.js (gitignored). First run:
//   cp secrets.example.js secrets.js   and fill in your values.
var secrets = require('./secrets');
var BACKEND_URL = secrets.BACKEND_URL;       // e.g. https://your-app.up.railway.app/translate
var ASSISTANT_TOKEN = secrets.ASSISTANT_TOKEN;
var TARGET_LANG = secrets.TARGET_LANG || 'English';

var MAX_CHARS = 900;  // safety cap; translations are short (a phrase or two)
var CHUNK_SIZE = 200; // per-AppMessage chunk, well under the inbox

function sendToWatch(dict) {
  Pebble.sendAppMessage(
    dict,
    function () {},
    function (e) { console.log('send failed: ' + JSON.stringify(e)); }
  );
}

function sendTranslation(text) {
  text = String(text || '').trim();
  if (text.length > MAX_CHARS) text = text.substring(0, MAX_CHARS);
  var chunks = [];
  for (var i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.substr(i, CHUNK_SIZE));
  }
  if (chunks.length === 0) chunks.push('');
  sendChunk(chunks, 0);
}

// Pebble processes one AppMessage at a time, so send each chunk only after the
// previous is acked. `more` = 1 until the final chunk, so the watch knows when
// the full translation has arrived (and can resume listening).
function sendChunk(chunks, i) {
  var more = i < chunks.length - 1 ? 1 : 0;
  Pebble.sendAppMessage(
    { translation: chunks[i], more: more },
    function () { if (more) sendChunk(chunks, i + 1); },
    function (e) { console.log('chunk ' + i + ' send failed: ' + JSON.stringify(e)); }
  );
}

function sendError(msg) {
  sendToWatch({ error: String(msg).substring(0, 200) });
}

function translate(text) {
  if (!BACKEND_URL || BACKEND_URL.indexOf('YOUR-APP') !== -1) {
    sendError('Backend URL not set in secrets.js');
    return;
  }

  var xhr = new XMLHttpRequest();
  xhr.open('POST', BACKEND_URL, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  if (ASSISTANT_TOKEN) xhr.setRequestHeader('x-assistant-token', ASSISTANT_TOKEN);
  xhr.timeout = 20000; // translation is a single fast LLM call

  xhr.onload = function () {
    try {
      var data = JSON.parse(xhr.responseText);
      if (data.error) { sendError(data.error); return; }
      sendTranslation(data.translation);
    } catch (err) {
      sendError('Bad response from server');
    }
  };
  xhr.onerror = function () { sendError('Network error'); };
  xhr.ontimeout = function () { sendError('Timed out'); };

  xhr.send(JSON.stringify({ text: text, target: TARGET_LANG }));
}

Pebble.addEventListener('ready', function () {
  console.log('Pebble Translate pkjs ready');
});

Pebble.addEventListener('appmessage', function (e) {
  var text = e.payload.transcript;
  if (text) {
    console.log('phrase from watch: ' + text);
    translate(text);
  }
});
