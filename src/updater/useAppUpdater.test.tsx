import { act, renderHook } from "@testing-library/react";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import type { UpdateNotification } from "./types";
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

import { useAppUpdater } from "./useAppUpdater";

const INITIAL_DELAY = 8_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type UpdateDouble = {
  update: Update;
  download: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeUpdate(
  overrides: {
    version?: string;
    body?: string;
    rawJson?: unknown;
    download?: (
      onEvent?: (event: DownloadEvent) => void,
    ) => Promise<void>;
    install?: () => Promise<void>;
    close?: () => Promise<void>;
  } = {},
): UpdateDouble {
  const download = vi.fn(
    overrides.download ??
      (async (onEvent?: (event: DownloadEvent) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: 12 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 12 } });
        onEvent?.({ event: "Finished" });
      }),
  );
  const install = vi.fn(overrides.install ?? (async () => {}));
  const close = vi.fn(overrides.close ?? (async () => {}));
  const version = overrides.version ?? "0.0.2";
  const update = {
    available: true,
    currentVersion: "0.0.1",
    version,
    body: overrides.body ?? `ModelCrew ${version}`,
    rawJson:
      overrides.rawJson ??
      {
        modelcrew: {
          releaseUrl: `https://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v${version}`,
        },
      },
    download,
    install,
    close,
  } as unknown as Update;

  return { update, download, install, close };
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function dispatchWindowEvent(name: "focus" | "online") {
  await act(async () => {
    window.dispatchEvent(new Event(name));
    await vi.advanceTimersByTimeAsync(0);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useAppUpdater", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    mocks.invoke.mockResolvedValue({ mode: "selfUpdate" });
    mocks.relaunch.mockResolvedValue();
    mocks.openUrl.mockResolvedValue();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("starts the first check automatically after eight seconds", async () => {
    mocks.check.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    expect(result.current.enabled).toBe(true);
    expect(result.current.center).toEqual({ sync: "initial", items: [] });

    await advance(INITIAL_DELAY - 1);
    expect(mocks.check).not.toHaveBeenCalled();

    await advance(1);
    expect(mocks.invoke).toHaveBeenCalledWith("updater_install_target");
    expect(mocks.check).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(result.current.center).toEqual({ sync: "settled", items: [] });
  });

  it("rejects a legacy or malformed install target before checking", async () => {
    mocks.invoke.mockResolvedValue("selfUpdate");
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);

    expect(mocks.check).not.toHaveBeenCalled();
    expect(result.current.center).toEqual({ sync: "retrying", items: [] });
  });

  it("checks immediately when the center opens before the first attempt", async () => {
    mocks.check.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await act(async () => {
      await result.current.ensureChecked();
    });
    expect(mocks.check).toHaveBeenCalledTimes(1);

    await advance(INITIAL_DELAY);
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it("downloads a self-update without a click and exposes it as ready", async () => {
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);

    expect(candidate.download).toHaveBeenCalledTimes(1);
    expect(candidate.download).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 10 * 60 * 1_000 },
    );
    expect(result.current.center.sync).toBe("settled");
    expect(result.current.center.items).toEqual([
      expect.objectContaining({
        id: "update:0.0.2",
        kind: "update",
        phase: "ready",
        version: "0.0.2",
      }),
    ]);
  });

  it("keeps the downloaded resource when a periodic check returns the same version", async () => {
    const downloaded = makeUpdate({ version: "0.0.2" });
    const duplicate = makeUpdate({ version: "0.0.2" });
    mocks.check
      .mockResolvedValueOnce(downloaded.update)
      .mockResolvedValueOnce(duplicate.update);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    const readyNotification = result.current.center.items[0];
    await advance(4 * HOUR - INITIAL_DELAY);

    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(duplicate.download).not.toHaveBeenCalled();
    expect(duplicate.close).toHaveBeenCalledTimes(1);
    expect(downloaded.close).not.toHaveBeenCalled();
    expect(result.current.center.items[0]).toEqual(readyNotification);
  });

  it("replaces a ready update when a newer version appears", async () => {
    const first = makeUpdate({ version: "0.0.2" });
    const newer = makeUpdate({ version: "0.0.3" });
    mocks.check
      .mockResolvedValueOnce(first.update)
      .mockResolvedValueOnce(newer.update);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "ready", version: "0.0.2" }),
    );

    await advance(4 * HOUR - INITIAL_DELAY);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(newer.download).toHaveBeenCalledTimes(1);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({
        id: "update:0.0.3",
        phase: "ready",
        version: "0.0.3",
      }),
    );
  });

  it("settles quietly when no update exists", async () => {
    mocks.check.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "en", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);

    expect(result.current.center).toEqual({ sync: "settled", items: [] });
  });

  it("backs off check failures by one then five minutes without an item", async () => {
    mocks.check
      .mockRejectedValueOnce(new Error("404 latest.json"))
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    expect(result.current.center).toEqual({ sync: "retrying", items: [] });

    await advance(MINUTE - 1);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(result.current.center).toEqual({ sync: "retrying", items: [] });

    await advance(5 * MINUTE - 1);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mocks.check).toHaveBeenCalledTimes(3);
    expect(result.current.center).toEqual({ sync: "settled", items: [] });
  });

  it("uses the full one, five, fifteen, sixty and four-hour retry chain", async () => {
    mocks.check
      .mockRejectedValueOnce(new Error("failure 1"))
      .mockRejectedValueOnce(new Error("failure 2"))
      .mockRejectedValueOnce(new Error("failure 3"))
      .mockRejectedValueOnce(new Error("failure 4"))
      .mockRejectedValueOnce(new Error("failure 5"))
      .mockRejectedValueOnce(new Error("failure 6"))
      .mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    expect(mocks.check).toHaveBeenCalledTimes(1);

    for (const [delay, expectedCalls] of [
      [MINUTE, 2],
      [5 * MINUTE, 3],
      [15 * MINUTE, 4],
      [HOUR, 5],
      [4 * HOUR, 6],
      [4 * HOUR, 7],
    ] as const) {
      await advance(delay - 1);
      expect(mocks.check).toHaveBeenCalledTimes(expectedCalls - 1);
      await advance(1);
      expect(mocks.check).toHaveBeenCalledTimes(expectedCalls);
    }

    expect(result.current.center).toEqual({ sync: "settled", items: [] });
  });

  it("lets active backoff block focus and periodic checks but not online recovery", async () => {
    mocks.check
      .mockRejectedValueOnce(new Error("failure 1"))
      .mockRejectedValueOnce(new Error("failure 2"))
      .mockRejectedValueOnce(new Error("failure 3"))
      .mockRejectedValueOnce(new Error("failure 4"))
      .mockRejectedValueOnce(new Error("failure 5"))
      .mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    await advance(MINUTE);
    await advance(5 * MINUTE);
    await advance(15 * MINUTE);
    await advance(HOUR);
    expect(mocks.check).toHaveBeenCalledTimes(5);
    expect(result.current.center.sync).toBe("retrying");

    await advance(30 * MINUTE);
    await dispatchWindowEvent("focus");
    expect(mocks.check).toHaveBeenCalledTimes(5);

    await advance(4 * HOUR - (HOUR + 21 * MINUTE + INITIAL_DELAY));
    expect(mocks.check).toHaveBeenCalledTimes(5);

    await dispatchWindowEvent("online");
    expect(mocks.check).toHaveBeenCalledTimes(6);
    expect(result.current.center).toEqual({ sync: "settled", items: [] });
  });

  it("retries immediately when connectivity returns", async () => {
    mocks.check
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    expect(result.current.center.sync).toBe("retrying");

    await dispatchWindowEvent("online");
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(result.current.center).toEqual({ sync: "settled", items: [] });

    await advance(MINUTE);
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("shows downloadRetry and retries the download automatically", async () => {
    const first = makeUpdate({
      download: async () => {
        throw new Error("temporary CDN failure");
      },
    });
    const second = makeUpdate();
    mocks.check
      .mockResolvedValueOnce(first.update)
      .mockResolvedValueOnce(second.update);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    expect(result.current.center.sync).toBe("retrying");
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "downloadRetry", version: "0.0.2" }),
    );
    expect(first.close).toHaveBeenCalledTimes(1);

    await advance(MINUTE);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(second.download).toHaveBeenCalledTimes(1);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "ready", version: "0.0.2" }),
    );
  });

  it("downloads and verifies a native Linux package in the background", async () => {
    const prepared = deferred<void>();
    let progress:
      | { onmessage: (message: unknown) => void }
      | undefined;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "updater_install_target") {
        return {
          mode: "nativePackage",
          packageKind: "deb",
          target: "linux-x86_64-deb",
        };
      }
      if (command === "updater_prepare_linux_package") {
        progress = args?.onProgress as typeof progress;
        return prepared.promise;
      }
    });
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);

    expect(candidate.download).not.toHaveBeenCalled();
    expect(candidate.close).toHaveBeenCalledTimes(1);
    expect(mocks.check).toHaveBeenCalledWith({
      timeout: 30_000,
      target: "linux-x86_64-deb",
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "updater_prepare_linux_package",
      expect.objectContaining({ version: "0.0.2", onProgress: expect.anything() }),
    );
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({
        installKind: "nativePackage",
        phase: "downloading",
      }),
    );

    await act(async () => {
      progress?.onmessage({
        phase: "downloading",
        downloaded: 25,
        total: 100,
      });
    });
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({
        phase: "downloading",
        downloaded: 25,
        total: 100,
      }),
    );

    await advance(100);
    await act(async () => {
      progress?.onmessage({
        phase: "downloading",
        downloaded: 50,
      });
    });
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({
        phase: "downloading",
        downloaded: 50,
        total: 100,
      }),
    );

    await act(async () => {
      progress?.onmessage({ phase: "verifying" });
    });
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "verifying" }),
    );

    await act(async () => {
      prepared.resolve();
      await Promise.resolve();
    });
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "ready", version: "0.0.2" }),
    );

    await act(async () => {
      progress?.onmessage({ phase: "downloading", downloaded: 100 });
    });
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "ready", version: "0.0.2" }),
    );
  });

  it("ignores queued native progress after a failed preparation", async () => {
    let progress:
      | { onmessage: (message: unknown) => void }
      | undefined;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "updater_install_target") {
        return {
          mode: "nativePackage",
          packageKind: "rpm",
          target: "linux-x86_64-rpm",
        };
      }
      if (command === "updater_prepare_linux_package") {
        progress = args?.onProgress as typeof progress;
        throw new Error("temporary native download failure");
      }
    });
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "downloadRetry" }),
    );

    await act(async () => {
      progress?.onmessage({ phase: "verifying" });
    });
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "downloadRetry" }),
    );
  });

  it("keeps a manual fallback only for unsupported installations", async () => {
    mocks.invoke.mockResolvedValue({ mode: "manual" });
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);

    expect(candidate.download).not.toHaveBeenCalled();
    expect(candidate.close).toHaveBeenCalledTimes(1);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({
        installKind: "manual",
        phase: "manual",
        version: "0.0.2",
      }),
    );
  });

  it("keeps PTYs running when native authorization is cancelled", async () => {
    const rawMessage = "private polkit diagnostic";
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "updater_install_target") {
        return {
          mode: "nativePackage",
          packageKind: "deb",
          target: "linux-x86_64-deb",
        };
      }
      if (command === "updater_install_linux_package") {
        throw {
          code: "updater_authorization_cancelled",
          debug: rawMessage,
        };
      }
    });
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const beforeInstall = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall }),
    );
    await advance(INITIAL_DELAY);

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "updater_install_linux_package",
      { version: "0.0.2" },
    );
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(candidate.install).not.toHaveBeenCalled();
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "authorizationCancelled" }),
    );
    expect(JSON.stringify(result.current.center)).not.toContain(rawMessage);
  });

  it("redownloads a native package when its prepared cache disappears", async () => {
    let prepareCalls = 0;
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "updater_install_target") {
        return {
          mode: "nativePackage",
          packageKind: "deb",
          target: "linux-x86_64-deb",
        };
      }
      if (command === "updater_prepare_linux_package") {
        prepareCalls += 1;
      }
      if (command === "updater_install_linux_package") {
        throw { code: "updater_cache_missing" };
      }
    });
    mocks.check.mockResolvedValue(makeUpdate().update);
    const beforeInstall = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall }),
    );
    await advance(INITIAL_DELAY);

    await act(async () => {
      await result.current.installUpdate();
    });
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(result.current.center).toEqual(
      expect.objectContaining({
        sync: "retrying",
        items: [expect.objectContaining({ phase: "downloadRetry" })],
      }),
    );

    await advance(MINUTE);
    expect(prepareCalls).toBe(2);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "ready" }),
    );
  });

  it("installs a native package before stopping PTYs and never reinstalls on restart retry", async () => {
    const order: string[] = [];
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "updater_install_target") {
        return {
          mode: "nativePackage",
          packageKind: "pacman",
          target: "linux-x86_64-pacman",
        };
      }
      if (command === "updater_install_linux_package") {
        order.push("native-install");
      }
    });
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const beforeInstall = vi.fn(async () => {
      order.push("prepare-restart");
    });
    mocks.relaunch
      .mockImplementationOnce(async () => {
        order.push("relaunch-1");
        throw new Error("relaunch failed");
      })
      .mockImplementationOnce(async () => {
        order.push("relaunch-2");
      });
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall }),
    );
    await advance(INITIAL_DELAY);

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(order).toEqual(["native-install", "prepare-restart", "relaunch-1"]);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "restartFailed" }),
    );

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(order).toEqual([
      "native-install",
      "prepare-restart",
      "relaunch-1",
      "relaunch-2",
    ]);
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(candidate.download).not.toHaveBeenCalled();
    expect(candidate.install).not.toHaveBeenCalled();
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "updater_install_linux_package",
      ),
    ).toHaveLength(1);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "restarting" }),
    );
  });

  it("installs and relaunches a ready update after explicit confirmation", async () => {
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const beforeInstall = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall }),
    );
    await advance(INITIAL_DELAY);

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(candidate.download).toHaveBeenCalledTimes(1);
    expect(candidate.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({ phase: "restarting", version: "0.0.2" }),
    );
  });

  it("retries only relaunch after install succeeded and relaunch failed", async () => {
    const rawMessage = "raw relaunch failure from a private path";
    const candidate = makeUpdate({
      rawJson: {
        modelcrew: {
          releaseUrl:
            "https://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v0.0.2",
          releaseNotes: {
            ru: {
              title: "Обновление готово",
              summary: "Локализованное описание",
              highlights: ["Исправление"],
            },
          },
        },
      },
    });
    mocks.check.mockResolvedValue(candidate.update);
    mocks.relaunch
      .mockRejectedValueOnce(new Error(rawMessage))
      .mockResolvedValueOnce();
    const beforeInstall = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall }),
    );
    await advance(INITIAL_DELAY);

    await act(async () => {
      await result.current.installUpdate();
    });
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({
        phase: "restartFailed",
        title: "Обновление готово",
        summary: "Локализованное описание",
      }),
    );
    expect(JSON.stringify(result.current.center)).not.toContain(rawMessage);

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(candidate.download).toHaveBeenCalledTimes(1);
    expect(candidate.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(2);
    expect((result.current.center.items[0] as UpdateNotification)?.phase).toBe(
      "restarting",
    );
  });

  it("turns an install failure into a localized-safe public phase", async () => {
    const rawMessage = "raw updater secret: signature mismatch at /tmp/private";
    const candidate = makeUpdate({
      install: async () => {
        throw new Error(rawMessage);
      },
    });
    mocks.check.mockResolvedValue(candidate.update);
    const beforeInstall = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "en", beforeInstall }),
    );
    await advance(INITIAL_DELAY);

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(candidate.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect((result.current.center.items[0] as UpdateNotification)?.phase).toBe(
      "installFailed",
    );
    expect(JSON.stringify(result.current.center)).not.toContain(rawMessage);
  });

  it("re-localizes retained update metadata when the locale changes", async () => {
    const candidate = makeUpdate({
      rawJson: {
        modelcrew: {
          releaseUrl:
            "https://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v0.0.2",
          releaseNotes: {
            ru: {
              title: "Русский заголовок",
              summary: "Русское описание",
              highlights: ["Русский пункт"],
            },
            en: {
              title: "English title",
              summary: "English summary",
              highlights: ["English highlight"],
            },
          },
        },
      },
    });
    mocks.check.mockResolvedValue(candidate.update);
    const { result, rerender } = renderHook(
      ({ locale }: { locale: "ru" | "en" }) =>
        useAppUpdater({ locale, beforeInstall: vi.fn() }),
      { initialProps: { locale: "en" as "ru" | "en" } },
    );
    await advance(INITIAL_DELAY);
    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({
        title: "English title",
        summary: "English summary",
        highlights: ["English highlight"],
      }),
    );

    rerender({ locale: "ru" });

    expect(result.current.center.items[0]).toEqual(
      expect.objectContaining({
        title: "Русский заголовок",
        summary: "Русское описание",
        highlights: ["Русский пункт"],
      }),
    );
  });

  it("does not duplicate checks while check or download work is pending", async () => {
    const pendingCheck = deferred<Update | null>();
    const pendingDownload = deferred<void>();
    const candidate = makeUpdate({
      download: async () => pendingDownload.promise,
    });
    mocks.check.mockReturnValue(pendingCheck.promise);
    const { result } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    await advance(30 * MINUTE);
    await dispatchWindowEvent("focus");
    expect(mocks.check).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingCheck.resolve(candidate.update);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(candidate.download).toHaveBeenCalledTimes(1);
    expect((result.current.center.items[0] as UpdateNotification)?.phase).toBe(
      "downloading",
    );

    await advance(30 * MINUTE);
    await dispatchWindowEvent("focus");
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(candidate.download).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingDownload.resolve();
      await Promise.resolve();
    });
    expect((result.current.center.items[0] as UpdateNotification)?.phase).toBe(
      "ready",
    );
  });

  it("checks every four hours and after thirty minutes on focus", async () => {
    mocks.check.mockResolvedValue(null);
    renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    expect(mocks.check).toHaveBeenCalledTimes(1);

    await advance(30 * MINUTE - 1);
    await dispatchWindowEvent("focus");
    expect(mocks.check).toHaveBeenCalledTimes(1);

    await advance(1);
    await dispatchWindowEvent("focus");
    expect(mocks.check).toHaveBeenCalledTimes(2);

    await advance(4 * HOUR - 30 * MINUTE - INITIAL_DELAY);
    expect(mocks.check).toHaveBeenCalledTimes(3);
  });

  it("closes a downloaded update resource on unmount", async () => {
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const { unmount } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );
    await advance(INITIAL_DELAY);

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(candidate.close).toHaveBeenCalledTimes(1);
  });

  it("ignores native package progress delivered after unmount", async () => {
    const prepared = deferred<void>();
    let progress:
      | { onmessage: (message: unknown) => void }
      | undefined;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "updater_install_target") {
        return {
          mode: "nativePackage",
          packageKind: "deb",
          target: "linux-aarch64-deb",
        };
      }
      if (command === "updater_prepare_linux_package") {
        progress = args?.onProgress as typeof progress;
        return prepared.promise;
      }
    });
    const candidate = makeUpdate();
    mocks.check.mockResolvedValue(candidate.update);
    const { result, unmount } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );
    await advance(INITIAL_DELAY);
    expect((result.current.center.items[0] as UpdateNotification).phase).toBe(
      "downloading",
    );

    unmount();
    await act(async () => {
      progress?.onmessage({ phase: "verifying" });
      prepared.resolve();
      await Promise.resolve();
    });

    expect((result.current.center.items[0] as UpdateNotification).phase).toBe(
      "downloading",
    );
    expect(candidate.close).toHaveBeenCalledTimes(1);
  });

  it("removes automatic triggers when the hook unmounts", async () => {
    mocks.check.mockResolvedValue(null);
    const { unmount } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    unmount();
    await advance(4 * HOUR);
    await dispatchWindowEvent("focus");
    await dispatchWindowEvent("online");

    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("closes an update returned by a check that finishes after unmount", async () => {
    const pendingCheck = deferred<Update | null>();
    const candidate = makeUpdate();
    mocks.check.mockReturnValue(pendingCheck.promise);
    const { unmount } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await advance(INITIAL_DELAY);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    unmount();

    await act(async () => {
      pendingCheck.resolve(candidate.update);
      await Promise.resolve();
    });

    expect(candidate.download).not.toHaveBeenCalled();
    expect(candidate.close).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a retry when unmounted while closing a failed download", async () => {
    const pendingClose = deferred<void>();
    const candidate = makeUpdate({
      download: async () => {
        throw new Error("download failed");
      },
      close: async () => pendingClose.promise,
    });
    mocks.check.mockResolvedValue(candidate.update);
    const { unmount } = renderHook(() =>
      useAppUpdater({ locale: "ru", beforeInstall: vi.fn() }),
    );

    await act(async () => {
      vi.advanceTimersByTime(INITIAL_DELAY);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(candidate.close).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      pendingClose.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await advance(4 * HOUR);

    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(candidate.close).toHaveBeenCalledTimes(1);
  });
});
