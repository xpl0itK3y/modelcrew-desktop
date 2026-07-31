// Правила сигналов: когда тревожить, чем именно и сколько текста показывать.
// Ни звука, ни баннеров, ни окна — значит, ни одного мока и ни одного таймера:
// «сколько времени прошло» здесь просто аргумент.

import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalAttentionNotification } from "./attentionScanner";
import {
  MIN_ALERT_GAP_MS,
  alertPriority,
  classifyTerminalNotification,
  formatAgentAlertDetail,
  formatAlertDetailText,
  isPanelInUse,
  recordDeliveredAlert,
  resetAlertThrottle,
  selectAlertDetail,
  selectMostImportantNotification,
  shouldThrottleAlert,
} from "./alertPolicy";

function notification(
  fields: Partial<TerminalAttentionNotification>,
): TerminalAttentionNotification {
  return { protocol: "osc777", title: "", body: "", types: [], ...fields };
}

describe("classifyTerminalNotification", () => {
  it("reads the event type, the title and the body alike", () => {
    // Агенты кладут смысл кто куда: codex — в тип события, kitty — в тело.
    expect(
      classifyTerminalNotification(notification({ types: ["approval-requested"] })),
    ).toBe("permission");
    expect(
      classifyTerminalNotification(notification({ title: "Agent turn complete" })),
    ).toBe("completed");
    expect(
      classifyTerminalNotification(notification({ body: "Waiting for input" })),
    ).toBe("question");
  });

  it("puts a failure above everything else in the same text", () => {
    // «Не удалось получить разрешение» — это отказ, а не запрос: пользователю
    // важнее узнать, что работа встала.
    expect(
      classifyTerminalNotification(
        notification({ title: "Permission request failed" }),
      ),
    ).toBe("error");
    expect(
      classifyTerminalNotification(notification({ body: "rate limit reached" })),
    ).toBe("error");
  });

  it("falls back to waiting for text it cannot read", () => {
    expect(classifyTerminalNotification(notification({ title: "Codex" }))).toBe(
      "waiting",
    );
  });

  it("ignores separators inside event names", () => {
    // «agent-turn-complete», «Stop» и «session.idle» приходят каждый в своём
    // написании — по подчёркиваниям и дефисам различать их нельзя.
    for (const event of [
      "agent_turn_complete",
      "agent-turn-complete",
      "AGENT TURN COMPLETE",
    ]) {
      expect(classifyTerminalNotification(notification({ types: [event] }))).toBe(
        "completed",
      );
    }
  });
});

describe("selectMostImportantNotification", () => {
  it("picks the most demanding one out of a single chunk", () => {
    const selected = selectMostImportantNotification([
      notification({ title: "Agent turn complete" }),
      notification({ title: "Approval requested" }),
      notification({ title: "Codex" }),
    ]);

    expect(selected.kind).toBe("permission");
    expect(selected.notification.title).toBe("Approval requested");
  });

  it("keeps the first of equally demanding ones", () => {
    const selected = selectMostImportantNotification([
      notification({ title: "Approve npm test" }),
      notification({ title: "Confirm the plan" }),
    ]);

    expect(selected.notification.title).toBe("Approve npm test");
  });

  it("orders a guess with the precise signal it stands in for", () => {
    // Звонок — это «ждёт», тишина — «закончил»: догадка не должна перебивать
    // точный сигнал того же смысла и не должна ему уступать.
    expect(alertPriority("bell")).toBe(alertPriority("waiting"));
    expect(alertPriority("idle")).toBe(alertPriority("completed"));
    expect(alertPriority("error")).toBeGreaterThan(alertPriority("permission"));
    expect(alertPriority("permission")).toBeGreaterThan(alertPriority("question"));
    expect(alertPriority("question")).toBeGreaterThan(alertPriority("waiting"));
    expect(alertPriority("waiting")).toBeGreaterThan(alertPriority("completed"));
  });
});

describe("isPanelInUse", () => {
  it("counts only the panel the user is working in", () => {
    expect(isPanelInUse({ visible: true, focused: true, workspaceId: "ws" }, true)).toBe(
      true,
    );
  });

  it("does not count a neighbour just because it is on screen", () => {
    // Панелей на экране дюжина, работают в одной. Считать «видно» за «смотрит»
    // означало бы гасить сигнал одиннадцати панелей разом.
    expect(
      isPanelInUse({ visible: true, focused: false, workspaceId: "ws" }, true),
    ).toBe(false);
  });

  it("does not count a panel squeezed to nothing that still holds the caret", () => {
    // Придавленная развёрнутым соседом панель каретку не отдаёт, но её не
    // видно — значит, в ней не работают.
    expect(
      isPanelInUse({ visible: false, focused: true, workspaceId: "ws" }, true),
    ).toBe(false);
  });

  it("does not count a panel whose window is away", () => {
    // Фокус ввода внутри окна остаётся за панелью и когда окно ушло на второй
    // план: пользователя там нет ни в одной.
    expect(
      isPanelInUse({ visible: true, focused: true, workspaceId: "ws" }, false),
    ).toBe(false);
  });
});

describe("the quiet window after a delivered alert", () => {
  beforeEach(() => resetAlertThrottle());

  it("lets the first alert of a panel through", () => {
    expect(shouldThrottleAlert("panel", "completed", 1_000)).toBe(false);
  });

  it("holds back a repeat and anything less demanding", () => {
    recordDeliveredAlert("panel", "permission", 1_000);

    expect(shouldThrottleAlert("panel", "permission", 4_000)).toBe(true);
    expect(shouldThrottleAlert("panel", "completed", 4_000)).toBe(true);
  });

  it("lets a more demanding alert through the window", () => {
    recordDeliveredAlert("panel", "completed", 1_000);

    // Агент упёрся в запрос разрешения: работа встала, и молчание здесь
    // обходится дороже лишнего баннера.
    expect(shouldThrottleAlert("panel", "permission", 4_000)).toBe(false);
  });

  it("opens up again once the window has passed", () => {
    recordDeliveredAlert("panel", "error", 1_000);

    expect(shouldThrottleAlert("panel", "idle", 1_000 + MIN_ALERT_GAP_MS - 1)).toBe(
      true,
    );
    expect(shouldThrottleAlert("panel", "idle", 1_000 + MIN_ALERT_GAP_MS)).toBe(
      false,
    );
  });

  it("keeps the window per panel", () => {
    recordDeliveredAlert("panel-1", "permission", 1_000);

    // Двенадцать агентов заканчивают кучно — окно одной панели не должно
    // затыкать остальные.
    expect(shouldThrottleAlert("panel-2", "completed", 1_000)).toBe(false);
  });
});

describe("the agent text that reaches the banner", () => {
  it("prefers the body, collapses whitespace, and caps long text", () => {
    expect(
      formatAgentAlertDetail(
        notification({ title: "Permission needed", body: "  Run\n\n npm   test  " }),
      ),
    ).toBe("Run npm test");

    const formatted = formatAgentAlertDetail(
      notification({ title: "x".repeat(250) }),
    );
    expect(Array.from(formatted)).toHaveLength(200);
    expect(formatted.endsWith("...")).toBe(true);
  });

  it("counts the cap in characters, not in bytes", () => {
    // Кириллица в UTF-8 занимает по два байта: по длине буфера обрезка
    // урезала бы русский текст вдвое.
    const formatted = formatAlertDetailText("я".repeat(250));

    expect(Array.from(formatted)).toHaveLength(200);
  });

  it("strips control characters out of the agent text", () => {
    expect(formatAlertDetailText("Готово\x01\x1f")).toBe("Готово");
  });

  it("says nothing in the brief mode", () => {
    expect(
      selectAlertDetail(
        "brief",
        notification({ body: "Approve npm test" }),
        () => "tail",
      ),
    ).toBe("");
  });

  it("takes the agent's own text in the detailed mode", () => {
    expect(
      selectAlertDetail(
        "detailed",
        notification({ body: "Approve npm test" }),
        () => "tail",
      ),
    ).toBe("Approve npm test");
  });

  it("falls back to the panel tail when the agent sent no text", () => {
    // Звонок и тишина сообщения не несут: без запасного источника «Подробно»
    // ничем не отличалось бы от «Кратко».
    expect(
      selectAlertDetail("detailed", undefined, () => "Готово: обновил 3 файла"),
    ).toBe("Готово: обновил 3 файла");
  });

  it("adds nothing when there is no text at all", () => {
    expect(selectAlertDetail("detailed", undefined, () => null)).toBe("");
  });

  it("does not collect the panel tail unless it is going to be shown", () => {
    // Хвост — это проход по буферу xterm и разбор переносов. В кратком режиме и
    // когда агент прислал свой текст, он не нужен: собирать его, чтобы тут же
    // выбросить, — работа на каждый сигнал в каждой из двенадцати панелей.
    let collected = 0;
    const tail = () => {
      collected += 1;
      return "Готово: обновил 3 файла";
    };

    selectAlertDetail("brief", undefined, tail);
    selectAlertDetail("detailed", notification({ body: "Approve" }), tail);
    expect(collected).toBe(0);

    selectAlertDetail("detailed", undefined, tail);
    expect(collected).toBe(1);
  });
});
