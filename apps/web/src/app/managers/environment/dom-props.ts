/** Apply to the actual popup surface, including surfaces portalled outside the shell. */
export function getInteractiveProps(): { "data-window-interactive": string };
export function getInteractiveProps<T extends object>(props: T): T & { "data-window-interactive": string };
export function getInteractiveProps(props?: object) {
  return { ...props, "data-window-interactive": "" };
}

export function getDragRegionProps(): { "data-window-drag": string };
export function getDragRegionProps<T extends object>(props: T): T & { "data-window-drag": string };
export function getDragRegionProps(props?: object) {
  return { ...props, "data-window-drag": "" };
}
