/** Creation policy for the disposable editor demo. Other windows inherit the application appearance. */
export function demoChildAppearance(url: URL) {
  return url.pathname === "/" && url.searchParams.get("layout") === "editor" ? "dark" : undefined;
}
