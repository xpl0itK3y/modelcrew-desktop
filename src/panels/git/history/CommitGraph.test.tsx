// Бейдж ссылки в графе: по какому имени он переключает и когда молчит.
//
// Проверяется напрямую, а не через панель целиком: имя, которое уходит в
// switchBranch, зависит от типа ссылки, и ошибка здесь тихо уводит на чужую
// ветку вместо ожидаемой.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n";
import { RefBadge } from "./CommitGraph";

afterEach(() => setLocale("ru"));

function badge(
  overrides: Partial<Parameters<typeof RefBadge>[0]> = {},
  onSwitch = vi.fn(),
) {
  render(
    <RefBadge
      refName="main"
      fullRefName="refs/heads/main"
      kind="local"
      currentBranch="main"
      onSwitch={onSwitch}
      {...overrides}
    />,
  );
  return onSwitch;
}

describe("RefBadge", () => {
  it("switches a local branch by its short name", () => {
    const onSwitch = badge({ refName: "feature/x", kind: "local" });

    fireEvent.click(screen.getByRole("button", { name: "feature/x" }));

    expect(onSwitch).toHaveBeenCalledWith("feature/x", "local");
  });

  it("switches a server branch by its full ref, not the short label", () => {
    // Remote зовут не только origin, и короткое имя может совпасть с локальной
    // веткой: по нему переключение ушло бы не туда.
    const onSwitch = badge({
      refName: "upstream/main",
      fullRefName: "refs/remotes/upstream/main",
      kind: "remote",
    });

    fireEvent.click(screen.getByRole("button", { name: "upstream/main" }));

    expect(onSwitch).toHaveBeenCalledWith(
      "refs/remotes/upstream/main",
      "remote",
    );
  });

  it("checks out a tag by its own kind", () => {
    const onSwitch = badge({
      refName: "v1.2.3",
      fullRefName: "refs/tags/v1.2.3",
      kind: "tag",
    });

    fireEvent.click(screen.getByRole("button", { name: "v1.2.3" }));

    expect(onSwitch).toHaveBeenCalledWith("v1.2.3", "tag");
  });

  it("marks the current branch and refuses to switch to it", () => {
    const onSwitch = badge({ refName: "main", currentBranch: "main" });
    const button = screen.getByRole("button", { name: "main" });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-current", "true");
    expect(button).toHaveAttribute("title", "Текущая ветка");

    fireEvent.click(button);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("counts a remote branch of the same name as a different ref", () => {
    // origin/main и локальная main — разные ссылки: серверная остаётся живой.
    const onSwitch = badge({
      refName: "origin/main",
      fullRefName: "refs/remotes/origin/main",
      kind: "remote",
      currentBranch: "origin/main",
    });
    const button = screen.getByRole("button", { name: "origin/main" });

    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onSwitch).toHaveBeenCalledWith("refs/remotes/origin/main", "remote");
  });

  it("keeps the click off the commit row underneath", () => {
    // Строка графа сама ловит клик и раскрывает коммит: без stopPropagation
    // переключение ветки заодно открывало бы карточку.
    const onRowClick = vi.fn();
    const onSwitch = vi.fn();
    render(
      <div onClick={onRowClick}>
        <RefBadge
          refName="side"
          fullRefName="refs/heads/side"
          kind="local"
          currentBranch="main"
          onSwitch={onSwitch}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "side" }));

    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
