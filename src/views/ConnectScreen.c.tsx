import { AnimatePresence, motion } from "motion/react";
import { Check, Pencil, RotateCw, X } from "lucide-react";
import type { SshConnectStepId } from "../core/db.r";
import type { SshServer } from "../core/types.i";
import { Button, OsLogo, Spinner } from "../components";
import { cx } from "../components/cx.u";

/** What the connecting screen knows about one step. */
export type ConnectStepState = { step: SshConnectStepId; detail: string };

const LABEL: Record<SshConnectStepId, string> = {
  proxy: "Connecting to proxy",
  dial: "Connecting to host",
  hostkey: "Verifying host key",
  auth: "Authenticating",
  shell: "Starting terminal",
};

const SPRING = { type: "spring", stiffness: 520, damping: 26 } as const;
const EASE = [0.22, 1, 0.36, 1] as const;

/** A thin accent arc with a fading tail, cut to a 2px ring around the logo. */
const RING_MASK = "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))";
const ORBIT: React.CSSProperties = {
  background: "conic-gradient(from 0deg, transparent 0deg, transparent 90deg, var(--accent) 330deg, transparent 360deg)",
  mask: RING_MASK,
  WebkitMask: RING_MASK,
};

/**
 * Termius-style connecting screen: fills a new terminal tab until the shell
 * is up. Only steps that actually happened are shown — each one slides in as
 * the backend reports it, joined to the previous by a line drawn down the
 * timeline. The step in progress spins and shimmers, finished ones get a
 * tick. On failure the step that broke turns red and the error comes with
 * Retry / Edit server / Close.
 */
export function ConnectScreen({
  server,
  reached,
  error,
  onRetry,
  onEdit,
  onClose,
}: {
  server: SshServer;
  /** Steps reported so far, in arrival order. */
  reached: ConnectStepState[];
  error: string | null;
  onRetry: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  // Nothing reported yet: we are already dialing (the proxy first, if any).
  const steps: ConnectStepState[] = reached.length
    ? reached
    : [{ step: server.proxy_id ? "proxy" : "dial", detail: "" }];

  return (
    <motion.div
      className="absolute inset-0 z-20 flex justify-center overflow-auto px-6 pt-[22vh]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.98, filter: "blur(6px)" }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="mb-10 w-full max-w-[420px] self-start"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
      >
        {/* Server — an arc orbits the logo while connecting; red ring on failure */}
        <div className="flex items-center gap-4 px-5 pt-5">
          <span className="relative flex h-12 w-12 shrink-0 items-center justify-center">
            <AnimatePresence initial={false}>
              {error ? (
                <motion.span
                  key="failed"
                  className="absolute inset-0 rounded-full border-2 border-[var(--diff-del)]"
                  initial={{ opacity: 0, scale: 1.25 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={SPRING}
                />
              ) : (
                <motion.span
                  key="orbit"
                  className="absolute inset-0 rounded-full"
                  style={ORBIT}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, rotate: 360 }}
                  exit={{ opacity: 0 }}
                  transition={{ opacity: { duration: 0.2 }, rotate: { duration: 1.1, repeat: Infinity, ease: "linear" } }}
                />
              )}
            </AnimatePresence>
            <OsLogo os={server.os} seed={server.id} name={server.name} size={38} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium text-[var(--text-main)]">{server.name}</div>
            <div className="truncate font-mono text-[11.5px] text-[var(--text-dim)]">
              {server.username}@{server.host}
              {server.port !== 22 ? ":" + server.port : ""}
            </div>
          </div>
        </div>

        {/* Timeline of the steps so far */}
        <ol className="px-5 pb-2 pt-6">
          <AnimatePresence initial={false}>
            {steps.map((r, i) => {
              const isLast = i === steps.length - 1;
              const state = !isLast ? "done" : error ? "failed" : "active";
              return (
                <motion.li
                  key={r.step}
                  className="relative overflow-hidden"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  transition={{ duration: 0.35, ease: EASE }}
                >
                  {/* Line down to the next step, drawn once that step exists */}
                  {!isLast && (
                    <motion.span
                      className="absolute left-[9.5px] top-[26px] bottom-[-6px] w-px origin-top bg-[var(--accent)]/40"
                      initial={{ scaleY: 0 }}
                      animate={{ scaleY: 1 }}
                      transition={{ duration: 0.35, ease: EASE }}
                    />
                  )}
                  <motion.div
                    className="flex items-start gap-3 pb-4"
                    initial={{ x: -8, filter: "blur(4px)" }}
                    animate={
                      state === "failed"
                        ? { x: [0, -5, 5, -3, 3, 0], filter: "blur(0px)" }
                        : { x: 0, filter: "blur(0px)" }
                    }
                    transition={{ duration: 0.4, ease: EASE }}
                  >
                    <span className="relative mt-px flex h-5 w-5 shrink-0 items-center justify-center">
                      <AnimatePresence mode="wait" initial={false}>
                        {state === "active" && (
                          <motion.span
                            key="spin"
                            className="flex text-[var(--accent)]"
                            exit={{ opacity: 0, scale: 0.4 }}
                            transition={{ duration: 0.12 }}
                          >
                            <Spinner size={16} />
                          </motion.span>
                        )}
                        {state === "done" && (
                          <motion.span
                            key="done"
                            className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--bg-app)]"
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={SPRING}
                          >
                            <Check size={12} strokeWidth={3.5} />
                          </motion.span>
                        )}
                        {state === "failed" && (
                          <motion.span
                            key="failed"
                            className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--diff-del)] text-[var(--bg-app)]"
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={SPRING}
                          >
                            <X size={12} strokeWidth={3.5} />
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cx(
                          "block text-[13px] leading-5 transition-colors duration-300",
                          state === "active" && "text-shimmer font-medium",
                          state === "done" && "text-[var(--text-muted)]",
                          state === "failed" && "font-medium text-[var(--diff-del)]",
                        )}
                      >
                        {LABEL[r.step]}
                      </span>
                      {r.detail && (
                        <span className="block truncate font-mono text-[11px] text-[var(--text-dim)]" title={r.detail}>
                          {r.detail}
                        </span>
                      )}
                      {/* What went wrong, right where it broke */}
                      <AnimatePresence>
                        {state === "failed" && error && (
                          <motion.span
                            className="block overflow-hidden"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: EASE, delay: 0.15 }}
                          >
                            <span className="mt-2 block max-h-28 select-text overflow-auto whitespace-pre-wrap break-words border-l-2 border-[var(--diff-del)]/60 pl-2.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                              {error}
                            </span>
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </span>
                  </motion.div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>

        {/* Failure: actions under the timeline */}
        <AnimatePresence>
          {error && (
            <motion.div
              className="overflow-hidden"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: EASE, delay: 0.2 }}
            >
              <div className="flex items-center gap-2 px-5 pt-3">
                <Button variant="ghost" size="sm" className="mr-auto" onClick={onClose}>
                  Close
                </Button>
                <Button variant="secondary" size="sm" onClick={onEdit}>
                  <Pencil size={12} /> Edit server
                </Button>
                <Button variant="primary" size="sm" onClick={onRetry}>
                  <RotateCw size={12} /> Retry
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
