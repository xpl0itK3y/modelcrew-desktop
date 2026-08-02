// Подпись «что правит панель»: четыре состояния и что видно в каждом.

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { clearPanelClaims, setPanelClaims } from "../crew/claimStore";
import { PanelClaimStatus } from "./PanelClaimStatus";

function state(
  panelId: string,
  fields: { held?: string[]; waitingFor?: string | null; awaited?: boolean },
) {
  setPanelClaims(
    new Map([
      [
        panelId,
        {
          held: fields.held ?? [],
          waitingFor: fields.waitingFor ?? null,
          awaited: fields.awaited ?? false,
        },
      ],
    ]),
  );
}

afterEach(() => {
  clearPanelClaims();
  setLocale("ru");
});

describe("PanelClaimStatus", () => {
  it("shows nothing at all for a panel that holds no files", () => {
    // Дюжина шапок с постоянной подписью превращается в рябь: пусто — значит
    // пусто, а не «—» и не «свободна».
    const { container } = render(<PanelClaimStatus panelId="panel-a" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("names the file being edited, without the path", () => {
    state("panel-a", { held: ["src/persist/model.ts"] });

    render(<PanelClaimStatus panelId="panel-a" />);

    // В шапке шириной с ладонь путь не поместится, поэтому имя — а путь
    // целиком лежит в подсказке.
    expect(screen.getByText("model.ts")).toBeInTheDocument();
    expect(screen.getByTitle(/src\/persist\/model\.ts/)).toBeInTheDocument();
  });

  it("counts the rest instead of listing them", () => {
    state("panel-a", { held: ["a.ts", "b.ts", "c.ts"] });

    render(<PanelClaimStatus panelId="panel-a" />);

    // Показан последний взятый — в нём агент и работает.
    expect(screen.getByText("c.ts")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });

  it("puts waiting above editing", () => {
    // Агент упёрся в занятый файл и ушёл в другие: показать надо именно это.
    state("panel-a", { held: ["other.ts"], waitingFor: "src/busy.ts" });

    const { container } = render(<PanelClaimStatus panelId="panel-a" />);

    expect(screen.getByText("busy.ts")).toBeInTheDocument();
    expect(screen.queryByText("other.ts")).not.toBeInTheDocument();
    expect(container.querySelector(".is-waiting")).toBeInTheDocument();
  });

  it("marks a file someone else is waiting for", () => {
    state("panel-a", { held: ["src/app.ts"], awaited: true });

    const { container } = render(<PanelClaimStatus panelId="panel-a" />);

    // Держатель должен узнать, что его ждут, иначе отпустит файл по таймеру.
    expect(container.querySelector(".panel-claim-dot")).toBeInTheDocument();
    expect(screen.getByTitle(/ждёт другая панель/)).toBeInTheDocument();
  });

  it("follows the panel it was given, not the first one reported", () => {
    state("panel-b", { held: ["mine.ts"] });

    render(<PanelClaimStatus panelId="panel-b" />);
    expect(screen.getByText("mine.ts")).toBeInTheDocument();

    const { container } = render(<PanelClaimStatus panelId="panel-a" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps up when the picture changes under it", () => {
    state("panel-a", { held: ["first.ts"] });
    render(<PanelClaimStatus panelId="panel-a" />);
    expect(screen.getByText("first.ts")).toBeInTheDocument();

    act(() => state("panel-a", { held: ["first.ts", "second.ts"] }));

    expect(screen.getByText("second.ts")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
  });
});
