// Test-only AppKit readings. A renderer screenshot omits the window buttons and native menus.
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

static NSString *lastMenu;
static NSString *trackingMenu;
static napi_value ReadAppearance(napi_env env, napi_callback_info info) {
  napi_value value;
  size_t count = 1;
  napi_get_cb_info(env, info, &count, &value, nullptr, nullptr);
  NSString *result = lastMenu ?: @"";
  if (count) {
    void *bytes;
    size_t size;
    if (napi_get_buffer_info(env, value, &bytes, &size) != napi_ok || size != sizeof(NSView *)) {
      napi_throw_error(env, nullptr, "Expected native window handle");
      return nullptr;
    }
    __unsafe_unretained NSView *view;
    std::memcpy(&view, bytes, sizeof(view));
    result = [view.window standardWindowButton:NSWindowCloseButton].effectiveAppearance.name;
  }
  napi_create_string_utf8(env, result.UTF8String, NAPI_AUTO_LENGTH, &value);
  return value;
}

NAPI_MODULE_INIT() {
  [[NSNotificationCenter defaultCenter] addObserverForName:NSMenuDidBeginTrackingNotification object:nil queue:nil
      usingBlock:^(NSNotification *note) {
        NSMenu *menu = note.object;
        NSWindow *window = NSApp.keyWindow;
        [[NSRunLoop mainRunLoop] performInModes:@[NSEventTrackingRunLoopMode, NSDefaultRunLoopMode] block:^{
          NSRect bounds = menu.accessibilityFrame;
          // Left edge and top edge of the actual menu in window coordinates (origin at top left).
          trackingMenu = [NSString stringWithFormat:@"%@ %ld %ld", menu.effectiveAppearance.name,
              lround(NSMinX(bounds) - NSMinX(window.frame)), lround(NSMaxY(window.frame) - NSMaxY(bounds))];
          [menu performSelector:@selector(cancelTracking) withObject:nil afterDelay:0
                       inModes:@[NSEventTrackingRunLoopMode, NSDefaultRunLoopMode]];
        }];
      }];
  [[NSNotificationCenter defaultCenter] addObserverForName:NSMenuDidEndTrackingNotification object:nil queue:nil
      usingBlock:^(NSNotification *note) { lastMenu = trackingMenu; }];
  napi_value reader;
  napi_create_function(env, "readAppearance", NAPI_AUTO_LENGTH, ReadAppearance, nullptr, &reader);
  return reader;
}
