#include <pebble.h>

// ---------------------------------------------------------------------------
// Scanner Feed — Pebble watchapp
//
// Shows a live-ish feed of P25 scanner calls relayed from the LAN backend by
// the phone (PebbleKit JS, see src/pkjs/index.js). The JS side polls
// transcripts.zarchstuff.com/api/recent, filters by the active preset, and
// pushes one AppMessage per call. This C side keeps a small ring buffer,
// renders it as a scrollable list, and persists it so the app opens instantly
// with the last-known feed even before the phone reconnects.
//
// Controls:
//   UP / DOWN          scroll the feed
//   SELECT (short)     open the full transcript for the highlighted call
//   SELECT (long)      cycle filter: Local -> Utah Co -> All -> Local
// ---------------------------------------------------------------------------

#define MAX_CALLS 24

// MSG_TYPE values (JS -> watch)
#define MSG_CALL   0
#define MSG_STATUS 1

// Filter presets (watch -> JS via MESSAGE_KEY_FILTER)
#define FILTER_LOCAL 0
#define FILTER_UTCO  1
#define FILTER_ALL   2
#define FILTER_COUNT 3

static const char *FILTER_NAMES[FILTER_COUNT] = { "Local", "Utah Co", "All" };

// Persistence keys
#define PKEY_VERSION 1
#define PKEY_COUNT   2
#define PKEY_FILTER  3
#define PKEY_ENTRY_BASE 100
#define PERSIST_VERSION 1

typedef struct {
  int32_t id;
  uint8_t emergency;
  char    time[16];
  char    tag[28];
  char    cat[20];
  char    text[160];
} CallEntry;

// Ring buffer, newest first (index 0 = most recent / highest id).
static CallEntry s_calls[MAX_CALLS];
static int       s_count = 0;
static int       s_filter = FILTER_LOCAL;
static char      s_status[32] = "Connecting...";

static Window      *s_main_window;
static TextLayer   *s_status_layer;
static MenuLayer   *s_menu_layer;

static Window      *s_detail_window;
static ScrollLayer *s_detail_scroll;
static TextLayer   *s_detail_text;
static char         s_detail_buf[260];
static int          s_detail_index = -1;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
static void save_state(void) {
  persist_write_int(PKEY_VERSION, PERSIST_VERSION);
  persist_write_int(PKEY_FILTER, s_filter);
  persist_write_int(PKEY_COUNT, s_count);
  for (int i = 0; i < s_count; i++) {
    persist_write_data(PKEY_ENTRY_BASE + i, &s_calls[i], sizeof(CallEntry));
  }
}

static void load_state(void) {
  if (persist_read_int(PKEY_VERSION) != PERSIST_VERSION) {
    s_count = 0;
    return;
  }
  if (persist_exists(PKEY_FILTER)) {
    s_filter = persist_read_int(PKEY_FILTER);
    if (s_filter < 0 || s_filter >= FILTER_COUNT) s_filter = FILTER_LOCAL;
  }
  s_count = persist_read_int(PKEY_COUNT);
  if (s_count < 0) s_count = 0;
  if (s_count > MAX_CALLS) s_count = MAX_CALLS;
  for (int i = 0; i < s_count; i++) {
    if (persist_exists(PKEY_ENTRY_BASE + i)) {
      persist_read_data(PKEY_ENTRY_BASE + i, &s_calls[i], sizeof(CallEntry));
    }
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
static void update_status_layer(void) {
  static char buf[48];
  snprintf(buf, sizeof(buf), "%s \xC2\xB7 %s", FILTER_NAMES[s_filter], s_status);
  if (s_status_layer) {
    text_layer_set_text(s_status_layer, buf);
  }
}

// ---------------------------------------------------------------------------
// Ring buffer insert (keep sorted by id descending, dedupe by id)
// ---------------------------------------------------------------------------
static void insert_call(const CallEntry *e) {
  // Update in place if we already have this id.
  for (int i = 0; i < s_count; i++) {
    if (s_calls[i].id == e->id) {
      s_calls[i] = *e;
      return;
    }
  }
  // Find insertion point (descending id order).
  int pos = s_count;
  for (int i = 0; i < s_count; i++) {
    if (e->id > s_calls[i].id) { pos = i; break; }
  }
  if (pos >= MAX_CALLS) return; // older than everything we keep

  int last = (s_count < MAX_CALLS) ? s_count : MAX_CALLS - 1;
  for (int i = last; i > pos; i--) {
    s_calls[i] = s_calls[i - 1];
  }
  s_calls[pos] = *e;
  if (s_count < MAX_CALLS) s_count++;
}

// ---------------------------------------------------------------------------
// Menu layer callbacks
// ---------------------------------------------------------------------------
static uint16_t menu_get_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  return s_count > 0 ? s_count : 1;
}

static int16_t menu_get_cell_height(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  return 46;
}

static void menu_draw_row(GContext *gctx, const Layer *cell, MenuIndex *idx, void *ctx) {
  GRect b = layer_get_bounds(cell);

  if (s_count == 0) {
    graphics_context_set_text_color(gctx, GColorDarkGray);
    graphics_draw_text(gctx, "Waiting for feed...",
                       fonts_get_system_font(FONT_KEY_GOTHIC_18),
                       GRect(6, 12, b.size.w - 12, 24),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    return;
  }

  CallEntry *e = &s_calls[idx->row];
  bool selected = menu_cell_layer_is_highlighted(cell);

  GColor head_color = GColorBlack;
#if defined(PBL_COLOR)
  if (e->emergency) head_color = GColorRed;
#endif
  if (selected) {
#if defined(PBL_COLOR)
    head_color = e->emergency ? GColorRed : GColorWhite;
#else
    head_color = GColorWhite;
#endif
  }

  // Top line: HH:MM:SS  +  talkgroup tag (right aligned)
  graphics_context_set_text_color(gctx, head_color);
  graphics_draw_text(gctx, e->time,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(6, -2, 78, 20),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_draw_text(gctx, e->tag,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(84, -2, b.size.w - 90, 20),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);

  // Bottom line: transcript snippet
  graphics_context_set_text_color(gctx, selected ? GColorWhite : GColorBlack);
  graphics_draw_text(gctx, e->text,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(6, 20, b.size.w - 12, 24),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

static void detail_window_load(Window *window);
static void detail_window_unload(Window *window);
static void push_detail(int row);

static void menu_select_click(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  if (s_count == 0) return;
  push_detail(idx->row);
}

static void cycle_filter(void) {
  s_filter = (s_filter + 1) % FILTER_COUNT;
  // Clear the cache so the new preset starts clean; JS resets its lastMaxId to
  // match and resends the current window for this filter.
  s_count = 0;
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
    menu_layer_set_selected_index(s_menu_layer,
      (MenuIndex){0, 0}, MenuRowAlignTop, false);
  }
  snprintf(s_status, sizeof(s_status), "switching...");
  update_status_layer();
  save_state();

  // Tell the phone which preset to send now.
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_int(out, MESSAGE_KEY_FILTER, &s_filter, sizeof(int), true);
    app_message_outbox_send();
  }
  vibes_short_pulse();
}

static void menu_select_long_click(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  cycle_filter();
}

// ---------------------------------------------------------------------------
// Detail window — full transcript
// ---------------------------------------------------------------------------
static void push_detail(int row) {
  s_detail_index = row;
  if (!s_detail_window) {
    s_detail_window = window_create();
    window_set_window_handlers(s_detail_window, (WindowHandlers){
      .load = detail_window_load,
      .unload = detail_window_unload,
    });
  }
  window_stack_push(s_detail_window, true);
}

static void detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

  s_detail_scroll = scroll_layer_create(b);
  scroll_layer_set_click_config_onto_window(s_detail_scroll, window);

  CallEntry *e = &s_calls[s_detail_index];
  // `cat` (incident type / city) is often empty in the current feed — only
  // give it its own line when present, so the transcript isn't pushed down by
  // a blank gap.
  if (e->cat[0]) {
    snprintf(s_detail_buf, sizeof(s_detail_buf), "%s  %s\n%s\n\n%s",
             e->time, e->tag, e->cat, e->text);
  } else {
    snprintf(s_detail_buf, sizeof(s_detail_buf), "%s  %s\n\n%s",
             e->time, e->tag, e->text);
  }

  s_detail_text = text_layer_create(GRect(4, 2, b.size.w - 8, 2000));
  text_layer_set_text(s_detail_text, s_detail_buf);
  text_layer_set_font(s_detail_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_overflow_mode(s_detail_text, GTextOverflowModeWordWrap);

  GSize used = text_layer_get_content_size(s_detail_text);
  text_layer_set_size(s_detail_text, GSize(b.size.w - 8, used.h + 12));
  scroll_layer_set_content_size(s_detail_scroll, GSize(b.size.w, used.h + 20));

  scroll_layer_add_child(s_detail_scroll, text_layer_get_layer(s_detail_text));
  layer_add_child(root, scroll_layer_get_layer(s_detail_scroll));
}

static void detail_window_unload(Window *window) {
  text_layer_destroy(s_detail_text);
  scroll_layer_destroy(s_detail_scroll);
  s_detail_text = NULL;
  s_detail_scroll = NULL;
}

// ---------------------------------------------------------------------------
// AppMessage
// ---------------------------------------------------------------------------
static void copy_tuple_str(DictionaryIterator *it, uint32_t key, char *dst, size_t n) {
  Tuple *t = dict_find(it, key);
  if (t && t->type == TUPLE_CSTRING) {
    strncpy(dst, t->value->cstring, n - 1);
    dst[n - 1] = '\0';
  } else {
    dst[0] = '\0';
  }
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *type_t = dict_find(iter, MESSAGE_KEY_MSG_TYPE);
  int type = type_t ? type_t->value->int32 : MSG_CALL;

  if (type == MSG_STATUS) {
    Tuple *s = dict_find(iter, MESSAGE_KEY_STATUS);
    if (s && s->type == TUPLE_CSTRING) {
      strncpy(s_status, s->value->cstring, sizeof(s_status) - 1);
      s_status[sizeof(s_status) - 1] = '\0';
      update_status_layer();
    }
    return;
  }

  // MSG_CALL
  CallEntry e;
  memset(&e, 0, sizeof(e));
  Tuple *id_t = dict_find(iter, MESSAGE_KEY_CALL_ID);
  e.id = id_t ? id_t->value->int32 : 0;
  Tuple *em_t = dict_find(iter, MESSAGE_KEY_CALL_EMERG);
  e.emergency = (em_t && em_t->value->int32) ? 1 : 0;
  copy_tuple_str(iter, MESSAGE_KEY_CALL_TIME, e.time, sizeof(e.time));
  copy_tuple_str(iter, MESSAGE_KEY_CALL_TAG,  e.tag,  sizeof(e.tag));
  copy_tuple_str(iter, MESSAGE_KEY_CALL_CAT,  e.cat,  sizeof(e.cat));
  copy_tuple_str(iter, MESSAGE_KEY_CALL_TEXT, e.text, sizeof(e.text));

  if (e.id == 0) return;

  bool was_empty = (s_count == 0);
  insert_call(&e);

  snprintf(s_status, sizeof(s_status), "live");
  update_status_layer();

  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
    // Keep the user pinned to the top so newest calls stay in view, but only
    // if they were already at/near the top (don't yank them mid-scroll).
    MenuIndex sel = menu_layer_get_selected_index(s_menu_layer);
    if (was_empty || sel.row == 0) {
      menu_layer_set_selected_index(s_menu_layer,
        (MenuIndex){0, 0}, MenuRowAlignTop, false);
    }
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  snprintf(s_status, sizeof(s_status), "msg dropped");
  update_status_layer();
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
static void main_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

  const int status_h = 26;
  s_status_layer = text_layer_create(GRect(0, 0, b.size.w, status_h));
  text_layer_set_background_color(s_status_layer, GColorBlack);
  text_layer_set_text_color(s_status_layer, GColorWhite);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_status_layer));
  update_status_layer();

  s_menu_layer = menu_layer_create(GRect(0, status_h, b.size.w, b.size.h - status_h));
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
    .get_num_rows = menu_get_num_rows,
    .get_cell_height = menu_get_cell_height,
    .draw_row = menu_draw_row,
    .select_click = menu_select_click,
    .select_long_click = menu_select_long_click,
  });
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
#if defined(PBL_COLOR)
  menu_layer_set_highlight_colors(s_menu_layer, GColorCobaltBlue, GColorWhite);
#endif
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
}

static void main_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
  text_layer_destroy(s_status_layer);
  s_menu_layer = NULL;
  s_status_layer = NULL;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
static void init(void) {
  load_state();

  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers){
    .load = main_window_load,
    .unload = main_window_unload,
  });
  window_stack_push(s_main_window, true);

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_open(2048, 128);

  // Tell the phone our active filter as soon as JS is ready. The JS side also
  // asks for it on launch, but sending here covers the case where JS came up
  // first.
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_int(out, MESSAGE_KEY_FILTER, &s_filter, sizeof(int), true);
    app_message_outbox_send();
  }
}

static void deinit(void) {
  save_state();
  window_destroy(s_main_window);
  if (s_detail_window) window_destroy(s_detail_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
