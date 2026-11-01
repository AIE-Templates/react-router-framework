import type { Route } from "./+types/home.route";
import { Welcome } from "./welcome";

export const meta: Route.MetaFunction = () => [
  { title: "New React Router App" },
  { name: "description", content: "Welcome to React Router!" },
];

export default function Home() {
  return <Welcome />;
}
