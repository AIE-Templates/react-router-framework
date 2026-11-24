#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <cstring>

// Electron can reassign every NSWindow's appearance when nativeTheme.themeSource changes.
// AppKit KVO registration ends with the observed window (macOS 10.13+).
@interface FixedWindowAppearance : NSObject
@property(nonatomic, strong) NSAppearance *appearance;
@end

@implementation FixedWindowAppearance
- (void)observeValueForKeyPath:(NSString *)path ofObject:(id)object
                        change:(NSDictionary *)change context:(void *)context {
  NSWindow *window = object;
  if (![window.appearance.name isEqual:self.appearance.name]) window.appearance = self.appearance;
}
@end

// Only main calls this function, with the Buffer returned by BrowserWindow itself.
static napi_value SetAppearance(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t count = 2, length = 0;
  void *bytes = nullptr;
  bool dark = false;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok ||
      count != 2 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok ||
      length != sizeof(NSView *) || napi_get_value_bool(env, args[1], &dark) != napi_ok ||
      ![NSThread isMainThread]) {
    napi_throw_error(env, nullptr, "Expected a native view handle and appearance on the main thread");
    return nullptr;
  }
  __unsafe_unretained NSView *view = nil;
  std::memcpy(&view, bytes, sizeof(view));
  NSWindow *window = view.window;
  if (!window) {
    napi_throw_error(env, nullptr, "Native view has no window");
    return nullptr;
  }
  FixedWindowAppearance *guard = [FixedWindowAppearance new];
  guard.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
  static char association;
  objc_setAssociatedObject(window, &association, guard, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [window addObserver:guard forKeyPath:@"appearance" options:NSKeyValueObservingOptionInitial context:nil];
  return nullptr;
}

NAPI_MODULE_INIT() {
  napi_value setter;
  napi_create_function(env, "setWindowAppearance", NAPI_AUTO_LENGTH, SetAppearance, nullptr, &setter);
  return setter;
}
