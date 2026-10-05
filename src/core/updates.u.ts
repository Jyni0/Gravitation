import { useSyncExternalStore } from "react";
import { APP_VERSION } from "./types.i";

/**
 * Update notice: asks GitHub for the latest release of the public repo and
 * compares its tag (v1.2.3) with this build. Nothing is downloaded or
 * installed — a newer release shows "Update" in the sidebar and a link to
 * the release page in Settings → About.
 */
export type UpdatePhase = "idle" | "checking" | "none" | "available" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** Version of the latest release (when newer). */
  version: string;
  /** Its release notes. */
  notes: string;
  /** Release page on GitHub. */
  url: string;
  error: string;
}

const REPO = "Jyni0/Gravitation";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let state: UpdateState = { phase: "idle", version: "", notes: "", url: "", error: "" };
let started = false;
const subscribers = new Set<() => void>();

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  subscribers.forEach((f) => f());
}

/** The version inside a tag: "Release-5.8.0", "v5.8.0", "5.8.0-beta.1" → "5.8.0"(-beta.1). */
export function versionOf(tag: string): string {
  const m = tag.match(/(\d+(?:\.\d+)+)(-[0-9A-Za-z.]+)?/);
  return m ? m[1] + (m[2] ?? "") : "";
}

/** "1.10.0" > "1.9.3"; a pre-release suffix never beats the plain version. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = versionOf(v).split(/-(.*)/s, 2);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? "" };
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a.nums[0] && a.nums.length < 2) return false; // no version in the tag
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return !a.pre && !!b.pre;
}

export async function checkForUpdate(): Promise<void> {
  if (state.phase === "checking") return;
  set({ phase: "checking", error: "" });
  try {
    const res = await fetch(API, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (res.status === 404) {
      set({ phase: "none" }); // no releases yet
      return;
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = (await res.json()) as { tag_name?: string; name?: string; html_url?: string; body?: string; draft?: boolean };
    const tag = versionOf(rel.tag_name ?? "") || versionOf(rel.name ?? "");
    if (tag && !rel.draft && isNewer(tag, APP_VERSION)) {
      set({ phase: "available", version: tag, notes: rel.body ?? "", url: rel.html_url ?? `https://github.com/${REPO}/releases/latest` });
    } else {
      set({ phase: "none", version: "", notes: "", url: "" });
    }
  } catch (e) {
    set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** Opens the release page in the browser (download it from there). */
export async function openRelease(): Promise<void> {
  const url = state.url || `https://github.com/${REPO}/releases/latest`;
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_release_page", { url });
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** First check a few seconds after launch, then every few hours. */
export function startUpdateChecks() {
  if (started) return;
  started = true;
  setTimeout(() => void checkForUpdate(), 5000);
  setInterval(() => void checkForUpdate(), RECHECK_MS);
}

const subscribe = (f: () => void) => {
  subscribers.add(f);
  return () => {
    subscribers.delete(f);
  };
};

export function useUpdates(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}
