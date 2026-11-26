import { visualRecordKernel } from "@repo/shared";

import { visualCookie } from "~/config/visual-cookie";

import { readVisualCookie } from "./cookie";

export function readVisualRequestSeed(request: Request) {
  return visualRecordKernel.decode(readVisualCookie(request.headers.get("Cookie") ?? "", visualCookie.name)).record;
}
