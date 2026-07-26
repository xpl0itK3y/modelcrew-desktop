// Манифест обновления, его release notes и сохранённое состояние уведомлений
// приходят извне: эндпойнт апдейтера, ответ GitHub и localStorage считаются
// подконтрольными атакующему. Здесь проверяется, что фронтенд обращается с
// ними как с произвольными данными.

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn<
    (options?: { timeout?: number; target?: string }) => Promise<Update | null>
  >(),
  invoke: vi.fn<
    (command: string, args?: Record<string, unknown>) => Promise<unknown>
  >(),
  relaunch: vi.fn<() => Promise<void>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

import { setLocale } from "../i18n";
import { notificationFrom } from "./notifications";
import {
  DISMISSED_NOTIFICATIONS_STORAGE_KEY,
  loadDismissedNotificationIds,
  loadReadNotificationIds,
  markNotificationIdsDismissed,
  markNotificationIdsRead,
  READ_NOTIFICATIONS_STORAGE_KEY,
} from "./readNotifications";
import { releaseDetails } from "./releaseNotes";
import type { NotificationCenterState, UpdateNotification } from "./types";
import { UpdatePopover } from "./UpdatePopover";
import { useAppUpdater } from "./useAppUpdater";

const RELEASES_BASE_URL =
  "https://github.com/xpl0itK3y/modelcrew-desktop/releases";
const OFFICIAL_TAG_URL = `${RELEASES_BASE_URL}/tag/v0.0.2`;
const FALLBACK_TITLE_EN = "ModelCrew 0.0.2 update";
const FALLBACK_BODY = "Fallback release body";
const INITIAL_DELAY = 8_000;
const HOUR = 60 * 60 * 1_000;

type ReleaseSource = Pick<Update, "version" | "body" | "rawJson">;

function source(
  rawJson: unknown,
  overrides: { version?: string; body?: string } = {},
): ReleaseSource {
  return {
    version: overrides.version ?? "0.0.2",
    body: overrides.body ?? FALLBACK_BODY,
    // Манифест приходит как произвольный JSON: тесты сознательно подставляют
    // сюда не только объекты.
    rawJson: rawJson as Record<string, unknown>,
  };
}

function notes(payload: unknown, locale: "ru" | "en" = "en"): ReleaseSource {
  return source({ modelcrew: { releaseNotes: { [locale]: payload } } });
}

// Значения releaseUrl, которые не должны попасть ни в карточку, ни в openUrl.
const HOSTILE_RELEASE_URLS: string[] = [
  "javascript:alert(1)",
  " javascript:alert(1)",
  "\tjavascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "blob:https://github.com/00000000",
  "//evil.example/xpl0itK3y/modelcrew-desktop/releases/",
  "https://evil.example/download",
  "https://github.com@evil.example/xpl0itK3y/modelcrew-desktop/releases/",
  "https://github.com.evil.example/xpl0itK3y/modelcrew-desktop/releases/",
  "https://raw.githubusercontent.com/xpl0itK3y/modelcrew-desktop/releases/",
  "http://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v0.0.2",
  "https://github.com/xpl0itK3y/modelcrew-desktop/releases/../../../evil",
  "https://github.com/other/repo/releases/tag/v0.0.2",
];

describe("hostile release notes payloads", () => {
  it("ignores notes published for another locale", () => {
    const details = releaseDetails(
      notes(
        {
          title: "Заголовок из манифеста",
          summary: "Описание из манифеста",
          highlights: ["Пункт"],
        },
        "ru",
      ),
      "en",
    );

    expect(details.title).toBe(FALLBACK_TITLE_EN);
    expect(details.summary).toBe(FALLBACK_BODY);
    expect(details.highlights).toEqual([]);
  });

  it("ignores a locale entry that is not an object", () => {
    for (const payload of [
      "<b>notes</b>",
      42,
      null,
      true,
      ["title", "summary"],
    ]) {
      const details = releaseDetails(notes(payload), "en");
      expect(details.title).toBe(FALLBACK_TITLE_EN);
      expect(details.highlights).toEqual([]);
    }
  });

  it("ignores release notes hidden behind a __proto__ key", () => {
    // JSON.parse кладёт "__proto__" собственным свойством: подстановка локали
    // через прототип не должна ни сработать, ни отравить Object.
    const rawJson: unknown = JSON.parse(
      '{"modelcrew":{"releaseNotes":{"__proto__":{"en":{"title":"Injected","summary":"Injected","highlights":["x"]}}}}}',
    );
    const details = releaseDetails(source(rawJson), "en");

    expect(details.title).toBe(FALLBACK_TITLE_EN);
    expect(details.highlights).toEqual([]);
    expect(Object.prototype).not.toHaveProperty("en");
    expect(({} as Record<string, unknown>).en).toBeUndefined();
  });

  it("rejects a title or summary that is not a string", () => {
    for (const payload of [
      { title: {}, summary: "ok", highlights: ["ok"] },
      { title: 42, summary: "ok", highlights: ["ok"] },
      { title: ["ok"], summary: "ok", highlights: ["ok"] },
      { title: "ok", summary: null, highlights: ["ok"] },
      { title: "ok", summary: { toString: "not called" }, highlights: ["ok"] },
    ]) {
      const details = releaseDetails(notes(payload), "en");
      expect(details.title).toBe(FALLBACK_TITLE_EN);
      expect(details.summary).toBe(FALLBACK_BODY);
      expect(details.highlights).toEqual([]);
    }
  });

  it("rejects a highlights collection that is not a bounded string array", () => {
    for (const highlights of [
      "not an array",
      [],
      ["ok", { title: "nested" }],
      ["ok", ["nested"]],
      ["ok", null],
      ["1", "2", "3", "4", "5", "6"],
      Array.from({ length: 500 }, (_, index) => `highlight ${index}`),
    ]) {
      const details = releaseDetails(
        notes({ title: "Title", summary: "Summary", highlights }),
        "en",
      );
      expect(details.highlights).toEqual([]);
      expect(details.title).toBe(FALLBACK_TITLE_EN);
    }
  });

  it("drops oversized manifest strings instead of rendering them", () => {
    const enormous = "A".repeat(200_000);
    const details = releaseDetails(
      notes({ title: enormous, summary: enormous, highlights: [enormous] }),
      "en",
    );

    expect(details.title).toBe(FALLBACK_TITLE_EN);
    expect(details.summary).toBe(FALLBACK_BODY);
    expect(details.highlights).toEqual([]);
  });

  it("measures the note limits in code points", () => {
    const accepted = releaseDetails(
      notes({
        title: "Title",
        summary: "Summary",
        highlights: ["😀".repeat(120)],
      }),
      "en",
    );
    const rejected = releaseDetails(
      notes({
        title: "Title",
        summary: "Summary",
        highlights: ["😀".repeat(121)],
      }),
      "en",
    );

    expect(accepted.highlights).toEqual(["😀".repeat(120)]);
    expect(rejected.highlights).toEqual([]);
  });

  it("bounds the fallback summary taken from an oversized body or notes field", () => {
    const fromBody = releaseDetails(
      source({}, { body: "b".repeat(50_000) }),
      "en",
    );
    const fromNotes = releaseDetails(
      source({ notes: "n".repeat(50_000) }, { body: "" }),
      "en",
    );

    for (const details of [fromBody, fromNotes]) {
      expect(Array.from(details.summary)).toHaveLength(200);
      expect(details.summary.endsWith("…")).toBe(true);
    }
  });

  it("removes NUL, ANSI escapes and other control characters", () => {
    const details = releaseDetails(
      notes({
        title: "\u001b[31mRed \u0000 title",
        summary: "Summary\u001b]0;window title\u0007 escapes",
        highlights: ["High\u0000light", "Bell\u0007\u009blight"],
      }),
      "en",
    );

    for (const value of [details.title, details.summary, ...details.highlights]) {
      expect(value).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(details.title).toBe("[31mRed title");
    expect(details.highlights).toEqual(["High light", "Bell light"]);
  });

  it("rejects notes that collapse to nothing but whitespace", () => {
    const details = releaseDetails(
      notes({ title: " \t\n  ", summary: "Summary", highlights: ["ok"] }),
      "en",
    );

    expect(details.title).toBe(FALLBACK_TITLE_EN);
    expect(details.highlights).toEqual([]);
  });

  it("keeps HTML from the manifest as literal text", () => {
    const details = releaseDetails(
      notes({
        title: '<img src=x onerror="alert(1)">',
        summary: "<script>alert(document.cookie)</script>",
        highlights: ['<iframe src="javascript:alert(1)"></iframe>'],
      }),
      "en",
    );

    expect(details.title).toBe('<img src=x onerror="alert(1)">');
    expect(details.summary).toBe("<script>alert(document.cookie)</script>");
    expect(details.highlights).toEqual([
      '<iframe src="javascript:alert(1)"></iframe>',
    ]);
  });

  it("survives a deeply nested or cyclic manifest without throwing", () => {
    let deep: Record<string, unknown> = { title: "buried" };
    for (let index = 0; index < 5_000; index += 1) {
      deep = { nested: deep };
    }
    const cyclic: Record<string, unknown> = { summary: "cyclic" };
    cyclic.self = cyclic;

    const details = releaseDetails(
      notes({ title: deep, summary: cyclic, highlights: [deep] }),
      "en",
    );

    expect(details.title).toBe(FALLBACK_TITLE_EN);
    expect(details.summary).toBe(FALLBACK_BODY);
    expect(details.highlights).toEqual([]);
  });

  it("ignores a manifest that is not an object at all", () => {
    for (const rawJson of ["", "a string", 42, null, [], ["modelcrew"]]) {
      const details = releaseDetails(source(rawJson), "en");
      expect(details.title).toBe(FALLBACK_TITLE_EN);
      expect(details.releaseUrl).toBe(OFFICIAL_TAG_URL);
    }
  });
});

describe("release URL from an untrusted manifest", () => {
  it.each(HOSTILE_RELEASE_URLS)(
    "falls back to the project releases page for %s",
    (releaseUrl) => {
      const details = releaseDetails(source({ modelcrew: { releaseUrl } }), "en");
      expect(details.releaseUrl).toBe(OFFICIAL_TAG_URL);
    },
  );

  it("falls back when the release URL is not a usable string", () => {
    for (const releaseUrl of [
      null,
      42,
      true,
      { href: OFFICIAL_TAG_URL },
      [OFFICIAL_TAG_URL],
      "",
    ]) {
      const details = releaseDetails(source({ modelcrew: { releaseUrl } }), "en");
      expect(details.releaseUrl).toBe(OFFICIAL_TAG_URL);
    }
  });

  it("keeps an official release URL and normalizes its host casing", () => {
    const details = releaseDetails(
      source({
        modelcrew: {
          releaseUrl:
            "https://GitHub.COM/xpl0itK3y/modelcrew-desktop/releases/tag/v0.0.2",
        },
      }),
      "en",
    );

    expect(details.releaseUrl).toBe(OFFICIAL_TAG_URL);
  });

  it("escapes a hostile version into the fallback release URL", () => {
    for (const version of [
      "../../../../other/repo/releases/tag/v1",
      "javascript:alert(1)",
      "0.0.2?x=1#evil",
      "0.0.2 https://evil.example",
      "",
      "9".repeat(1_000),
    ]) {
      const details = releaseDetails(
        source({ modelcrew: { releaseUrl: 42 } }, { version }),
        "en",
      );
      const url = new URL(details.releaseUrl);

      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("github.com");
      expect(
        url.pathname.startsWith("/xpl0itK3y/modelcrew-desktop/releases/tag/v"),
      ).toBe(true);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
  });
});

describe("rendering untrusted notification content", () => {
  function renderPopover(center: NotificationCenterState) {
    const callbacks = {
      onInstall: vi.fn(),
      onOpenRelease: vi.fn(),
      onDismiss: vi.fn(),
      onClose: vi.fn(),
    };
    render(createElement(UpdatePopover, { center, ...callbacks }));
    return callbacks;
  }

  function hostileNotification(
    overrides: Partial<UpdateNotification> = {},
  ): UpdateNotification {
    const notification = notificationFrom(
      notes(
        {
          title: '<img src=x onerror="alert(1)">',
          summary: "<script>alert(document.cookie)</script>",
          highlights: ['<iframe src="javascript:alert(1)"></iframe>'],
        },
        "ru",
      ),
      "ru",
      "selfUpdate",
      "ready",
    );
    return { ...notification, ...overrides };
  }

  afterEach(() => setLocale("ru"));

  it("puts manifest markup into the DOM as text, never as elements", () => {
    renderPopover({ sync: "settled", items: [hostileNotification()] });

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.innerHTML).toContain("&lt;img src=x");
    expect(
      screen.getByRole("heading", { name: '<img src=x onerror="alert(1)">' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("<script>alert(document.cookie)</script>"),
    ).toBeInTheDocument();
    expect(
      screen.getByText('<iframe src="javascript:alert(1)"></iframe>'),
    ).toBeInTheDocument();
  });

  it("renders a hostile version label as text without creating elements", () => {
    renderPopover({
      sync: "settled",
      items: [
        hostileNotification({
          id: "update:<svg onload=alert(1)>",
          version: "<svg onload=alert(1)>",
        }),
      ],
    });

    expect(document.querySelector("svg[onload]")).toBeNull();
    expect(
      screen.getByText("ModelCrew <svg onload=alert(1)>"),
    ).toBeInTheDocument();
  });

  it("never renders the release URL as a link or visible text", () => {
    // Ссылку открывает бэкенд через openUrl: URL не попадает в DOM, поэтому
    // подменённый releaseUrl нельзя открыть кликом мимо проверки.
    renderPopover({
      sync: "settled",
      items: [
        hostileNotification({
          installKind: "manual",
          phase: "manual",
          title: "Update ready",
          summary: "Manual installation",
          highlights: [],
          releaseUrl: "javascript:alert('hostile-release-url')",
        }),
      ],
    });

    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("[href]")).toBeNull();
    expect(document.body.innerHTML).not.toContain("hostile-release-url");
    expect(document.body.innerHTML).not.toContain("javascript:");
  });

  it("passes no URL to the release affordance", () => {
    const callbacks = renderPopover({
      sync: "settled",
      items: [
        hostileNotification({
          installKind: "manual",
          phase: "manual",
          releaseUrl: "https://evil.example/download",
        }),
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Открыть страницу загрузки" }),
    );

    expect(callbacks.onOpenRelease).toHaveBeenCalledTimes(1);
    const stringArguments = callbacks.onOpenRelease.mock.calls
      .flat()
      .filter((argument) => typeof argument === "string");
    expect(stringArguments).toEqual([]);
  });

  it("renders at most five highlights from a poisoned notification", () => {
    renderPopover({
      sync: "settled",
      items: [
        hostileNotification({
          highlights: Array.from(
            { length: 500 },
            (_, index) => `highlight ${index}`,
          ),
        }),
      ],
    });

    expect(document.querySelectorAll(".update-highlights li")).toHaveLength(5);
    expect(screen.queryByText("highlight 400")).not.toBeInTheDocument();
  });
});

describe("poisoned notification storage", () => {
  const STORAGE_KEYS: string[] = [
    READ_NOTIFICATIONS_STORAGE_KEY,
    DISMISSED_NOTIFICATIONS_STORAGE_KEY,
  ];

  function readerFor(key: string) {
    return key === READ_NOTIFICATIONS_STORAGE_KEY
      ? loadReadNotificationIds
      : loadDismissedNotificationIds;
  }

  beforeEach(() => window.localStorage.clear());

  it.each(STORAGE_KEYS)("recovers from malformed content in %s", (key) => {
    const load = readerFor(key);
    for (const stored of [
      "not-json",
      "{",
      "null",
      "42",
      '"update:0.0.2"',
      '{"0":"update:0.0.2","length":1}',
      '{"ids":["update:0.0.2"]}',
      '[["update:0.0.2"]]',
      '[{"id":"update:0.0.2"}]',
      "[1,2,3]",
      "[null,false]",
    ]) {
      localStorage.setItem(key, stored);
      expect(load()).toEqual([]);
    }
  });

  it.each(STORAGE_KEYS)("keeps only string ids stored under %s", (key) => {
    const load = readerFor(key);
    localStorage.setItem(
      key,
      JSON.stringify([
        "update:0.0.2",
        7,
        null,
        { id: "update:0.0.3" },
        ["update:0.0.4"],
        "announcement:one",
        "update:0.0.2",
      ]),
    );

    // Дубликат схлопывается к самому свежему вхождению, объекты и числа
    // отбрасываются: наружу выходят только строковые id.
    expect(load()).toEqual(["announcement:one", "update:0.0.2"]);
  });

  it.each(STORAGE_KEYS)("does not pollute Object.prototype from %s", (key) => {
    const load = readerFor(key);
    for (const stored of [
      '{"__proto__":{"polluted":"yes"}}',
      '[{"__proto__":{"polluted":"yes"}}]',
      '{"constructor":{"prototype":{"polluted":"yes"}}}',
    ]) {
      localStorage.setItem(key, stored);
      expect(load()).toEqual([]);
      expect(Object.prototype).not.toHaveProperty("polluted");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("treats prototype-shaped ids as ordinary strings", () => {
    const poisonous = ["__proto__", "constructor", "prototype", "toString"];
    const saved = markNotificationIdsRead([], poisonous);

    expect(saved).toEqual(poisonous);
    expect(loadReadNotificationIds()).toEqual(poisonous);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(typeof Object.prototype.toString).toBe("function");
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("caps a flooded read list on load and on save", () => {
    const flood = Array.from({ length: 5_000 }, (_, index) => `update:${index}`);
    localStorage.setItem(
      READ_NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify([...flood, "x".repeat(200_000)]),
    );

    expect(loadReadNotificationIds()).toHaveLength(100);

    const saved = markNotificationIdsRead(flood, ["update:fresh"]);
    expect(saved).toHaveLength(100);
    expect(saved[saved.length - 1]).toBe("update:fresh");
    expect(
      JSON.parse(localStorage.getItem(READ_NOTIFICATIONS_STORAGE_KEY) ?? "[]"),
    ).toHaveLength(100);
  });

  it("caps a flooded dismissed list and leaves the read list alone", () => {
    markNotificationIdsRead([], ["update:0.0.2"]);
    const flood = Array.from(
      { length: 5_000 },
      (_, index) => `announcement:${index}`,
    );

    const saved = markNotificationIdsDismissed([], flood);

    expect(saved).toHaveLength(100);
    expect(loadDismissedNotificationIds()).toHaveLength(100);
    expect(loadReadNotificationIds()).toEqual(["update:0.0.2"]);
  });

  it("survives a storage backend that throws on read and write", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(loadReadNotificationIds()).toEqual([]);
    expect(loadDismissedNotificationIds()).toEqual([]);
    expect(markNotificationIdsRead([], ["update:0.0.2"])).toEqual([
      "update:0.0.2",
    ]);
    expect(markNotificationIdsDismissed([], ["announcement:one"])).toEqual([
      "announcement:one",
    ]);
  });
});

describe("manifest driven updater wiring", () => {
  function makeUpdate(
    overrides: { version?: string; body?: string; rawJson?: unknown } = {},
  ) {
    const close = vi.fn(async () => {});
    const version = overrides.version ?? "0.0.2";
    const update = {
      available: true,
      currentVersion: "0.0.1",
      version,
      body: overrides.body ?? `ModelCrew ${version}`,
      rawJson:
        "rawJson" in overrides
          ? overrides.rawJson
          : {
              modelcrew: { releaseUrl: `${RELEASES_BASE_URL}/tag/v${version}` },
            },
      download: vi.fn(async () => {}),
      install: vi.fn(async () => {}),
      close,
    } as unknown as Update;
    return { update, close };
  }

  async function advance(milliseconds: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  }

  function prepareSelfUpdateCalls() {
    return mocks.invoke.mock.calls.filter(
      ([command]) => command === "updater_prepare_self_update",
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValue({ mode: "selfUpdate" });
    mocks.relaunch.mockResolvedValue();
    mocks.openUrl.mockResolvedValue();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    "javascript:alert(1)",
    "https://evil.example/download",
    "https://github.com@evil.example/x",
    "https://github.com/other/repo/releases/tag/v0.0.2",
    "file:///etc/passwd",
  ])(
    "hands the opener only the project releases page for manifest URL %s",
    async (releaseUrl) => {
      const candidate = makeUpdate({ rawJson: { modelcrew: { releaseUrl } } });
      mocks.check.mockResolvedValue(candidate.update);
      const { result } = renderHook(() =>
        useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
      );

      await advance(INITIAL_DELAY);
      await act(async () => {
        await result.current.openRelease();
      });

      expect(mocks.openUrl).toHaveBeenCalledTimes(1);
      expect(mocks.openUrl).toHaveBeenCalledWith(OFFICIAL_TAG_URL);
    },
  );

  it("opens the manifest URL only when it points at the project releases", async () => {
    const trusted = `${RELEASES_BASE_URL}/download/v0.0.2/ModelCrew.dmg`;
    const candidate = makeUpdate({
      rawJson: { modelcrew: { releaseUrl: trusted } },
    });
    mocks.check.mockResolvedValue(candidate.update);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    await act(async () => {
      await result.current.openRelease();
    });

    expect(mocks.openUrl).toHaveBeenCalledWith(trusted);
  });

  it.each(["", "not-a-version", "0.0.1", "0.0.3-rc.1", "0.0.3"])(
    "does not replace a prepared update with version %s",
    async (version) => {
      const ready = makeUpdate({ version: "0.0.3" });
      const impostor = makeUpdate({ version });
      mocks.check
        .mockResolvedValueOnce(ready.update)
        .mockResolvedValue(impostor.update);
      const { result } = renderHook(() =>
        useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
      );

      await advance(INITIAL_DELAY);
      expect(result.current.center.items[0]).toEqual(
        expect.objectContaining({ phase: "ready", version: "0.0.3" }),
      );

      await advance(4 * HOUR);

      // Проверенный и подготовленный артефакт не подменяется мусорной или
      // более старой версией из следующего ответа эндпойнта.
      expect(impostor.close).toHaveBeenCalled();
      expect(prepareSelfUpdateCalls()).toHaveLength(1);
      expect(result.current.center.items).toHaveLength(1);
      expect(result.current.center.items[0]).toEqual(
        expect.objectContaining({ phase: "ready", version: "0.0.3" }),
      );
    },
  );

  it("refuses to dismiss an update card even when asked by its id", async () => {
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    act(() => {
      result.current.dismissNotification("update:0.0.2");
    });

    expect(result.current.center.items).toHaveLength(1);
    expect(localStorage.getItem(DISMISSED_NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  });
});
