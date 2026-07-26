// Copy this to secrets.js (gitignored) and fill in your values:
//   cp secrets.example.js secrets.js
module.exports = {
  BACKEND_URL: 'https://YOUR-APP.up.railway.app/translate',
  ASSISTANT_TOKEN: '',      // must match the server's ASSISTANT_TOKEN
  TARGET_LANG: 'English'    // translate everything the watch hears into this
};
