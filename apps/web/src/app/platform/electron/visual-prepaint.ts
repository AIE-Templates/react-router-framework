/** Serialized into the document prepaint script. Preload fixes this appearance for the window's lifetime. */
export function desktopWindowAppearance(host: Window) {
  const fixed = host.desktop?.bootstrap?.fixedAppearance;
  return fixed === "light" || fixed === "dark" ? { record: null, fixedAppearance: fixed } : undefined;
}
