#include <pebble.h>

// ---------------------------------------------------------------------------
// Scanner Feed — Pebble watchapp
//
// Shows a live-ish feed of P25 scanner calls relayed from the backend by the
// phone (PebbleKit JS, see src/pkjs/index.js). The JS side polls
// data.zarchstuff.com/feed/api/*, filters by the active preset, and pushes one
// AppMessage per call. This C side keeps a small ring buffer, renders it as a
// scrollable list (talkgroup color-coded by agency type), and persists it so
// the app opens instantly with the last-known feed even before the phone
// reconnects.
//
// The default view is INCIDENT-grain: the backend's home log, one row per
// incident near home, ordered newest-first and colour-accented by how close to
// home it happened. Drilling down goes list -> incident detail -> its calls ->
// one call's transcript. The call-grain live tail is the last view in the
// cycle — the interesting one, not the important one.
//
// Controls:
//   List:   UP / DOWN        scroll
//           SELECT (short)   open the detail for the highlighted row
//           SELECT (long)    cycle view: Home -> Ward -> Nbhd -> Nearby -> Live
//   Detail: UP / DOWN        scroll; at the top/bottom, step to prev/next
//           SELECT           (incident only) open the calls behind it
//           BACK             return to the list
//   Calls:  SELECT           open that call's transcript
//           BACK             return to the incident detail
// ---------------------------------------------------------------------------

#define MAX_CALLS 24
// Member calls of one incident. Smaller than the feed buffer deliberately: this
// is a second full CallEntry array and app RAM is the scarce resource here.
#define MAX_MEMBERS 12

// MSG_TYPE values (JS -> watch)
#define MSG_CALL   0
#define MSG_STATUS 1

// Views (watch -> JS via MESSAGE_KEY_FILTER). 0-3 are incident-grain home-log
// scopes widening outward from the home block; 4 is the live call tail.
#define VIEW_HOME   0
#define VIEW_WARD   1
#define VIEW_NBHD   2
#define VIEW_NEARBY 3
#define VIEW_LIVE   4
#define VIEW_COUNT  5

static const char *VIEW_NAMES[VIEW_COUNT] = {
  "Home", "Ward", "Nbhd", "Nearby", "Live"
};

// Commands (watch -> JS via MESSAGE_KEY_CMD)
#define CMD_OPEN_INCIDENT  1
#define CMD_CLOSE_INCIDENT 2

// Relevance tiers (JS -> watch via MESSAGE_KEY_CALL_TIER), highest first.
#define TIER_HOME_BLOCK 4
#define TIER_WARD       3
#define TIER_GRID       2
#define TIER_BROADER    1

// Persistence keys
#define PKEY_VERSION 1
#define PKEY_COUNT   2
#define PKEY_FILTER  3
#define PKEY_ENTRY_BASE 100
// Bumped with every CallEntry layout change: persist_read_data would otherwise
// reinterpret the old byte layout as the new struct and render garbage.
#define PERSIST_VERSION 4

typedef struct {
  int32_t id;         // stable row identity (call id, or incident event_key)
  int32_t ord;        // sort key, descending — call id, or incident start_time
  int32_t inc;        // incident id to drill into; 0 when the row is a leaf
  uint8_t emergency;
  uint8_t tier;       // relevance tier, TIER_* above; 0 = external/unscored
  char    time[16];
  char    tag[28];
  char    cat[26];
  char    loc[24];    // where, when it isn't already the lead; else empty
  char    text[160];
} CallEntry;

// Feed buffer, newest first (index 0 = most recent).
static CallEntry s_calls[MAX_CALLS];
static int       s_count = 0;
// Member calls of the incident currently open, if any.
static CallEntry s_members[MAX_MEMBERS];
static int       s_member_count = 0;
static bool      s_in_members = false;
static int       s_filter = VIEW_HOME;
static char      s_status[32] = "Connecting...";

static Window      *s_main_window;
static TextLayer   *s_status_layer;
static MenuLayer   *s_menu_layer;

static Window      *s_detail_window;
static ScrollLayer *s_detail_scroll;
static TextLayer   *s_detail_text;
static TextLayer   *s_detail_header;
static char         s_detail_buf[320];
static char         s_detail_head[80];
static int          s_detail_index = -1;
// The row a call sits at shifts every time a newer call arrives, so remember
// which CALL the detail view is showing and re-resolve its row on each insert.
// Without this, a call landing while you read pushes your row down by one and
// prev/next then walks over a call you already read.
static int32_t      s_detail_id = 0;

// ---------------------------------------------------------------------------
// Talkgroup classification — color-codes the tag text by agency type so the
// feed is easier to scan. Matching is by substring on the alpha tag (e.g.
// "UtCo Fire/EMS", "Orem/Lindon PD", "UtCo Sher 3", "UHP ...").
// ---------------------------------------------------------------------------
#ifdef PBL_COLOR
typedef enum {
  TG_OTHER = 0, TG_POLICE, TG_SHERIFF, TG_FIRE, TG_EMS, TG_FIREEMS, TG_HIWAY
} TgType;

static TgType tg_type(const char *tag) {
  bool fire = strstr(tag, "Fire") != NULL;
  bool ems  = strstr(tag, "EMS") != NULL || strstr(tag, "Med") != NULL ||
              strstr(tag, "Ambul") != NULL;
  if (fire && ems) return TG_FIREEMS;
  if (fire)        return TG_FIRE;
  if (ems)         return TG_EMS;
  if (strstr(tag, "Sher") || strstr(tag, "Sheriff") || strstr(tag, " SO")) return TG_SHERIFF;
  if (strstr(tag, "UHP") || strstr(tag, "DPS") || strstr(tag, "Trooper") ||
      strstr(tag, "Patrol") || strstr(tag, "Hwy")) return TG_HIWAY;
  if (strstr(tag, "PD") || strstr(tag, "Police")) return TG_POLICE;
  return TG_OTHER;
}

// Accent bar colour for the relevance tier — how close to home it happened.
// Drawn as a bar in the left margin rather than as text colour so it reads at a
// glance without competing with the emergency red on the tag.
static GColor tier_color(uint8_t tier) {
  switch (tier) {
    case TIER_HOME_BLOCK: return GColorRed;
    case TIER_WARD:       return GColorOrange;
    case TIER_GRID:       return GColorYellow;
    case TIER_BROADER:    return GColorCobaltBlue;
    default:              return GColorClear;
  }
}

// Saturated colors chosen to stay legible on the white (unselected) row bg.
static GColor tg_color(TgType t) {
  switch (t) {
    case TG_POLICE:  return GColorBlue;
    case TG_SHERIFF: return GColorWindsorTan;
    case TG_FIRE:    return GColorOrange;
    case TG_FIREEMS: return GColorOrange;
    case TG_EMS:     return GColorIslamicGreen;
    case TG_HIWAY:   return GColorImperialPurple;
    default:         return GColorBlack;
  }
}
#endif

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
    if (s_filter < 0 || s_filter >= VIEW_COUNT) s_filter = VIEW_HOME;
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
static void update_member_header(void);

static void update_status_layer(void) {
  static char buf[48];
  snprintf(buf, sizeof(buf), "%s \xC2\xB7 %s", VIEW_NAMES[s_filter], s_status);
  if (s_status_layer) {
    text_layer_set_text(s_status_layer, buf);
  }
  update_member_header();
}

// ---------------------------------------------------------------------------
// Whichever list is on screen: the incident's member calls while drilled in,
// otherwise the feed. Everything that renders, scrolls or inserts goes through
// these so the two lists share one set of callbacks.
// ---------------------------------------------------------------------------
static CallEntry *active_list(void) { return s_in_members ? s_members : s_calls; }
static int active_count(void) { return s_in_members ? s_member_count : s_count; }
static int active_cap(void) { return s_in_members ? MAX_MEMBERS : MAX_CALLS; }

// ---------------------------------------------------------------------------
// Ring buffer insert (sorted by `ord` descending, dedupe by id)
// ---------------------------------------------------------------------------
// Sorting on `ord` rather than on the id matters for incidents: the home log's
// event_key is not guaranteed to run in time order, so the phone sends
// start_time as the sort key and the id stays purely an identity.
static void insert_call(const CallEntry *e) {
  CallEntry *list = active_list();
  int cap = active_cap();
  int *countp = s_in_members ? &s_member_count : &s_count;
  int count = *countp;

  // Update in place if we already have this id. Late enrichment (a summary or
  // severity landing after the call) arrives as a re-send of the same row.
  for (int i = 0; i < count; i++) {
    if (list[i].id == e->id) {
      list[i] = *e;
      return;
    }
  }
  // Find insertion point (descending sort-key order).
  int pos = count;
  for (int i = 0; i < count; i++) {
    if (e->ord > list[i].ord) { pos = i; break; }
  }
  if (pos >= cap) return; // older than everything we keep

  int last = (count < cap) ? count : cap - 1;
  for (int i = last; i > pos; i--) {
    list[i] = list[i - 1];
  }
  list[pos] = *e;
  if (count < cap) (*countp)++;
}

// Row currently holding this call id, or -1 if it has aged out of the buffer.
static int find_call_index(int32_t id) {
  CallEntry *list = active_list();
  int count = active_count();
  for (int i = 0; i < count; i++) {
    if (list[i].id == id) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Menu layer callbacks
// ---------------------------------------------------------------------------
static uint16_t menu_get_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  int n = active_count();
  return n > 0 ? n : 1;   // one row for the "waiting"/"loading" placeholder
}

// True when the visible list holds incidents rather than calls. The member list
// and the Live view are call-grain; every other view is incident-grain. No flag
// on the row is needed — the view already says which it is.
static bool showing_incidents(void) {
  return !s_in_members && s_filter != VIEW_LIVE;
}

// An incident row is taller: its whole job is to answer "what happened", and a
// 46px row gives the summary one line — about thirty characters, which truncates
// mid-clause and tells you nothing. Two lines costs one visible row and is the
// difference between a readable feed and a list of timestamps.
static int16_t menu_get_cell_height(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  return showing_incidents() ? 66 : 46;
}

static void menu_draw_row(GContext *gctx, const Layer *cell, MenuIndex *idx, void *ctx) {
  GRect b = layer_get_bounds(cell);

  if (active_count() == 0) {
    graphics_context_set_text_color(gctx, GColorDarkGray);
    graphics_draw_text(gctx, s_in_members ? "Loading calls..." : "Waiting for feed...",
                       fonts_get_system_font(FONT_KEY_GOTHIC_18),
                       GRect(6, 12, b.size.w - 12, 24),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    return;
  }

  CallEntry *e = &active_list()[idx->row];
  bool selected = menu_cell_layer_is_highlighted(cell);

  // Left-edge accent: how close to home this happened. Tier outranks severity
  // in what the user actually wants to notice, so it gets the persistent
  // visual channel and severity only tints the text.
  int text_x = 6;
#if defined(PBL_COLOR)
  if (e->tier) {
    graphics_context_set_fill_color(gctx, tier_color(e->tier));
    graphics_fill_rect(gctx, GRect(0, 0, 4, b.size.h), 0, GCornerNone);
    text_x = 10;
  }
#else
  // No colour to spend, so mark the closest tier with a bar the same way and
  // let the rest go unmarked rather than inventing greys.
  if (e->tier >= TIER_HOME_BLOCK) {
    graphics_context_set_fill_color(gctx, GColorBlack);
    graphics_fill_rect(gctx, GRect(0, 0, 4, b.size.h), 0, GCornerNone);
    text_x = 10;
  }
#endif

  // Time stays neutral; the talkgroup tag carries the agency color so the feed
  // is quick to scan. Emergency calls override to red for both.
  GColor time_color = selected ? GColorWhite : GColorBlack;
  GColor tag_color  = selected ? GColorWhite : GColorBlack;
#if defined(PBL_COLOR)
  if (e->emergency) {
    tag_color  = GColorRed;
    time_color = selected ? GColorWhite : GColorRed;
  } else if (!selected) {
    tag_color = tg_color(tg_type(e->tag));
  }
#endif

  // Top line: HH:MM:SS + what-or-who, right aligned.
  //
  // For an INCIDENT that is the incident type ("traffic accident") — the thing
  // the user is actually asking the watch. The talkgroup is who was talking,
  // which matters far less once a row represents an episode rather than one
  // transmission, so it moves to the detail view. It still drives the colour,
  // so the agency is legible without spending a line on it.
  //
  // For a CALL row the tag IS the useful identity, so it stays.
  bool incident = showing_incidents();
  const char *lead = (incident && e->cat[0]) ? e->cat : e->tag;

  // An incident's clock is HH:MM (the phone drops the seconds), so it needs far
  // less room than a call's HH:MM:SS — and every pixel saved goes to the type,
  // which is the part that has to survive without being ellipsized.
  int time_w = incident ? 44 : 78;
  graphics_context_set_text_color(gctx, time_color);
  graphics_draw_text(gctx, e->time,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(text_x, -2, time_w, 20),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_context_set_text_color(gctx, tag_color);
  graphics_draw_text(gctx, lead,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(text_x + time_w, -2, b.size.w - text_x - time_w - 6, 20),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);

  // WHERE, on its own line under the type — but only when the phone sent one,
  // which it does only when the address would not simply repeat the lead. A
  // row never spends a line saying the same thing twice.
  int body_y = incident ? 18 : 20;
  int body_h = incident ? 46 : 24;
  if (incident && e->loc[0]) {
    GColor loc_color = selected ? GColorWhite : GColorBlack;
#if defined(PBL_COLOR)
    // Subordinate to the type above it: this is context, not the headline.
    if (!selected) loc_color = GColorDarkGray;
#endif
    graphics_context_set_text_color(gctx, loc_color);
    graphics_draw_text(gctx, e->loc,
                       fonts_get_system_font(FONT_KEY_GOTHIC_14),
                       GRect(text_x, 17, b.size.w - text_x - 6, 18),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    // The address takes its line out of the summary's two, so the summary
    // falls back to one. Without an address it keeps both.
    body_y = 34;
    body_h = 30;
  }

  // Body: the summary. graphics_draw_text wraps to fill the rect and
  // ellipsizes the last line that doesn't fit.
  graphics_context_set_text_color(gctx, selected ? GColorWhite : GColorBlack);
  graphics_draw_text(gctx, e->text,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(text_x, body_y, b.size.w - text_x - 6, body_h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

static void detail_window_load(Window *window);
static void detail_window_unload(Window *window);
static void push_detail(int row);

// Tell the phone which preset to send. The outbox holds one message and the
// send fails outright if PebbleKit JS isn't up yet, which is exactly the race
// at launch — see s_filter_synced in inbox_received for the recovery.
static void send_filter(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_int(out, MESSAGE_KEY_FILTER, &s_filter, sizeof(int), true);
    app_message_outbox_send();
  }
}

// Ask the phone to open (or close) one incident's member calls.
static void send_cmd(int cmd, int32_t inc_id) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int(out, MESSAGE_KEY_CMD, &cmd, sizeof(int), true);
  if (inc_id) {
    dict_write_int(out, MESSAGE_KEY_CALL_INC, &inc_id, sizeof(int32_t), true);
  }
  app_message_outbox_send();
}

static void push_members(int32_t inc_id);

// SELECT always goes one level deeper, and every level is one step:
//
//   incident list -> incident detail -> its calls -> a call's transcript
//
// The detail sits between the list and the calls because it is the only place
// the full summary fits. Jumping the list straight to raw radio traffic skipped
// the one screen that actually explains the incident.
static void menu_select_click(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  if (active_count() == 0) return;
  push_detail(idx->row);
}

static void cycle_filter(void) {
  s_filter = (s_filter + 1) % VIEW_COUNT;
  // Clear the cache so the new preset starts clean; JS resets its lastMaxId to
  // match and resends the current window for this filter.
  s_count = 0;
  s_detail_id = 0;   // the row it pointed at is gone with the cache
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
    menu_layer_set_selected_index(s_menu_layer,
      (MenuIndex){0, 0}, MenuRowAlignTop, false);
  }
  snprintf(s_status, sizeof(s_status), "switching...");
  update_status_layer();
  save_state();

  send_filter();
  vibes_short_pulse();
}

static void menu_select_long_click(MenuLayer *menu, MenuIndex *idx, void *ctx) {
  cycle_filter();
}

// ---------------------------------------------------------------------------
// Member-call window — the calls that make up one incident
//
// A real window rather than a swapped-out buffer behind the same one, so BACK
// pops it natively. Overriding BACK on the main window would mean replacing the
// MenuLayer's own click config provider and re-implementing its scrolling.
// ---------------------------------------------------------------------------
static Window    *s_member_window;
static MenuLayer *s_member_menu;
static TextLayer *s_member_status;
static char       s_member_head[48];

// Without a header the member list is three near-identical rows with no cue
// that you drilled in at all — so it keeps the same black bar as the feed,
// carrying the phone's "N calls" and the drill-down arrow.
static void update_member_header(void) {
  if (!s_member_status) return;
  snprintf(s_member_head, sizeof(s_member_head), "\xE2\x80\xB9 %s", s_status);
  text_layer_set_text(s_member_status, s_member_head);
}

static void member_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

  const int status_h = 26;
  s_member_status = text_layer_create(GRect(0, 0, b.size.w, status_h));
  text_layer_set_background_color(s_member_status, GColorBlack);
  text_layer_set_text_color(s_member_status, GColorWhite);
  text_layer_set_font(s_member_status, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_member_status, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_member_status));
  update_member_header();

  b.origin.y += status_h;
  b.size.h -= status_h;
  s_member_menu = menu_layer_create(b);
  menu_layer_set_callbacks(s_member_menu, NULL, (MenuLayerCallbacks){
    .get_num_rows = menu_get_num_rows,
    .get_cell_height = menu_get_cell_height,
    .draw_row = menu_draw_row,
    .select_click = menu_select_click,
  });
  menu_layer_set_click_config_onto_window(s_member_menu, window);
#if defined(PBL_COLOR)
  menu_layer_set_highlight_colors(s_member_menu, GColorCobaltBlue, GColorWhite);
#endif
  layer_add_child(root, menu_layer_get_layer(s_member_menu));
}

static void member_window_unload(Window *window) {
  menu_layer_destroy(s_member_menu);
  text_layer_destroy(s_member_status);
  s_member_menu = NULL;
  s_member_status = NULL;
  // Back on the feed: let the phone resume polling and re-send the list.
  s_in_members = false;
  s_member_count = 0;
  send_cmd(CMD_CLOSE_INCIDENT, 0);
  if (s_menu_layer) menu_layer_reload_data(s_menu_layer);
}

static void push_members(int32_t inc_id) {
  s_in_members = true;
  s_member_count = 0;
  if (!s_member_window) {
    s_member_window = window_create();
    window_set_window_handlers(s_member_window, (WindowHandlers){
      .load = member_window_load,
      .unload = member_window_unload,
    });
  }
  send_cmd(CMD_OPEN_INCIDENT, inc_id);
  window_stack_push(s_member_window, true);
}

// ---------------------------------------------------------------------------
// Detail window — full transcript
// ---------------------------------------------------------------------------
static void push_detail(int row) {
  s_detail_index = row;
  s_detail_id = active_list()[row].id;
  if (!s_detail_window) {
    s_detail_window = window_create();
    window_set_window_handlers(s_detail_window, (WindowHandlers){
      .load = detail_window_load,
      .unload = detail_window_unload,
    });
  }
  window_stack_push(s_detail_window, true);
}

// Rebuild the detail view for the current s_detail_index: refresh the colored
// header + body text, resize the scroll content, reset to the top, and keep the
// list selection in sync so backing out lands on the call you ended on.
static void detail_render(void) {
  if (!s_detail_text || s_detail_index < 0 || s_detail_index >= active_count()) return;
  CallEntry *e = &active_list()[s_detail_index];

  // Header: time + talkgroup, color-coded by agency type (red for emergency)
  // to match the list. Stays fixed at the top while the transcript scrolls.
  snprintf(s_detail_head, sizeof(s_detail_head), "%s  %s", e->time, e->tag);
  text_layer_set_text(s_detail_header, s_detail_head);
  GColor hc = GColorBlack;
#ifdef PBL_COLOR
  hc = e->emergency ? GColorRed : tg_color(tg_type(e->tag));
#endif
  // Spell the tier out here — the list's accent bar is a glance cue, but the
  // detail view is where "this was on your block" should be unambiguous.
  if (e->tier >= TIER_HOME_BLOCK) {
    snprintf(s_detail_head, sizeof(s_detail_head), "%s  %s\nHOME BLOCK",
             e->time, e->tag);
  }
  text_layer_set_text_color(s_detail_header, hc);

  // Body. An INCIDENT detail is the screen that explains the incident, so it
  // leads with what and where at full length — neither is truncated to a row
  // here — then the summary, then the way down to the calls behind it. A CALL
  // detail is just its transcript, which is already the whole story.
  if (e->inc) {
    snprintf(s_detail_buf, sizeof(s_detail_buf), "%s%s%s\n\n%s\n\n\xE2\x96\xBC calls",
             e->cat,
             e->loc[0] ? "\n" : "",
             e->loc,
             e->text);
  } else if (e->cat[0]) {
    snprintf(s_detail_buf, sizeof(s_detail_buf), "%s%s%s\n\n%s",
             e->cat,
             e->loc[0] ? "\n" : "",
             e->loc,
             e->text);
  } else {
    snprintf(s_detail_buf, sizeof(s_detail_buf), "%s", e->text);
  }
  text_layer_set_text(s_detail_text, s_detail_buf);

  // Measure the wrapped transcript and size only the SCROLL content to it. The
  // text layer itself stays tall (created at 2000px) so the last line is never
  // clipped — shrinking it to the measured height tended to shave that line,
  // which was the "text cut off" issue.
  GRect tf = layer_get_frame(text_layer_get_layer(s_detail_text));
  GSize used = text_layer_get_content_size(s_detail_text);
  scroll_layer_set_content_size(s_detail_scroll, GSize(tf.size.w + 8, used.h + 20));
  scroll_layer_set_content_offset(s_detail_scroll, GPoint(0, 0), false);

  MenuLayer *m = s_in_members ? s_member_menu : s_menu_layer;
  if (m) {
    menu_layer_set_selected_index(m,
      (MenuIndex){ .section = 0, .row = s_detail_index }, MenuRowAlignCenter, false);
  }
}

// UP: scroll up a page; once at the top, step to the previous (newer) call.
static void detail_up_click(ClickRecognizerRef rec, void *ctx) {
  GPoint off = scroll_layer_get_content_offset(s_detail_scroll);
  if (off.y < 0) {
    int page = layer_get_frame(scroll_layer_get_layer(s_detail_scroll)).size.h - 24;
    if (page < 24) page = 24;
    int ny = off.y + page;
    if (ny > 0) ny = 0;
    scroll_layer_set_content_offset(s_detail_scroll, GPoint(0, ny), true);
  } else if (s_detail_index > 0) {
    s_detail_index--;
    s_detail_id = active_list()[s_detail_index].id;
    detail_render();
  }
}

// DOWN: scroll down a page; once at the bottom, step to the next (older) call.
static void detail_down_click(ClickRecognizerRef rec, void *ctx) {
  GPoint off = scroll_layer_get_content_offset(s_detail_scroll);
  GSize content = scroll_layer_get_content_size(s_detail_scroll);
  int view_h = layer_get_frame(scroll_layer_get_layer(s_detail_scroll)).size.h;
  int min_y = view_h - content.h;
  if (min_y > 0) min_y = 0;
  if (off.y > min_y) {
    int page = view_h - 24;
    if (page < 24) page = 24;
    int ny = off.y - page;
    if (ny < min_y) ny = min_y;
    scroll_layer_set_content_offset(s_detail_scroll, GPoint(0, ny), true);
  } else if (s_detail_index < active_count() - 1) {
    s_detail_index++;
    s_detail_id = active_list()[s_detail_index].id;
    detail_render();
  }
}

// SELECT on an incident detail opens the calls behind it. A call's transcript
// is the leaf — there is nothing below it, so SELECT does nothing there.
static void detail_select_click(ClickRecognizerRef rec, void *ctx) {
  if (s_detail_index < 0 || s_detail_index >= active_count()) return;
  int32_t inc = active_list()[s_detail_index].inc;
  if (inc) push_members(inc);
}

static void detail_click_provider(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_UP, detail_up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, detail_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, detail_select_click);
  // BACK keeps its default (pop back to the list).
}

static void detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

  // Fixed, color-coded header (up to two lines, 18pt to match the list font);
  // the transcript scrolls beneath it.
  const int head_h = 48;
  s_detail_header = text_layer_create(GRect(4, 2, b.size.w - 8, head_h - 4));
  text_layer_set_font(s_detail_header, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_overflow_mode(s_detail_header, GTextOverflowModeTrailingEllipsis);
  layer_add_child(root, text_layer_get_layer(s_detail_header));

  s_detail_scroll = scroll_layer_create(GRect(0, head_h, b.size.w, b.size.h - head_h));
  s_detail_text = text_layer_create(GRect(4, 0, b.size.w - 8, 2000));
  text_layer_set_font(s_detail_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_overflow_mode(s_detail_text, GTextOverflowModeWordWrap);
  scroll_layer_add_child(s_detail_scroll, text_layer_get_layer(s_detail_text));
  layer_add_child(root, scroll_layer_get_layer(s_detail_scroll));

  // We drive UP/DOWN ourselves (scroll, then step between calls at the ends),
  // so install our own click provider rather than the ScrollLayer's default.
  window_set_click_config_provider(window, detail_click_provider);

  detail_render();
}

static void detail_window_unload(Window *window) {
  text_layer_destroy(s_detail_text);
  text_layer_destroy(s_detail_header);
  scroll_layer_destroy(s_detail_scroll);
  s_detail_text = NULL;
  s_detail_header = NULL;
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

// Cleared until the phone has proved it is listening (any inbound message).
static bool s_filter_synced = false;

static void inbox_received(DictionaryIterator *iter, void *context) {
  // init()'s filter send is dropped if PebbleKit JS hasn't booted yet, and JS
  // then falls back to DEFAULT_FILTER from settings — leaving the watch showing
  // one preset while the phone fetches another. The first inbound message means
  // JS is alive, so re-send the filter then. Costs one extra seed per launch;
  // buys a status bar that can't lie about what's being fetched.
  if (!s_filter_synced) {
    s_filter_synced = true;
    send_filter();
  }

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
  Tuple *ti_t = dict_find(iter, MESSAGE_KEY_CALL_TIER);
  e.tier = ti_t ? (uint8_t)ti_t->value->int32 : 0;
  Tuple *in_t = dict_find(iter, MESSAGE_KEY_CALL_INC);
  e.inc = in_t ? in_t->value->int32 : 0;
  Tuple *or_t = dict_find(iter, MESSAGE_KEY_CALL_ORD);
  // Fall back to the id so a row without an explicit sort key still orders.
  e.ord = or_t ? or_t->value->int32 : 0;
  copy_tuple_str(iter, MESSAGE_KEY_CALL_TIME, e.time, sizeof(e.time));
  copy_tuple_str(iter, MESSAGE_KEY_CALL_TAG,  e.tag,  sizeof(e.tag));
  copy_tuple_str(iter, MESSAGE_KEY_CALL_CAT,  e.cat,  sizeof(e.cat));
  copy_tuple_str(iter, MESSAGE_KEY_CALL_LOC,  e.loc,  sizeof(e.loc));
  copy_tuple_str(iter, MESSAGE_KEY_CALL_TEXT, e.text, sizeof(e.text));

  if (e.id == 0) return;
  if (e.ord == 0) e.ord = e.id;

  bool was_empty = (active_count() == 0);
  insert_call(&e);

  // A newer call shifts every older row down one. Re-pin the detail view to the
  // call the user is actually reading so prev/next keeps stepping through the
  // feed instead of re-showing the call they just left.
  if (s_detail_id) {
    int row = find_call_index(s_detail_id);
    if (row >= 0) s_detail_index = row;
  }

  snprintf(s_status, sizeof(s_status), "live");
  update_status_layer();

  MenuLayer *m = s_in_members ? s_member_menu : s_menu_layer;
  if (m) {
    menu_layer_reload_data(m);
    // Keep the user pinned to the top so newest rows stay in view, but only if
    // they were already at/near the top (don't yank them mid-scroll).
    MenuIndex sel = menu_layer_get_selected_index(m);
    if (was_empty || sel.row == 0) {
      menu_layer_set_selected_index(m, (MenuIndex){0, 0}, MenuRowAlignTop, false);
    }
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  snprintf(s_status, sizeof(s_status), "msg dropped");
  update_status_layer();
}

// A failed filter send leaves the status bar stuck on "switching..." forever,
// which reads as a hung app. Say so instead; the next inbound message re-syncs.
static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason,
                          void *context) {
  // init()'s send losing the race with PebbleKit JS boot is the expected path,
  // not a fault — don't cry "phone?" over it, the first inbound message is
  // moments away and re-syncs. Only report a send that failed once the phone
  // had already been talking to us, which is the case that otherwise strands
  // the status bar on "switching...".
  if (s_filter_synced) {
    snprintf(s_status, sizeof(s_status), "phone?");
    update_status_layer();
  }
  s_filter_synced = false;
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
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(2048, 128);

  // Covers the case where JS came up first. If it didn't, this send fails and
  // inbox_received re-sends on first contact.
  send_filter();
}

static void deinit(void) {
  save_state();
  window_destroy(s_main_window);
  if (s_detail_window) window_destroy(s_detail_window);
  if (s_member_window) window_destroy(s_member_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
