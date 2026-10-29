import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/**
 * Starts side chats from `threadRef`, or offers none when it is null. `open` forks the
 * thread's latest stable point, shows the side chat's tab, and sends `prompt` there.
 */
export function useSideChat(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly onError: (message: string) => void;
}) {
  const pendingRef = useRef(false);
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const start = async (threadRef: ScopedThreadRef, prompt: string | undefined) => {
    const targetThreadId = newThreadId();
    const fork = await forkSideChat({
      environmentId: threadRef.environmentId,
      input: { sourceThreadId: threadRef.threadId, targetThreadId, title: "Side chat" },
    });
    if (fork._tag === "Failure") {
      if (!isAtomCommandInterrupted(fork)) {
        const error = squashAtomCommandFailure(fork);
        input.onError(error instanceof Error ? error.message : "Could not start a side chat.");
      }
      return;
    }
    if (!(await waitForThreadShell(scopeThreadRef(threadRef.environmentId, targetThreadId)))) {
      input.onError("The side chat was created, but it did not reach this client.");
      return;
    }
    const text = prompt?.trim();
    // Send before showing the tab: closing a tab whose side chat has no run deletes it.
    if (text) {
      // The server asks before edits on a side chat's first turn whatever mode is sent.
      const turn = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: targetThreadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          titleSeed: deriveThreadTitleSeed({ text, attachments: [] }),
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
      });
      if (turn._tag === "Failure" && !isAtomCommandInterrupted(turn)) {
        const error = squashAtomCommandFailure(turn);
        input.onError(
          error instanceof Error ? error.message : "Could not send the side chat message.",
        );
      }
    }
    useRightPanelStore.getState().openSideChat(threadRef, targetThreadId);
  };
  const open = async (prompt?: string) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return;
    pendingRef.current = true;
    await start(threadRef, prompt).finally(() => {
      pendingRef.current = false;
    });
  };
  return { available: input.threadRef !== null, open: useStableCallback(open) };
}

/** Opens `thread` in its tab when it is a side chat of `parentRef`; false for any other thread. */
export function openSideChatTab(
  parentRef: ScopedThreadRef,
  thread: Pick<OrchestrationV2ThreadShell, "id" | "lineage"> | null,
): boolean {
  if (thread?.lineage.sideChat !== true || thread.lineage.parentThreadId !== parentRef.threadId) {
    return false;
  }
  useRightPanelStore.getState().openSideChat(parentRef, thread.id);
  return true;
}
