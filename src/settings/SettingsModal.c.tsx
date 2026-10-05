import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Cloud, Info, Palette, ScrollText, SquareTerminal, X, type LucideIcon } from "lucide-react";
import type { Theme } from "../core/types.i";
import { APP_VERSION, THEME_LIST } from "../core/types.i";
import { TerminalSettings } from "./TerminalSettings.c";
import { LogsSettings } from "./LogsSettings.c";
import { SyncSettings } from "./SyncSettings.c";
import { UpdateRow } from "./UpdateRow.c";
import { Combobox, ScrollArea, SettingRow, SettingsCard, Sep, IconButton, NavItem as SideItem } from "../components";

export type SettingsSection = "appearance" | "sync" | "terminal" | "logs" | "about";

export function SettingsModal({
  theme,
  onTheme,
  persistent,
  initialSection,
  onClose,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  persistent: boolean;
  /** Tab to land on. */
  initialSection?: SettingsSection;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "appearance");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  type NavItem = { id: SettingsSection; label: string; icon: LucideIcon };
  type NavGroup = { group?: string; items: NavItem[] };
  const navItems: NavGroup[] = [
    {
      items: [
        { id: "appearance", label: "Appearance", icon: Palette },
        { id: "sync", label: "Sync", icon: Cloud },
      ],
    },
    {
      group: "SSH",
      items: [
        { id: "terminal", label: "Terminal", icon: SquareTerminal },
        { id: "logs", label: "Logs", icon: ScrollText },
      ],
    },
  ];

  const navButton = (it: NavItem) => {
    const Icon = it.icon;
    const on = section === it.id;
    return (
      <SideItem
        key={it.id}
        active={on}
        className={on ? "text-[var(--text-main)]" : ""}
        icon={<Icon size={15} strokeWidth={1.7} className="shrink-0" />}
        onClick={() => setSection(it.id)}
      >
        <span className="truncate">{it.label}</span>
      </SideItem>
    );
  };

  const titles: Record<SettingsSection, [string, string]> = {
    appearance: ["Appearance", "Color theme of the application"],
    sync: ["Sync", "Keep units the same on every device through your own server"],
    terminal: ["Terminal", "Theme and behaviour of the SSH console"],
    logs: ["Logs", "The SSH audit trail of connections and commands"],
    about: ["About", "Application information"],
  };

  return (
    <motion.div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/5 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="bg-[var(--bg-surface)] flex h-[min(720px,calc(100vh-40px))] w-[min(1260px,calc(100vw-40px))] overflow-hidden rounded-3xl border border-[var(--border)] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.7)]"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left column — sections, grouped; About pinned to the bottom. */}
        <div className="flex w-[200px] shrink-0 flex-col">
          <ScrollArea className="min-h-0 flex-1" innerClassName="flex flex-col gap-4 px-2 py-3">
            {navItems.map((grp, gi) => (
              <div key={grp.group ?? gi} className="flex flex-col gap-0.5">
                {grp.group && <div className="px-2.5 pb-1 text-[11px] text-[var(--text-dim)]">{grp.group}</div>}
                {grp.items.map(navButton)}
              </div>
            ))}
          </ScrollArea>
          <div className="px-2 pb-3">{navButton({ id: "about", label: "About", icon: Info })}</div>
        </div>

        {/* Right column — content: a card inset in the modal, the border runs
            all the way round and the rounded corners stay put while it scrolls. */}
        <div className="my-2 mr-2 flex min-w-0 flex-1 overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--bg-app)]">
          <ScrollArea className="min-w-0 flex-1" innerClassName="min-w-0 px-8 py-6">
            <div className="mb-5 flex items-start">
              <div className="min-w-0">
                <div className="text-[17px] font-semibold text-[var(--text-main)]">{titles[section][0]}</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--text-dim)]">{titles[section][1]}</div>
              </div>
              <IconButton label="Close" className="ml-auto" onClick={onClose}>
                <X size={14} />
              </IconButton>
            </div>

            {section === "appearance" && (
              <SettingsCard>
                <SettingRow title="Theme" hint="Application color scheme — searchable">
                  {/* Searchable dropdown with a 3-dot palette preview per theme */}
                  <div className="w-[240px]">
                    <Combobox
                      value={theme}
                      onChange={(v) => onTheme(v as Theme)}
                      placeholder="Search themes…"
                      emptyText="No theme matches"
                      options={THEME_LIST.map((t) => ({
                        value: t.id,
                        label: t.label,
                        hint: t.kind,
                        swatch: t.swatch,
                      }))}
                    />
                  </div>
                </SettingRow>
              </SettingsCard>
            )}

            {section === "sync" && <SyncSettings />}

            {section === "terminal" && <TerminalSettings />}

            {section === "logs" && <LogsSettings />}

            {section === "about" && (
              <SettingsCard>
                <SettingRow title="Application" hint="Gravitation — SSH client">
                  <span className="font-mono text-[13px] text-[var(--text-main)]">v{APP_VERSION}</span>
                </SettingRow>
                <Sep />
                <UpdateRow />
                <Sep />
                <SettingRow title="Storage" hint={persistent ? "SQLite (desktop shell)" : "In-memory (browser preview)"} />
              </SettingsCard>
            )}
          </ScrollArea>
        </div>
      </motion.div>
    </motion.div>
  );
}
