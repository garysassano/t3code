/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}
