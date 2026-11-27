"use client";

import { useTranslations } from "next-intl";
import { ProblemAlert, useCommand } from "@/components/command";
import { Badge } from "@/components/ui/primitives";
import { broadcastSession } from "@/features/shell/client/session-guard";
import { useRouter } from "@/i18n/navigation";

type Option = { id: string; kind: "CORPORATE" | "BANK"; title: string; subtitle: string; roles: string[]; current: boolean };

export function WorkspaceChooser({ options }: { options: Option[] }) {
  const t = useTranslations("nav.context");
  const router = useRouter();
  const command = useCommand();

  async function choose(option: Option) {
    const result = await command.run("/session/context", { body: { membershipId: option.id } }, { refresh: false });
    if (!result.ok) return;
    // Other tabs must drop whatever they show for the previous workspace (PWA-06).
    broadcastSession("context-changed");
    router.replace(option.kind === "BANK" ? "/bank" : "/dashboard");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <ul className="flex flex-col gap-3">
        {options.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              disabled={command.pending}
              onClick={() => choose(option)}
              data-testid={`workspace-${option.kind.toLowerCase()}`}
              className="flex w-full min-h-16 flex-col items-start gap-1 rounded-[10px] border border-border bg-surface px-4 py-3 text-start hover:border-accent disabled:opacity-60"
            >
              <span className="flex w-full flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{option.title}</span>
                {option.current ? <Badge tone="info">{t("current")}</Badge> : null}
              </span>
              <span className="text-sm text-muted">
                {option.subtitle} · {option.roles.join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
