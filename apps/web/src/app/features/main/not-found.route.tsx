/** SPA-only: defer the error until the static root fallback has hydrated. */
export function clientLoader() {
  throw new Response("Not Found", { status: 404, statusText: "Not Found" });
}

export default function NotFound() {
  return null;
}
