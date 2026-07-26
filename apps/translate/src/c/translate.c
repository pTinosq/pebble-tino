#include <pebble.h>

// "Translate" — live-ish translation on your wrist.
//
// Press SELECT to start listening. The watch dictates each phrase it hears,
// the phone sends it to the backend, and the translation is appended to a
// rolling transcript. After each phrase it AUTOMATICALLY starts listening
// again, so a whole conversation streams in phrase-by-phrase without pressing a
// button each time. Press SELECT again to pause.
//
// LANGUAGE. Two languages are in play:
//   * What it LISTENS in (speech-to-text) — the Pebble SDK gives apps no control
//     over this; set the Pebble mobile app's Voice Language to the spoken
//     language, or "auto". The source is also auto-detected by the backend.
//   * What it translates INTO (the target) — fully ours: pick it from the
//     language menu (SELECT hold). Default English (understand others); pick
//     another to translate your own speech so you can reply.
//
// The SDK exposes no streaming/partial dictation results, so this is
// phrase-by-phrase, not word-by-word.
//
// Controls:
//   SELECT       -> start / pause continuous listening
//   SELECT hold  -> open the target-language menu
//   BACK         -> exit (or pause first if listening)
//   UP / DOWN    -> scroll the transcript

#define PHRASE_SIZE     512   // one dictated utterance / one incoming translation
#define TRANSCRIPT_SIZE 4096  // rolling transcript of translations
#define DISPLAY_SIZE    4400  // transcript + status line
#define RESTART_DELAY_MS 250  // brief pause before re-arming dictation
#define HEADER_H        24    // fixed direction header above the transcript
#define PERSIST_TARGET  1     // persist key for the chosen target language

// Target languages the picker offers. Index 0 is the default (English).
static const char *LANGS[] = {
  "English", "Greek", "French", "German", "Italian", "Spanish", "Portuguese",
};
#define NUM_LANGS (sizeof(LANGS) / sizeof(LANGS[0]))

static Window *s_window;
static Window *s_menu_window;
static TextLayer *s_header_layer;
static TextLayer *s_text_layer;
static ScrollLayer *s_scroll_layer;
static MenuLayer *s_menu_layer;
static DictationSession *s_dictation;
static AppTimer *s_restart_timer;

static char s_transcript[TRANSCRIPT_SIZE];
static char s_incoming[PHRASE_SIZE];   // current translation, assembled from chunks
static char s_display[DISPLAY_SIZE];
static char s_header[32];               // "> English"
static bool s_listening = false;
static int s_target = 0;                // index into LANGS
static const char *s_status = "";       // short status line shown under the transcript

// ---- Direction header ----

static void update_header(void) {
  snprintf(s_header, sizeof(s_header), "> %s", LANGS[s_target]);
  if (s_header_layer) text_layer_set_text(s_header_layer, s_header);
}

// ---- Rendering ----

// Render transcript + status. When `to_bottom`, scroll so the newest text (and
// the live status) is visible; otherwise keep the top in view.
static void render(bool to_bottom) {
  if (s_transcript[0] == '\0' && s_status[0] != '\0') {
    snprintf(s_display, sizeof(s_display), "%s", s_status);
  } else if (s_status[0] != '\0') {
    snprintf(s_display, sizeof(s_display), "%s\n\n%s", s_transcript, s_status);
  } else {
    snprintf(s_display, sizeof(s_display), "%s", s_transcript);
  }

  GRect frame = layer_get_frame(scroll_layer_get_layer(s_scroll_layer));
  int w = frame.size.w - 8;

  // Grow tall before measuring so content-size isn't clipped to one screen.
  text_layer_set_size(s_text_layer, GSize(w, 10000));
  text_layer_set_text(s_text_layer, s_display);

  GSize content = text_layer_get_content_size(s_text_layer);
  int h = content.h + 12;
  if (h < frame.size.h) h = frame.size.h;
  text_layer_set_size(s_text_layer, GSize(w, h));
  scroll_layer_set_content_size(s_scroll_layer, GSize(frame.size.w, h));

  int offset_y = 0;
  if (to_bottom && h > frame.size.h) offset_y = -(h - frame.size.h);
  scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, offset_y), false);
}

// Append a finished translation line to the rolling transcript, trimming the
// oldest lines if we'd overflow the buffer (keep the most recent conversation).
static void append_line(const char *line) {
  if (!line || line[0] == '\0') return;

  size_t used = strlen(s_transcript);
  size_t add = strlen(line) + 2; // "\n\n" separator

  // Drop from the front (whole lines) until the new line fits.
  while (used + add >= TRANSCRIPT_SIZE) {
    char *nl = strstr(s_transcript, "\n\n");
    if (!nl) { s_transcript[0] = '\0'; used = 0; break; }
    size_t drop = (nl - s_transcript) + 2;
    memmove(s_transcript, s_transcript + drop, used - drop + 1);
    used -= drop;
  }

  if (s_transcript[0] != '\0') strncat(s_transcript, "\n\n", TRANSCRIPT_SIZE - used - 1);
  strncat(s_transcript, line, TRANSCRIPT_SIZE - strlen(s_transcript) - 1);
}

// ---- Dictation loop ----

static void start_dictation(void) {
  s_status = "Listening...";
  render(true);
  dictation_session_start(s_dictation);
}

static void restart_timer_cb(void *data) {
  s_restart_timer = NULL;
  if (s_listening) start_dictation();
}

// Re-arm dictation shortly after a phrase completes (deferred out of the
// dictation/message callbacks, which shouldn't start a new session inline).
static void schedule_restart(void) {
  if (!s_listening) return;
  if (s_restart_timer) app_timer_cancel(s_restart_timer);
  s_restart_timer = app_timer_register(RESTART_DELAY_MS, restart_timer_cb, NULL);
}

static void stop_listening(const char *why) {
  s_listening = false;
  if (s_restart_timer) { app_timer_cancel(s_restart_timer); s_restart_timer = NULL; }
  s_status = why;
  render(true);
}

// ---- Phone messaging ----

// Send a dictated phrase (with the current target language) to the phone.
static void send_phrase(const char *phrase) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    stop_listening("Message error. SELECT to retry.");
    return;
  }
  dict_write_cstring(out, MESSAGE_KEY_transcript, phrase);
  dict_write_cstring(out, MESSAGE_KEY_target, LANGS[s_target]);
  if (app_message_outbox_send() != APP_MSG_OK) {
    stop_listening("Phone unreachable. SELECT to retry.");
    return;
  }
  s_status = "Translating...";
  render(true);
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *tr  = dict_find(iter, MESSAGE_KEY_translation);
  Tuple *err = dict_find(iter, MESSAGE_KEY_error);

  if (tr) {
    // Assemble chunks of the current translation.
    size_t used = strlen(s_incoming);
    if (used < PHRASE_SIZE - 1) {
      strncat(s_incoming, tr->value->cstring, PHRASE_SIZE - 1 - used);
    }
    Tuple *more_t = dict_find(iter, MESSAGE_KEY_more);
    int more = more_t ? (int) more_t->value->int32 : 0;

    if (more == 0) {
      // Full phrase in — commit it to the transcript and listen again.
      append_line(s_incoming);
      s_incoming[0] = '\0';
      vibes_short_pulse();
      schedule_restart();
      s_status = s_listening ? "Listening..." : "Paused. SELECT to resume.";
      render(true);
    } else {
      // Show partial translation as it streams in.
      s_status = s_incoming;
      render(true);
    }
  } else if (err) {
    s_incoming[0] = '\0';
    snprintf(s_display, sizeof(s_display), "%s\n\nError: %s",
             s_transcript, err->value->cstring);
    stop_listening("Error. SELECT to retry.");
    vibes_double_pulse();
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  s_incoming[0] = '\0';
  stop_listening("Reply dropped. SELECT to retry.");
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  stop_listening("Phone unreachable. SELECT to retry.");
}

// ---- Dictation results ----

static void dictation_result(DictationSession *session,
                             DictationSessionStatus status,
                             char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess) {
    if (transcription && transcription[0] != '\0') {
      char phrase[PHRASE_SIZE];
      snprintf(phrase, sizeof(phrase), "%s", transcription);
      send_phrase(phrase); // translation appended when the phone replies
    } else {
      schedule_restart(); // empty result — just keep listening
    }
  } else if (status == DictationSessionStatusFailureNoSpeechDetected ||
             status == DictationSessionStatusFailureTranscriptionRejected) {
    // Silence between phrases (or a rejected snippet) — keep the loop alive.
    schedule_restart();
    if (!s_listening) { s_status = "Paused. SELECT to resume."; render(true); }
  } else {
    const char *reason;
    switch (status) {
      case DictationSessionStatusFailureConnectivityError:
        reason = "No connection to phone. SELECT to retry."; break;
      case DictationSessionStatusFailureDisabled:
        reason = "Dictation disabled (needs Rebble)."; break;
      default:
        reason = "Dictation failed. SELECT to retry."; break;
    }
    stop_listening(reason);
  }
}

// ---- Language menu ----

static uint16_t menu_num_rows(MenuLayer *ml, uint16_t section, void *ctx) {
  return NUM_LANGS;
}

static void menu_draw_row(GContext *g, const Layer *cell, MenuIndex *idx, void *ctx) {
  menu_cell_basic_draw(g, cell, LANGS[idx->row],
                       idx->row == (uint16_t) s_target ? "current" : NULL, NULL);
}

static void menu_select(MenuLayer *ml, MenuIndex *idx, void *ctx) {
  s_target = idx->row;
  persist_write_int(PERSIST_TARGET, s_target);
  update_header();
  window_stack_pop(true); // back to the transcript
}

static void menu_window_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  GRect b = layer_get_bounds(root);
  s_menu_layer = menu_layer_create(b);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks) {
    .get_num_rows = menu_num_rows,
    .draw_row = menu_draw_row,
    .select_click = menu_select,
  });
  menu_layer_set_click_config_onto_window(s_menu_layer, w);
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
  menu_layer_set_selected_index(s_menu_layer, (MenuIndex) { 0, (uint16_t) s_target },
                                MenuRowAlignCenter, false);
}

static void menu_window_unload(Window *w) {
  menu_layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
}

// ---- Buttons ----

// SELECT: toggle continuous listening.
static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_listening) {
    stop_listening("Paused. SELECT to resume.");
  } else {
    s_listening = true;
    start_dictation();
  }
}

// SELECT hold: open the target-language menu (pause first if listening).
static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_listening) stop_listening("Paused. SELECT to resume.");
  window_stack_push(s_menu_window, true);
}

// BACK: pause first if listening; exit on a second press.
static void back_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_listening) {
    stop_listening("Paused. SELECT to resume.");
  } else {
    window_stack_pop(true);
  }
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, select_long_click_handler, NULL);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click_handler);
}

// ---- Main window ----

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  // Fixed direction header ("> English") that stays put while the transcript scrolls.
  s_header_layer = text_layer_create(GRect(0, 0, bounds.size.w, HEADER_H));
  text_layer_set_font(s_header_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_header_layer, GTextAlignmentCenter);
  update_header();
  layer_add_child(root, text_layer_get_layer(s_header_layer));

  GRect scroll_frame = GRect(0, HEADER_H, bounds.size.w, bounds.size.h - HEADER_H);
  s_scroll_layer = scroll_layer_create(scroll_frame);
  scroll_layer_set_callbacks(s_scroll_layer, (ScrollLayerCallbacks) {
    .click_config_provider = click_config_provider,
  });
  scroll_layer_set_click_config_onto_window(s_scroll_layer, window);

  s_text_layer = text_layer_create(GRect(4, 2, scroll_frame.size.w - 8, scroll_frame.size.h));
  text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_text_layer, GTextAlignmentLeft);
  text_layer_set_overflow_mode(s_text_layer, GTextOverflowModeWordWrap);

  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_text_layer));
  layer_add_child(root, scroll_layer_get_layer(s_scroll_layer));

  s_status = "SELECT: start/pause\nSELECT hold: language\nBACK: exit\n\nSet phone Voice\nLanguage to the\nspoken one (or auto).";
  render(false);
}

// Returning from the menu: refresh so the (possibly new) direction shows.
static void window_appear(Window *window) {
  update_header();
  if (!s_listening) render(false);
}

static void window_unload(Window *window) {
  scroll_layer_destroy(s_scroll_layer);
  text_layer_destroy(s_text_layer);
  text_layer_destroy(s_header_layer);
  s_header_layer = NULL;
}

static void init(void) {
  if (persist_exists(PERSIST_TARGET)) s_target = persist_read_int(PERSIST_TARGET);
  if (s_target < 0 || s_target >= (int) NUM_LANGS) s_target = 0;

  s_dictation = dictation_session_create(PHRASE_SIZE, dictation_result, NULL);
  // Skip the built-in confirm/error UI so the loop flows phrase-to-phrase and we
  // handle silence/errors ourselves.
  dictation_session_enable_confirmation(s_dictation, false);
  dictation_session_enable_error_dialogs(s_dictation, false);

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(2048, 512); // inbox: translation chunks; outbox: phrase + target

  s_menu_window = window_create();
  window_set_window_handlers(s_menu_window, (WindowHandlers) {
    .load = menu_window_load,
    .unload = menu_window_unload,
  });

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .appear = window_appear,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);
}

static void deinit(void) {
  dictation_session_destroy(s_dictation);
  window_destroy(s_window);
  window_destroy(s_menu_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
