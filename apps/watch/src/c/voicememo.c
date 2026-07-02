#include <pebble.h>

// "VoiceMemo" — talk to an LLM from your wrist, with conversation memory.
// Controls:
//   SELECT (tap)        -> speak a question / follow-up (keeps context)
//   SELECT (long press) -> start a NEW conversation (clears context)
//   BACK                -> page back through earlier turns; exits at the first
//   UP / DOWN           -> scroll the current answer

#define QUESTION_SIZE 256
#define ANSWER_SIZE   3072   // accumulated answer (assembled from chunks)
#define DISPLAY_SIZE  3400   // "Q: ...\n\n<answer>"
#define MAX_TURNS     3      // stored turns for BACK navigation
#define TURN_SIZE     3400   // per-turn "Q: ...\n\n<answer>"

static Window *s_window;
static TextLayer *s_text_layer;
static ScrollLayer *s_scroll_layer;
static DictationSession *s_dictation;

static char s_question[QUESTION_SIZE];
static char s_display[DISPLAY_SIZE];
static char s_answer[ANSWER_SIZE]; // accumulates chunked response text

static char s_turns[MAX_TURNS][TURN_SIZE];
static int s_turn_count = 0;      // number of stored turns
static int s_view = 0;            // index currently shown
static bool s_reset_next = true;  // next question starts a new conversation

static void show_text(const char *text) {
  text_layer_set_text(s_text_layer, text);

  GSize content = text_layer_get_content_size(s_text_layer);
  GRect frame = layer_get_frame(scroll_layer_get_layer(s_scroll_layer));
  content.h += 8;
  if (content.h < frame.size.h) content.h = frame.size.h;
  text_layer_set_size(s_text_layer, GSize(frame.size.w, content.h));
  scroll_layer_set_content_size(s_scroll_layer, GSize(frame.size.w, content.h));
  scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, 0), false);
}

static void store_turn(const char *text) {
  if (s_turn_count < MAX_TURNS) {
    strncpy(s_turns[s_turn_count], text, TURN_SIZE - 1);
    s_turns[s_turn_count][TURN_SIZE - 1] = '\0';
    s_turn_count++;
  } else {
    for (int i = 1; i < MAX_TURNS; i++) {
      strncpy(s_turns[i - 1], s_turns[i], TURN_SIZE);
    }
    strncpy(s_turns[MAX_TURNS - 1], text, TURN_SIZE - 1);
    s_turns[MAX_TURNS - 1][TURN_SIZE - 1] = '\0';
  }
  s_view = s_turn_count - 1;
}

// ---- Sending the question to the phone ----

static void send_question(void) {
  s_answer[0] = '\0'; // reset the accumulator for the new reply
  DictionaryIterator *out;
  AppMessageResult res = app_message_outbox_begin(&out);
  if (res != APP_MSG_OK) {
    show_text("Couldn't start message.\n\nPress SELECT to retry.");
    return;
  }
  dict_write_cstring(out, MESSAGE_KEY_prompt, s_question);
  dict_write_uint8(out, MESSAGE_KEY_reset, s_reset_next ? 1 : 0);
  res = app_message_outbox_send();
  if (res != APP_MSG_OK) {
    show_text("Couldn't send to phone.\n\nPress SELECT to retry.");
    return;
  }
  s_reset_next = false; // subsequent questions continue the conversation
}

// ---- Receiving the answer from the phone ----

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *resp = dict_find(iter, MESSAGE_KEY_response);
  Tuple *err  = dict_find(iter, MESSAGE_KEY_error);

  if (resp) {
    // Append this chunk to the accumulated answer, then render progressively.
    size_t used = strlen(s_answer);
    if (used < ANSWER_SIZE - 1) {
      strncat(s_answer, resp->value->cstring, ANSWER_SIZE - 1 - used);
    }
    Tuple *more_t = dict_find(iter, MESSAGE_KEY_more);
    int more = more_t ? more_t->value->int32 : 0;

    snprintf(s_display, sizeof(s_display), "Q: %s\n\n%s", s_question, s_answer);
    show_text(s_display);
    if (!more) {
      store_turn(s_display);   // full answer received
      vibes_short_pulse();
    }
  } else if (err) {
    snprintf(s_display, sizeof(s_display), "Error:\n%s\n\nPress SELECT to retry.",
             err->value->cstring);
    show_text(s_display);
    vibes_double_pulse(); // distinct buzz for errors
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  show_text("Reply was dropped\n(too long?).\n\nPress SELECT to retry.");
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason,
                          void *context) {
  show_text("Phone unreachable.\n\nCheck Bluetooth, then\npress SELECT to retry.");
}

// ---- Dictation ----

static void dictation_result(DictationSession *session,
                             DictationSessionStatus status,
                             char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess) {
    snprintf(s_question, sizeof(s_question), "%s", transcription);
    snprintf(s_display, sizeof(s_display), "Q: %s\n\nThinking...", s_question);
    show_text(s_display);
    send_question();
  } else {
    const char *reason;
    switch (status) {
      case DictationSessionStatusFailureNoSpeechDetected:
        reason = "No speech detected"; break;
      case DictationSessionStatusFailureConnectivityError:
        reason = "No connection to phone"; break;
      case DictationSessionStatusFailureDisabled:
        reason = "Dictation is disabled"; break;
      case DictationSessionStatusFailureTranscriptionRejected:
        reason = "Cancelled"; break;
      default:
        reason = "Transcription failed"; break;
    }
    snprintf(s_display, sizeof(s_display), "%s\n\nPress SELECT to try again.",
             reason);
    show_text(s_display);
  }
}

// ---- Buttons ----

// SELECT tap: speak a follow-up (keeps conversation context).
static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  dictation_session_start(s_dictation);
}

// SELECT long-press: start a brand-new conversation.
static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_turn_count = 0;
  s_view = 0;
  s_reset_next = true;
  show_text("New conversation.\n\nPress SELECT and speak.");
}

// BACK: page to the previous turn; if already at the first, exit the app.
static void back_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_view > 0) {
    s_view--;
    show_text(s_turns[s_view]);
  } else {
    window_stack_pop(true);
  }
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, select_long_click_handler, NULL);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click_handler);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_scroll_layer = scroll_layer_create(bounds);
  // Scroll layer owns UP/DOWN; our provider adds SELECT (tap + long) and BACK.
  scroll_layer_set_callbacks(s_scroll_layer, (ScrollLayerCallbacks) {
    .click_config_provider = click_config_provider,
  });
  scroll_layer_set_click_config_onto_window(s_scroll_layer, window);

  s_text_layer = text_layer_create(GRect(4, 2, bounds.size.w - 8, bounds.size.h));
  text_layer_set_font(s_text_layer,
                      fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_text_layer, GTextAlignmentLeft);
  text_layer_set_overflow_mode(s_text_layer, GTextOverflowModeWordWrap);

  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_text_layer));
  layer_add_child(root, scroll_layer_get_layer(s_scroll_layer));

  show_text("Ask anything.\n\nSELECT: speak\nSELECT hold: new chat\nBACK: previous");
}

static void window_unload(Window *window) {
  scroll_layer_destroy(s_scroll_layer);
  text_layer_destroy(s_text_layer);
}

static void init(void) {
  s_dictation = dictation_session_create(QUESTION_SIZE, dictation_result, NULL);

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(3072, 512); // inbox holds answers up to ~2000; outbox for question + reset

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);
}

static void deinit(void) {
  dictation_session_destroy(s_dictation);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
