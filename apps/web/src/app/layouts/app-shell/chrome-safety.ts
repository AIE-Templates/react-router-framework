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
:root{--shell-header-height:3rem;--window-header-height:var(--shell-header-height);--window-safe-top:calc(env(titlebar-area-y,0px) + env(titlebar-area-height,0px))}
[data-window-drag]{app-region:drag;-webkit-app-region:drag}
[data-window-interactive]{app-region:no-drag;-webkit-app-region:no-drag}
.root-frame{height:100dvh;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.root-chrome-fallback{flex-shrink:0;height:var(--window-safe-top);padding-top:env(titlebar-area-y,0px)}
.window-safe-drag{margin-left:env(titlebar-area-x,0px);width:env(titlebar-area-width,100%);height:env(titlebar-area-height,0px)}
.root-content{flex:1;min-height:0;min-width:0;overflow:auto}
.app-shell{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;position:relative;overflow:hidden}
.shell-body{flex:1;min-height:0;min-width:0;display:flex;position:relative;overflow:hidden}
.shell-titlebar{flex-shrink:0;min-height:var(--window-header-height);position:relative}
.app-shell[data-chrome-ready][data-header-mode="standalone"]>.shell-titlebar{min-height:max(var(--window-header-height),var(--window-safe-top))}
.app-shell[data-chrome-ready][data-header-mode="standalone"]>.shell-titlebar>.shell-titlebar-content{min-height:max(var(--window-header-height),var(--window-safe-top));padding-top:env(titlebar-area-y,0px);padding-left:max(1rem,env(titlebar-area-x,0px));padding-right:max(1rem,calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw)))}
.shell-titlebar-content{min-height:var(--window-header-height);display:flex;align-items:center;gap:1rem;padding:0 1rem}
.shell-nav{flex:0 0 4.5rem;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.shell-nav-chrome{display:none;flex-shrink:0}
.app-shell[data-chrome-ready][data-header-mode="fused"]>.shell-body>.shell-nav>.shell-nav-chrome{display:block;height:max(var(--window-header-height),var(--window-safe-top))}
.shell-nav-content{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:1rem;padding:1rem .5rem}
.shell-navigation-toggle{display:none}
.module-layout{--chrome-outer-left:env(titlebar-area-x,0px);--chrome-outer-right:max(0px,calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw)));--sidebar-span:0px;--auxiliary-span:0px;container-type:inline-size;flex:1;min-width:0;min-height:0;height:100%;position:relative}
.module-layout[data-sidebar-open="true"]{--sidebar-span:15rem}
.module-layout[data-auxiliary-open="true"]{--auxiliary-span:20rem}
.module-columns{--visible-sidebar-span:var(--sidebar-span);--visible-auxiliary-span:var(--auxiliary-span);height:100%;display:flex;min-width:0;min-height:0;overflow:hidden}
.module-panel{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.module-workspace{flex:1}
.module-sidebar{flex:0 0 15rem}
.module-auxiliary{flex:0 0 20rem}
.module-header{app-region:no-drag;-webkit-app-region:no-drag;flex-shrink:0;min-height:var(--shell-header-height);display:flex;align-items:center;flex-wrap:wrap;gap:.5rem;padding:.375rem 1rem;position:relative}
.module-header-title{flex:1 1 4rem;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.module-header button{flex-shrink:0}
.module-scroll{flex:1;min-width:0;min-height:0;overflow:auto;padding:1rem}
.root-frame:has(>.root-content>.app-shell[data-chrome-ready][data-header-mode="standalone"]:not([hidden])>.shell-titlebar:not([hidden])>.shell-titlebar-content:not([hidden]))>.root-chrome-fallback{display:none}
.root-frame:has(>.root-content>.app-shell[data-chrome-ready][data-header-mode="fused"]:not([hidden])>.shell-body:not([hidden])>.module-layout[data-chrome-complete]:not([hidden])>.module-columns:not([hidden])>.module-workspace:not([hidden])>.module-header:not([hidden]))>.root-chrome-fallback{display:none}
.app-shell[data-chrome-ready][data-header-mode="fused"]>.shell-body>.module-layout[data-chrome-complete]>.module-columns>.module-panel>.module-header{app-region:drag;-webkit-app-region:drag;min-height:max(var(--window-header-height),var(--window-safe-top));padding-top:max(.375rem,env(titlebar-area-y,0px));padding-left:max(1rem,var(--chrome-header-left,0px));padding-right:max(1rem,var(--chrome-header-right,0px))}
.app-shell[data-chrome-ready][data-header-mode="fused"]>.shell-body>.module-layout[data-chrome-complete]>.module-columns>.module-panel>.module-header>.module-header-title{flex-basis:0}
.module-layout:dir(ltr) .module-workspace>.module-header{--chrome-header-left:max(0px,calc(var(--chrome-outer-left) - var(--visible-sidebar-span)));--chrome-header-right:max(0px,calc(var(--chrome-outer-right) - var(--visible-auxiliary-span)))}
.module-layout:dir(rtl) .module-workspace>.module-header{--chrome-header-left:max(0px,calc(var(--chrome-outer-left) - var(--visible-auxiliary-span)));--chrome-header-right:max(0px,calc(var(--chrome-outer-right) - var(--visible-sidebar-span)))}
.module-layout:dir(ltr) .module-sidebar>.module-header,.module-layout:dir(rtl) .module-auxiliary>.module-header{--chrome-header-left:var(--chrome-outer-left)}
.module-layout:dir(rtl) .module-sidebar>.module-header,.module-layout:dir(ltr) .module-auxiliary>.module-header{--chrome-header-right:var(--chrome-outer-right)}
.app-shell[data-navigation-shell]:dir(ltr)>.shell-body>.module-layout{--chrome-outer-left:max(0px,calc(env(titlebar-area-x,0px) - 4.5rem))}
.app-shell[data-navigation-shell]:dir(rtl)>.shell-body>.module-layout{--chrome-outer-right:max(0px,calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw) - 4.5rem))}


@container (max-width:60rem){
 .module-columns{--visible-auxiliary-span:0px}
 .module-auxiliary{position:absolute;inset-block:calc(var(--window-safe-top) + 3rem) 0;inset-inline-end:0;width:min(20rem,100%);z-index:4;background:Canvas}
 .module-auxiliary>.module-header{app-region:no-drag!important;-webkit-app-region:no-drag!important;padding:.5rem 1rem!important;min-height:var(--shell-header-height)!important}
}
@container (max-width:40rem){
 .module-columns{--visible-sidebar-span:0px}
 .module-sidebar{position:absolute;inset-block:calc(var(--window-safe-top) + 3rem) 0;inset-inline-start:0;width:min(18rem,100%);z-index:4;background:Canvas}
 .module-sidebar>.module-header{app-region:no-drag!important;-webkit-app-region:no-drag!important;padding:.5rem 1rem!important;min-height:var(--shell-header-height)!important}
}
@media(max-width:48rem){
 .app-shell[data-navigation-shell]:dir(ltr)>.shell-body>.module-layout{--chrome-outer-left:env(titlebar-area-x,0px)}
 .app-shell[data-navigation-shell]:dir(rtl)>.shell-body>.module-layout{--chrome-outer-right:max(0px,calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw)))}
 .shell-navigation-toggle{display:inline-flex}
 .shell-nav{display:none;position:absolute;inset-block:calc(var(--window-safe-top) + 3rem) 0;inset-inline-start:0;width:15rem;z-index:6;background:Canvas}
 .app-shell[data-navigation-open="true"]>.shell-body>.shell-nav{display:block}
 .app-shell[data-chrome-ready][data-header-mode="fused"]>.shell-body>.shell-nav>.shell-nav-chrome{display:none}
 .shell-nav-content{padding-top:1rem!important}
}
`;
