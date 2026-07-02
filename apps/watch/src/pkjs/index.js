// PebbleKit JS — runs inside the Pebble phone app.
// Sends the dictated question to the Pebble Assistant backend and returns the
// answer to the watch. No API keys live here anymore — the backend holds them.
//
// Config + secrets live in secrets.js (gitignored). First run:
//   cp secrets.example.js secrets.js   and fill in your values.
var secrets = require('./secrets');
var BACKEND_URL = secrets.BACKEND_URL;
var ASSISTANT_TOKEN = secrets.ASSISTANT_TOKEN;

var MAX_ANSWER_CHARS = 2000; // must stay under the watch inbox buffer

// Conversation history (prior turns) for multi-turn context. Reset when the
// watch sends reset=1 (new conversation).
var history = [];
var MAX_HISTORY = 12; // messages kept (~6 turns)

function sendToWatch(dict) {
  Pebble.sendAppMessage(
    dict,
    function () { console.log('sent to watch: ' + JSON.stringify(dict)); },
    function (e) { console.log('send failed: ' + JSON.stringify(e)); }
  );
}

function sendResponse(text) {
  if (!text) text = '(empty response)';
  text = String(text).trim();
  if (text.length > MAX_ANSWER_CHARS) {
    text = text.substring(0, MAX_ANSWER_CHARS - 3) + '...';
  }
  sendToWatch({ response: text });
}

function sendError(msg) {
  sendToWatch({ error: String(msg).substring(0, 200) });
}

function ask(question) {
  if (BACKEND_URL.indexOf('YOUR-APP') !== -1) {
    sendError('Backend URL not set in index.js');
    return;
  }

  var xhr = new XMLHttpRequest();
  xhr.open('POST', BACKEND_URL, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  if (ASSISTANT_TOKEN) xhr.setRequestHeader('x-assistant-token', ASSISTANT_TOKEN);
  xhr.timeout = 45000; // tool calls can take a while

  xhr.onload = function () {
    try {
      var data = JSON.parse(xhr.responseText);
      if (data.error) { sendError(data.error); return; }
      var answer = data.response;
      // Record the turn so the next question has context.
      history.push({ role: 'user', content: question });
      history.push({ role: 'assistant', content: String(answer) });
      if (history.length > MAX_HISTORY) {
        history = history.slice(history.length - MAX_HISTORY);
      }
      sendResponse(answer);
    } catch (err) {
      sendError('Bad response from server');
    }
  };
  xhr.onerror = function () { sendError('Network error'); };
  xhr.ontimeout = function () { sendError('Request timed out'); };

  // Send prior history (not incl. the current question).
  xhr.send(JSON.stringify({ question: question, history: history }));
}

Pebble.addEventListener('ready', function () {
  console.log('Pebble Assistant pkjs ready');
});

Pebble.addEventListener('appmessage', function (e) {
  if (e.payload.reset) {
    history = [];
    console.log('conversation reset (new)');
  }
  var question = e.payload.prompt;
  console.log('question from watch: ' + question + ' (history len ' + history.length + ')');
  if (question) ask(question);
});
