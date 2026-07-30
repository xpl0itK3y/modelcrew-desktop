import { fireEvent, render, screen } from "@testing-library/react";
import type { IWatermarkPanelProps } from "dockview";
import { describe, expect, it, vi } from "vitest";
import { AppActionsProvider, type AppActions } from "../ui/AppActions";
import { Welcome } from "./Welcome";

// Ватермарк рисует dockview, и раньше он брал действия из изменяемого
// модульного объекта. Тест держит новый путь: провайдер над сеткой.
function renderWatermark(overrides: Partial<AppActions> = {}) {
  const actions: AppActions = {
    hasActiveWorkspace: () => true,
    requestCreateWorkspace: vi.fn(),
    requestNewTerminal: vi.fn(),
    requestCloseGroup: vi.fn(),
    ...overrides,
  };
  render(
    <AppActionsProvider actions={actions}>
      <Welcome {...({} as IWatermarkPanelProps)} />
    </AppActionsProvider>,
  );
  return actions;
}

describe("Welcome", () => {
  it("offers to pick a project while there is none", () => {
    const actions = renderWatermark({
      hasActiveWorkspace: () => false,
      requestCreateWorkspace: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Открыть папку/i }));

    expect(actions.requestCreateWorkspace).toHaveBeenCalledOnce();
    expect(actions.requestNewTerminal).not.toHaveBeenCalled();
  });

  it("offers a terminal once a project is open", () => {
    const actions = renderWatermark();

    fireEvent.click(screen.getByRole("button", { name: /терминал/i }));

    expect(actions.requestNewTerminal).toHaveBeenCalledOnce();
  });
});
