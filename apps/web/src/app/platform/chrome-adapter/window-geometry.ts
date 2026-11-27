/** Browser-reported geometry in viewport CSS pixels, available before hydration. */
export const WINDOW_CHROME_CSS = `
:root{
  --app-window-area-x:env(titlebar-area-x,0px);
  --app-window-area-y:env(titlebar-area-y,0px);
  --app-window-area-width:env(titlebar-area-width,100vw);
  --app-window-area-height:env(titlebar-area-height,0px);
  --app-window-safe-top:calc(var(--app-window-area-y) + var(--app-window-area-height));
  --app-window-safe-left:var(--app-window-area-x);
  --app-window-safe-right:calc(100vw - var(--app-window-area-x) - var(--app-window-area-width));
}
[data-window-drag]{app-region:drag;-webkit-app-region:drag}
[data-window-interactive]{app-region:no-drag;-webkit-app-region:no-drag}
`;
