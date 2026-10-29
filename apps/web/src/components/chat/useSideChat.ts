import type {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

export function latestSideChatSource(items: ReadonlyArray<ThreadStructureVisibleTurnItem>) {
  const source = items.findLast(
    ({ item }) =>
      item.type === "assistant_message" && item.status === "completed" && item.runId !== null,
  );
  if (!source?.item.runId) return null;
  return { sourceThreadId: source.sourceThreadId, runId: source.item.runId };
}

export function useSideChat(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly title: string | undefined;
  readonly source: ReturnType<typeof latestSideChatSource>;
  readonly onError: (message: string) => void;
  readonly getTurnSettings: () => {
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  } | null;
}) {
  const [pending, setPending] = useState(false);
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const openSideChat = async (prompt?: string) => {
    const { threadRef, source } = input;
    if (!threadRef || !source || pending) return;
    setPending(true);
    try {
      const targetThreadId = newThreadId();
      const result = await forkThreadFromRun({
        environmentId: threadRef.environmentId,
        input: {
          sourceThreadId: source.sourceThreadId,
          targetThreadId,
          runId: source.runId,
          title: `${input.title ?? "Thread"} side chat`,
          sideChat: true,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          input.onError(error instanceof Error ? error.message : "Failed to start a side chat.");
        }
        return;
      }
      if (!(await waitForThreadShell(scopeThreadRef(threadRef.environmentId, targetThreadId)))) {
        input.onError("The side chat was created, but its thread data did not reach this client.");
        return;
      }
      useRightPanelStore.getState().openSideChat(threadRef, targetThreadId);
      const text = prompt?.trim();
      const settings = text ? input.getTurnSettings() : null;
      if (!text || !settings) return;
      const turn = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: targetThreadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          ...settings,
          createdAt: new Date().toISOString(),
        },
      });
      if (turn._tag === "Failure" && !isAtomCommandInterrupted(turn)) {
        const error = squashAtomCommandFailure(turn);
        input.onError(
          error instanceof Error ? error.message : "Failed to send the side chat prompt.",
        );
      }
    } finally {
      setPending(false);
    }
  };
  return { available: input.source !== null && !pending, open: useStableCallback(openSideChat) };
}
