// Minimal stand-in for the Pebble SDK header — enough to type-check src/c/main.c
// off-device. Not a functional SDK; values/semantics are meaningless.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>

typedef struct { int16_t w, h; } GSize;
typedef struct { int16_t x, y; } GPoint;
typedef struct { GPoint origin; GSize size; } GRect;
static inline GRect GRect_(int16_t x, int16_t y, int16_t w, int16_t h) {
  GRect r = {{x,y},{w,h}}; return r; }
#define GRect(x,y,w,h) GRect_((x),(y),(w),(h))
static inline GSize GSize_(int16_t w, int16_t h) { GSize s = {w,h}; return s; }
#define GSize(w,h) GSize_((w),(h))
static inline GPoint GPoint_(int16_t x, int16_t y) { GPoint p = {x,y}; return p; }
#define GPoint(x,y) GPoint_((x),(y))

typedef struct { uint8_t argb; } GColor;
extern GColor GColorWhite, GColorBlack, GColorRed, GColorBlue, GColorDarkGray,
              GColorOrange, GColorWindsorTan, GColorIslamicGreen,
              GColorImperialPurple, GColorCobaltBlue;

typedef struct Layer Layer;
typedef struct Window Window;
typedef struct TextLayer TextLayer;
typedef struct ScrollLayer ScrollLayer;
typedef struct MenuLayer MenuLayer;
typedef struct GContext GContext;
typedef struct GFont_ *GFont;
typedef struct ClickRecognizer *ClickRecognizerRef;
typedef struct { uint16_t section, row; } MenuIndex;

typedef enum { GTextOverflowModeTrailingEllipsis, GTextOverflowModeWordWrap } GTextOverflowMode;
typedef enum { GTextAlignmentLeft, GTextAlignmentCenter, GTextAlignmentRight } GTextAlignment;
typedef enum { MenuRowAlignTop, MenuRowAlignCenter } MenuRowAlign;
typedef void *GTextAttributes;

#define FONT_KEY_GOTHIC_18 "18"
#define FONT_KEY_GOTHIC_18_BOLD "18b"
#define FONT_KEY_GOTHIC_24_BOLD "24b"

typedef struct { void (*load)(Window *); void (*unload)(Window *); } WindowHandlers;
typedef struct {
  uint16_t (*get_num_rows)(MenuLayer *, uint16_t, void *);
  int16_t (*get_cell_height)(MenuLayer *, MenuIndex *, void *);
  void (*draw_row)(GContext *, const Layer *, MenuIndex *, void *);
  void (*select_click)(MenuLayer *, MenuIndex *, void *);
  void (*select_long_click)(MenuLayer *, MenuIndex *, void *);
} MenuLayerCallbacks;

typedef enum { APP_MSG_OK = 0, APP_MSG_BUSY } AppMessageResult;
#define TUPLE_CSTRING 3
typedef struct { uint8_t type; union { char *cstring; int32_t int32; } *value; } Tuple;
typedef struct DictionaryIterator DictionaryIterator;

Window *window_create(void);
void window_destroy(Window *);
void window_set_window_handlers(Window *, WindowHandlers);
void window_stack_push(Window *, bool);
Layer *window_get_root_layer(Window *);
void window_set_click_config_provider(Window *, void (*)(void *));
void window_single_click_subscribe(int, void (*)(ClickRecognizerRef, void *));
#define BUTTON_ID_UP 1
#define BUTTON_ID_DOWN 2

GRect layer_get_bounds(const Layer *);
GRect layer_get_frame(const Layer *);
void layer_add_child(Layer *, Layer *);

TextLayer *text_layer_create(GRect);
void text_layer_destroy(TextLayer *);
Layer *text_layer_get_layer(TextLayer *);
void text_layer_set_text(TextLayer *, const char *);
void text_layer_set_font(TextLayer *, GFont);
void text_layer_set_text_color(TextLayer *, GColor);
void text_layer_set_background_color(TextLayer *, GColor);
void text_layer_set_text_alignment(TextLayer *, GTextAlignment);
void text_layer_set_overflow_mode(TextLayer *, GTextOverflowMode);
GSize text_layer_get_content_size(TextLayer *);

ScrollLayer *scroll_layer_create(GRect);
void scroll_layer_destroy(ScrollLayer *);
Layer *scroll_layer_get_layer(ScrollLayer *);
void scroll_layer_add_child(ScrollLayer *, Layer *);
void scroll_layer_set_content_size(ScrollLayer *, GSize);
void scroll_layer_set_content_offset(ScrollLayer *, GPoint, bool);
GPoint scroll_layer_get_content_offset(ScrollLayer *);
GSize scroll_layer_get_content_size(ScrollLayer *);

MenuLayer *menu_layer_create(GRect);
void menu_layer_destroy(MenuLayer *);
Layer *menu_layer_get_layer(MenuLayer *);
void menu_layer_set_callbacks(MenuLayer *, void *, MenuLayerCallbacks);
void menu_layer_set_click_config_onto_window(MenuLayer *, Window *);
void menu_layer_set_highlight_colors(MenuLayer *, GColor, GColor);
void menu_layer_reload_data(MenuLayer *);
void menu_layer_set_selected_index(MenuLayer *, MenuIndex, MenuRowAlign, bool);
MenuIndex menu_layer_get_selected_index(MenuLayer *);
bool menu_cell_layer_is_highlighted(const Layer *);

GFont fonts_get_system_font(const char *);
void graphics_context_set_text_color(GContext *, GColor);
void graphics_draw_text(GContext *, const char *, GFont, GRect, GTextOverflowMode,
                        GTextAlignment, GTextAttributes);

void persist_write_int(uint32_t, int32_t);
int32_t persist_read_int(uint32_t);
bool persist_exists(uint32_t);
int persist_write_data(uint32_t, const void *, size_t);
int persist_read_data(uint32_t, void *, size_t);

void app_message_register_inbox_received(void (*)(DictionaryIterator *, void *));
void app_message_register_inbox_dropped(void (*)(AppMessageResult, void *));
void app_message_register_outbox_failed(void (*)(DictionaryIterator *, AppMessageResult, void *));
void app_message_open(uint32_t, uint32_t);
AppMessageResult app_message_outbox_begin(DictionaryIterator **);
void app_message_outbox_send(void);
int dict_write_int(DictionaryIterator *, uint32_t, const void *, size_t, bool);
Tuple *dict_find(const DictionaryIterator *, uint32_t);

void vibes_short_pulse(void);
void app_event_loop(void);

#define MESSAGE_KEY_MSG_TYPE 1
#define MESSAGE_KEY_CALL_ID 2
#define MESSAGE_KEY_CALL_TIME 3
#define MESSAGE_KEY_CALL_TAG 4
#define MESSAGE_KEY_CALL_CAT 5
#define MESSAGE_KEY_CALL_TEXT 6
#define MESSAGE_KEY_CALL_EMERG 7
#define MESSAGE_KEY_STATUS 8
#define MESSAGE_KEY_FILTER 9
