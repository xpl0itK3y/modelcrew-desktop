// Адресация строк сайдбара: одно и то же значение служит целью для
// переименования и для контекстного меню.

export type EditingTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "session"; workspaceId: string; sessionId: string };

export type MenuTarget = EditingTarget;

export function sameTarget(
  left: EditingTarget | null,
  right: EditingTarget,
): boolean {
  if (
    !left ||
    left.kind !== right.kind ||
    left.workspaceId !== right.workspaceId
  ) {
    return false;
  }
  if (left.kind === "workspace") {
    return true;
  }
  return right.kind === "session" && left.sessionId === right.sessionId;
}
