// Отрисовка diff-а: выбор раскладки, подсветка правки внутри строки и то, что
// показывается вместо самого diff-а.
//
// Проверяется напрямую: одна и та же отрисовка используется карточкой файла,
// коммитом и сравнением состояний, а панельный тест смотрит только на первую.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { parseUnifiedDiff } from "../../git/unifiedDiff";
import {
  DiffBody,
  DiffText,
  DiffViewToggle,
  loadDiffView,
  saveDiffView,
} from "./DiffView";

const SAMPLE = `@@ -1,3 +1,3 @@
 context
-const timeout = 100;
+const timeout = 500;
`;

function diff(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/app.ts",
    isBinary: false,
    truncated: false,
    diff: SAMPLE,
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => setLocale("ru"));

describe("diff layout choice", () => {
  it("defaults to two columns and survives a restart", () => {
    expect(loadDiffView()).toBe("split");

    saveDiffView("unified");
    expect(loadDiffView()).toBe("unified");

    saveDiffView("split");
    expect(loadDiffView()).toBe("split");
  });

  it("falls back to two columns on junk in the storage", () => {
    localStorage.setItem("modelcrew.diffView", "sideways");

    expect(loadDiffView()).toBe("split");
  });

  it("offers the layout the user is not looking at", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DiffViewToggle view="split" onChange={onChange} />,
    );

    // В сплите кнопка предлагает единый список, и наоборот — иначе она
    // выглядела бы как «включить то, что уже включено».
    fireEvent.click(
      screen.getByRole("button", { name: "Показать одной колонкой" }),
    );
    expect(onChange).toHaveBeenCalledWith("unified");

    rerender(<DiffViewToggle view="unified" onChange={onChange} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Показать «было» и «стало» рядом" }),
    );
    expect(onChange).toHaveBeenLastCalledWith("split");
  });
});

describe("DiffBody", () => {
  it("puts the old and the new line side by side in the split layout", () => {
    const { container } = render(
      <DiffBody diff={diff()} failed={false} view="split" />,
    );

    // Правку показывают в одной строке таблицы: слева было, справа стало.
    const rows = Array.from(container.querySelectorAll(".git-diff-row"));
    const changed = rows.find((row) => row.querySelector(".is-del"))!;

    expect(changed.querySelector(".is-del")).toHaveTextContent(
      "const timeout = 100;",
    );
    expect(changed.querySelector(".is-add")).toHaveTextContent(
      "const timeout = 500;",
    );
    // Контекст стоит своей строкой выше, а не смешивается с правкой.
    expect(rows[0]).toHaveTextContent("context");
    expect(rows.indexOf(changed)).toBe(1);
  });

  it("keeps the removal above the addition in the unified layout", () => {
    const { container } = render(
      <DiffBody diff={diff()} failed={false} view="unified" />,
    );

    const lines = Array.from(container.querySelectorAll(".git-diff-line"));
    expect(lines.map((line) => line.className.split(" ").pop())).toEqual([
      "is-context",
      "is-del",
      "is-add",
    ]);
    // Знак — украшение для глаза, а не текст строки: он спрятан от чтения.
    expect(container.querySelector(".git-diff-sign")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("says what happened instead of drawing an empty diff", () => {
    const { rerender, container } = render(
      <DiffBody diff={null} failed={false} view="split" />,
    );
    expect(screen.getByText("Загружаем diff…")).toBeInTheDocument();

    rerender(<DiffBody diff={null} failed view="split" />);
    expect(screen.getByText("Не удалось получить diff")).toBeInTheDocument();

    rerender(
      <DiffBody diff={diff({ isBinary: true })} failed={false} view="split" />,
    );
    expect(container.querySelector(".git-diff")).toBeNull();
  });

  it("warns when the diff was cut short", () => {
    render(
      <DiffBody diff={diff({ truncated: true })} failed={false} view="split" />,
    );

    expect(
      screen.getByText("Diff обрезан: изменения слишком большие"),
    ).toBeInTheDocument();
  });
});

describe("DiffText", () => {
  it("highlights only the part that actually changed", () => {
    const { container } = render(
      <DiffText
        text="const timeout = 500;"
        pair={{ before: "const timeout = 100;", after: "const timeout = 500;" }}
        side="right"
      />,
    );

    // Общее начало и хвост остаются обычными — глаз находит саму правку.
    expect(container.querySelector("mark")).toHaveTextContent("5");
    expect(container.textContent).toBe("const timeout = 500;");
  });

  it("leaves a pure insertion unmarked on the old side", () => {
    const { container } = render(
      <DiffText
        text="const timeout = 500;"
        pair={{ before: "const timeout = ;", after: "const timeout = 500;" }}
        side="left"
      />,
    );

    expect(container.querySelector("mark")).toBeNull();
  });

  it("marks nothing without a counterpart line", () => {
    const lines = parseUnifiedDiff(SAMPLE);
    const added = lines.find((line) => line.kind === "add")!;

    const { container } = render(
      <DiffText text={added.text} pair={null} side="right" />,
    );

    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("const timeout = 500;");
  });
});
