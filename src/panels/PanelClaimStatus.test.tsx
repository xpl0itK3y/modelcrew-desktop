// Подпись справа в шапке группы: что она говорит про выбранную панель.

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { clearPanelClaims, setPanelClaims } from "../crew/claimStore";
import { PanelClaimStatus } from "./PanelClaimStatus";

function claims(
  panelId: string,
  held: string[],
  waitingFor: string | null = null,
  awaited = false,
) {
  return new Map([[panelId, { held, waitingFor, awaited }]]);
}

afterEach(() => {
  clearPanelClaims();
  setLocale("ru");
});

describe("PanelClaimStatus", () => {
  it("names the file the agent is editing", async () => {
    render(<PanelClaimStatus panelId="p1" />);

    await act(async () => setPanelClaims(claims("p1", ["/w/src/auth.rs"])));

    expect(screen.getByText("auth.rs")).toBeInTheDocument();
    expect(screen.getByText("✎")).toBeInTheDocument();
  });

  it("counts the rest instead of listing them", async () => {
    render(<PanelClaimStatus panelId="p1" />);

    await act(async () =>
      setPanelClaims(claims("p1", ["/w/один.rs", "/w/два.rs", "/w/три.rs"])),
    );

    // Последний взятый файл — тот, в котором агент сейчас; остальные счётчиком,
    // полный список в подсказке.
    expect(screen.getByText("три.rs")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("shows the file it is stuck on ahead of its own work", async () => {
    render(<PanelClaimStatus panelId="p1" />);

    await act(async () =>
      // Своих файлов нарочно несколько: при одном счётчик пуст и так, и
      // ошибку в нём было бы нечем поймать.
      setPanelClaims(
        claims("p1", ["/w/своё.rs", "/w/второе.rs"], "/w/чужое.rs"),
      ),
    );

    expect(screen.getByText("чужое.rs")).toBeInTheDocument();
    expect(screen.getByText("⏳")).toBeInTheDocument();
    // Счётчик своих файлов при ожидании не к месту: показан чужой файл, и
    // «+1» рядом читался бы как «ждёт ещё один».
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it("stays out of the way when the panel touches nothing", async () => {
    const { container } = render(<PanelClaimStatus panelId="p1" />);

    await act(async () => setPanelClaims(new Map()));

    // Дюжина шапок с постоянной подписью превращается в рябь.
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores what another panel is doing", async () => {
    render(<PanelClaimStatus panelId="p1" />);

    await act(async () => setPanelClaims(claims("другая", ["/w/чужой.rs"])));

    expect(screen.queryByText("чужой.rs")).not.toBeInTheDocument();
  });
});
