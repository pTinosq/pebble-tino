#include <pebble.h>

// "VoiceMemo" — talk to an LLM from your wrist.
// Flow:
//   1. Press SELECT -> Dictation API captures your question.
//   2. The question is sent to the phone (PebbleKit JS) via AppMessage.
//   3. The JS layer calls OpenRouter over HTTPS and sends the answer back.
//   4. The answer is shown here (scroll with UP/DOWN).

#define QUESTION_SIZE 256
#define DISPLAY_SIZE  2048

static Window *s_window;
static TextLayer *s_text_layer;
static ScrollLayer *s_scroll_layer;
static DictationSession *s_dictation;

static char s_question[QUESTION_SIZE];
static char s_display[DISPLAY_SIZE];

static void show_text(const char *text) {
  text_layer_set_text(s_text_layer, text);

  // Grow the text layer to its content, then let the scroll layer page
  // through anything taller than the screen.
  GSize content = text_layer_get_content_size(s_text_layer);
  GRect frame = layer_get_frame(scroll_layer_get_layer(s_scroll_layer));
  content.h += 8;
  if (content.h < frame.size.h) content.h = frame.size.h;
  text_layer_set_size(s_text_layer, GSize(frame.size.w, content.h));
  scroll_layer_set_content_size(s_scroll_layer, GSize(frame.size.w, content.h));
  scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, 0), false);
}

// ---- Sending the question to the phone ----

static void send_question(void) {
  DictionaryIterator *out;
  AppMessageResult res = app_message_outbox_begin(&out);
  if (res != APP_MSG_OK) {
    show_text("Couldn't start message.\n\nPress SELECT to retry.");
    return;
  }
  dict_write_cstring(out, MESSAGE_KEY_prompt, s_question);
  res = app_message_outbox_send();
  if (res != APP_MSG_OK) {
    show_text("Couldn't send to phone.\n\nPress SELECT to retry.");
  }
}

// ---- Receiving the answer from the phone ----

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *resp = dict_find(iter, MESSAGE_KEY_response);
  Tuple *err  = dict_find(iter, MESSAGE_KEY_error);

  if (resp) {
    snprintf(s_display, sizeof(s_display), "Q: %s\n\n%s",
             s_question, resp->value->cstring);
    show_text(s_display);
  } else if (err) {
    snprintf(s_display, sizeof(s_display), "Error:\n%s\n\nPress SELECT to retry.",
             err->value->cstring);
    show_text(s_display);
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

// ---- UI ----

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  dictation_session_start(s_dictation);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_scroll_layer = scroll_layer_create(bounds);
  // Scroll layer owns UP/DOWN; route SELECT to us to start dictation.
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

  show_text("Ask anything.\n\nPress SELECT and speak your question.");
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
  // Big inbox for LLM answers, small outbox for the question.
  app_message_open(2048, 256);

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
