import { WINDOW_CHROME_CSS } from "~/managers/environment/window-geometry";

// The stock shell shares its primary header between fused styles and drawer anchoring.
const primaryPath =
  '>[data-window-columns]:not([hidden])>[data-window-column]:not([hidden])>[data-window-header="primary"]:not([hidden])';
const activeLayout = `[data-window-layout]:not([hidden]):nth-child(1 of [data-window-layout]:not([hidden]))`;
const fusedShell = '.app-shell[data-chrome-ready][data-header-mode="fused"]:not([hidden])';
const activeFrame = `${fusedShell}>.shell-body:not([hidden])>${activeLayout}:has(${primaryPath}[data-window-drag])`;
const fusedHeader = `${activeFrame}>[data-window-columns]>[data-window-column]>[data-window-header][data-window-drag]`;

/**
 * Keep the complete safety handoff here, inline in Layout, rather than in the business stylesheet.
 *
 * Titles in the fused window band grow from a zero flex basis, so they ellipsize before the header wraps:
 * a panel under the native controls (the RTL sidebar under Windows' caption buttons leaves about 90px)
 * keeps the band's height instead of growing a second line. Actions still wrap when they alone overflow.
 */
export const CHROME_SAFETY_CSS = `
html,body{margin:0;height:100%;min-width:0}
*{box-sizing:border-box}
[hidden]{display:none!important}
${WINDOW_CHROME_CSS}
.root-frame{height:100dvh;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.root-chrome-fallback{position:relative;flex-shrink:0;height:var(--app-window-safe-top)}
.window-safe-drag{position:absolute;left:var(--app-window-safe-left);top:var(--app-window-area-y);width:var(--app-window-area-width);height:var(--app-window-area-height)}
.root-content{flex:1;min-height:0;min-width:0;overflow:auto}
.app-shell{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;position:relative;overflow:hidden}
.shell-body{anchor-scope:--app-layout-workspace-header;flex:1;min-height:0;min-width:0;display:flex;position:relative;overflow:hidden}
.shell-titlebar{flex-shrink:0;min-height:var(--app-layout-header-height,0px);position:relative}
.app-shell[data-chrome-ready][data-header-mode="standalone"]>.shell-titlebar{min-height:max(var(--app-layout-header-height,0px),var(--app-window-safe-top))}
.app-shell[data-chrome-ready][data-header-mode="standalone"]>.shell-titlebar>.shell-titlebar-content{min-height:max(var(--app-layout-header-height,0px),var(--app-window-safe-top));padding-top:var(--app-window-area-y);padding-left:max(1rem,var(--app-window-safe-left));padding-right:max(1rem,var(--app-window-safe-right))}
.shell-titlebar-content{min-height:var(--app-layout-header-height,0px);display:flex;flex-wrap:wrap;align-items:center;gap:1rem;padding:0 1rem}
.shell-titlebar-content>strong{flex:1 1 0;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.shell-titlebar-content>[data-window-interactive]{display:flex;flex-wrap:wrap;align-items:center;min-width:0;max-width:100%}
[data-window-header] :is(button,input,textarea,select,a[href],summary,[tabindex],label,[contenteditable]:not([contenteditable="false"]),[role="button"]){app-region:no-drag;-webkit-app-region:no-drag}
.shell-nav{flex:0 0 4.5rem;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.shell-nav-chrome{display:none;flex-shrink:0}
html[data-chrome-mode="native-overlay"] .app-shell{--app-window-rail-band:max(var(--app-layout-header-height,0px),var(--app-window-safe-top))}
@media (width > 48em){
 .shell-body:has(>${activeLayout}${primaryPath}[data-window-drag])>.shell-nav>.shell-nav-chrome{display:block;height:var(--app-window-rail-band,var(--app-window-safe-top))}
}
.shell-nav-content{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:1rem;padding:1rem .5rem}
.shell-navigation-toggle{display:none}
.app-area-layout{--app-layout-sidebar-span:0px;--app-layout-auxiliary-span:0px}
[data-window-layout]{container-type:inline-size;flex:1;min-width:0;min-height:0;height:100%;position:relative}
.app-area-layout[data-sidebar-open="true"]{--app-layout-sidebar-span:15rem}
.app-area-layout[data-auxiliary-open="true"]{--app-layout-auxiliary-span:20rem}
.app-area-columns{--app-layout-visible-sidebar-span:var(--app-layout-sidebar-span);--app-layout-visible-auxiliary-span:var(--app-layout-auxiliary-span)}
[data-window-columns]{height:100%;display:grid;position:relative;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0;overflow:hidden}
[data-window-column-body]{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto;flex:1}
[data-window-column-body]>:only-child{flex:1;min-height:0}
[data-window-column]{display:grid;grid-row:1/-1;grid-template-rows:subgrid;min-width:0;min-height:0;overflow:hidden}
.app-area-workspace{grid-column:2}
.app-area-sidebar{grid-column:1}
.app-area-auxiliary{grid-column:3}
[data-window-header]{app-region:no-drag;-webkit-app-region:no-drag;flex-shrink:0;min-height:var(--app-layout-header-height,0px);display:flex;align-items:center;flex-wrap:wrap;gap:.5rem;padding:.375rem 1rem;position:relative}
.shell-body>${activeLayout}${primaryPath}{anchor-name:--app-layout-workspace-header}
[data-window-header]>strong{flex:1 1 4rem;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.app-area-header button{flex-shrink:0}
.app-area-scroll{flex:1;min-width:0;min-height:0;overflow:auto;padding:1rem}
.root-frame:has(>.root-content [data-window-safe-area-owner]:not([hidden],[hidden] *))>.root-chrome-fallback{display:none}
${fusedHeader}{app-region:drag;-webkit-app-region:drag;min-height:max(var(--app-layout-header-height,0px),var(--app-window-safe-top));padding-top:max(.375rem,var(--app-window-area-y));padding-left:max(1rem,calc(var(--app-window-safe-left) - var(--app-window-column-left,0px)));padding-right:max(1rem,calc(var(--app-window-safe-right) - var(--app-window-column-right,0px)))}
${fusedHeader}>strong{flex-basis:0}

/* Windows paints its separator below the native caption buttons. */
html[data-platform="win32"][data-chrome-mode="native-overlay"] .app-shell{--app-window-separator:1px;--app-window-band-height:calc(max(var(--app-layout-header-height,0px),var(--app-window-safe-top)) + var(--app-window-separator))}
html[data-platform="win32"][data-chrome-mode="native-overlay"] ${fusedHeader},
html[data-platform="win32"][data-chrome-mode="native-overlay"] .app-shell[data-chrome-ready][data-header-mode="standalone"]>.shell-titlebar>.shell-titlebar-content{min-height:var(--app-window-band-height);border-block-end:var(--app-window-separator) solid var(--app-color-border,currentColor)}
html[data-platform="win32"][data-chrome-mode="native-overlay"] .app-shell[data-chrome-ready][data-header-mode="fused"]>.shell-body>.shell-nav>.shell-nav-chrome{height:var(--app-window-band-height);border-block-end:var(--app-window-separator) solid color-mix(in srgb,currentColor 15%,transparent)}

@container (max-width:60rem){
 .app-area-columns{--app-layout-visible-auxiliary-span:0px}
 .app-area-auxiliary{display:flex;flex-direction:column;position:absolute;grid-area:2/1/3/-1;inset-block:0;inset-inline-end:0;width:min(20rem,100%);z-index:4;background:Canvas}
 .app-area-auxiliary>.app-area-header{app-region:no-drag!important;-webkit-app-region:no-drag!important;padding:.5rem 1rem!important;min-height:var(--app-layout-header-height,0px)!important}
}
@container (max-width:40rem){
 .app-area-columns{--app-layout-visible-sidebar-span:0px}
 .app-area-sidebar{display:flex;flex-direction:column;position:absolute;grid-area:2/1/3/-1;inset-block:0;inset-inline-start:0;width:min(18rem,100%);z-index:4;background:Canvas}
 .app-area-sidebar>.app-area-header{app-region:no-drag!important;-webkit-app-region:no-drag!important;padding:.5rem 1rem!important;min-height:var(--app-layout-header-height,0px)!important}
}
@media(max-width:48em){
 .shell-navigation-toggle{display:inline-flex}
 .shell-nav{display:none;position:absolute;inset-block:var(--app-layout-navigation-top,0px) 0;inset-inline-start:0;width:min(15rem,100%);z-index:6;background:Canvas}
 @supports (anchor-scope:--app-layout-workspace-header) and (top:anchor(--app-layout-workspace-header bottom)){
  .shell-nav{top:anchor(--app-layout-workspace-header bottom,var(--app-layout-navigation-top,0px))}
 }
 .app-shell[data-navigation-open="true"]>.shell-body>.shell-nav{display:flex}
 .app-shell[data-chrome-ready][data-header-mode="fused"]>.shell-body>.shell-nav>.shell-nav-chrome{display:none}
 .shell-nav-content{padding-top:1rem!important}
}
`;
