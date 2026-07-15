import type { NotificationItem, UpdateNotificationPhase } from "./updater/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

let audioInstances: FakeAudio[] = [];
let playResult: Promise<void>;

class FakeAudio {
  src = "";
  currentTime = 12;
  preload = "";
  play = vi.fn(() => playResult);
  pause = vi.fn();

  constructor() {
    audioInstances.push(this);
  }
}

const HEALTH_KEY = "modelcrew.audioHealth";

function storedHealth(): { status: string; version: string } {
  return JSON.parse(localStorage.getItem(HEALTH_KEY) ?? "null");
}

// Waits out the next-tick watchdog that confirms a playback attempt survived.
function settleWatchdog(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

function update(
  version: string,
  phase: UpdateNotificationPhase,
): NotificationItem {
  return {
    id: `update:${version}`,
    kind: "update",
    installKind: phase === "manual" ? "manual" : "selfUpdate",
    phase,
    version,
    title: `ModelCrew ${version}`,
    summary: "Summary",
    highlights: [],
    releaseUrl: `https://example.com/${version}`,
  };
}

const announcement: NotificationItem = {
  id: "announcement:welcome",
  kind: "announcement",
  title: "Welcome",
  summary: "Summary",
  highlights: [],
};

describe("notification sounds", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    audioInstances = [];
    playResult = Promise.resolve();
    vi.stubGlobal("Audio", FakeAudio);
  });

  it("saves and loads the selected sound and falls back for unknown values", async () => {
    const { loadNotificationSound, saveNotificationSound } = await import(
      "./sound"
    );

    expect(loadNotificationSound()).toBe("chime");
    saveNotificationSound("flute");
    expect(loadNotificationSound()).toBe("flute");

    localStorage.setItem("modelcrew.notificationSound", "unknown");
    expect(loadNotificationSound()).toBe("chime");
  });

  it("does not create an audio element when sounds are disabled", async () => {
    const { playNotificationSound, saveNotificationSound } = await import(
      "./sound"
    );

    saveNotificationSound("off");
    playNotificationSound();

    expect(audioInstances).toHaveLength(0);
  });

  it("previews the selected bundled WAV from the beginning", async () => {
    const { previewNotificationSound } = await import("./sound");

    previewNotificationSound("reveal");

    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0].src).toBe("/sounds/reveal.wav");
    expect(audioInstances[0].currentTime).toBe(0);
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
  });

  it("silently handles rejected audio playback", async () => {
    playResult = Promise.reject(new Error("autoplay blocked"));
    const { playNotificationSound } = await import("./sound");

    expect(() => playNotificationSound()).not.toThrow();
    await Promise.resolve();

    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
  });

  it("brackets an attempt with a pending marker and confirms it survived", async () => {
    const { previewNotificationSound } = await import("./sound");

    previewNotificationSound("pop");
    expect(storedHealth().status).toBe("pending");

    await settleWatchdog();
    expect(storedHealth().status).toBe("ok");
  });

  it("keeps audio off after a previous attempt froze the process", async () => {
    const { isNotificationSoundSuppressed, previewNotificationSound } =
      await import("./sound");

    // A healthy attempt records the running app version for us.
    previewNotificationSound("chime");
    await settleWatchdog();
    const { version } = storedHealth();
    audioInstances = [];

    // Simulate the marker left behind by a run that froze mid-attempt.
    localStorage.setItem(
      HEALTH_KEY,
      JSON.stringify({ status: "pending", version, session: "dead-session" }),
    );

    expect(isNotificationSoundSuppressed()).toBe(true);
    expect(storedHealth().status).toBe("broken");
    previewNotificationSound("chime");
    expect(audioInstances).toHaveLength(0);
  });

  it("re-arms suppressed audio when the user selects off", async () => {
    const {
      isNotificationSoundSuppressed,
      previewNotificationSound,
      saveNotificationSound,
    } = await import("./sound");

    previewNotificationSound("chime");
    await settleWatchdog();
    const { version } = storedHealth();
    localStorage.setItem(
      HEALTH_KEY,
      JSON.stringify({ status: "pending", version, session: "dead-session" }),
    );
    expect(isNotificationSoundSuppressed()).toBe(true);

    saveNotificationSound("off");
    expect(isNotificationSoundSuppressed()).toBe(false);
    // The module reuses one cached element, so count plays rather than
    // constructed instances.
    const element = audioInstances[0];
    element.play.mockClear();
    previewNotificationSound("chime");
    expect(element.play).toHaveBeenCalledTimes(1);
  });

  it("re-arms suppressed audio after an app update", async () => {
    const { isNotificationSoundSuppressed, previewNotificationSound } =
      await import("./sound");

    localStorage.setItem(
      HEALTH_KEY,
      JSON.stringify({ status: "broken", version: "0.0.0-older" }),
    );

    expect(isNotificationSoundSuppressed()).toBe(false);
    previewNotificationSound("click");
    expect(audioInstances).toHaveLength(1);
  });

  it("treats a long stall during playback as a hang", async () => {
    const { isNotificationSoundSuppressed, previewNotificationSound } =
      await import("./sound");
    // A settable clock is sturdier than counting calls: jsdom internals also
    // consult performance.now.
    let mockedNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => mockedNow);

    previewNotificationSound("chime");
    expect(audioInstances).toHaveLength(1);
    mockedNow = 10_000; // the watchdog wakes only after a 10s stall
    await settleWatchdog();

    expect(storedHealth().status).toBe("broken");
    expect(isNotificationSoundSuppressed()).toBe(true);
    const element = audioInstances[0];
    element.play.mockClear();
    previewNotificationSound("chime");
    expect(element.play).not.toHaveBeenCalled();
  });

  it("selects unread ready, manual, and announcement notifications only", async () => {
    const { selectUnseenNotificationSoundIds } = await import("./sound");
    const readIds = new Set(["update:0.0.2"]);

    expect(
      selectUnseenNotificationSoundIds(
        [
          update("0.0.2", "ready"),
          update("0.0.3", "downloading"),
          update("0.0.4", "manual"),
          announcement,
        ],
        readIds,
      ),
    ).toEqual(["update:0.0.4", "announcement:welcome"]);
  });

  it("does not select the same notification on repeated updater checks", async () => {
    const { selectUnseenNotificationSoundIds } = await import("./sound");
    const handled = new Set<string>();
    const items = [update("0.0.2", "ready")];

    const first = selectUnseenNotificationSoundIds(items, handled);
    first.forEach((id) => handled.add(id));

    expect(first).toEqual(["update:0.0.2"]);
    expect(selectUnseenNotificationSoundIds(items, handled)).toEqual([]);
  });

  it("keeps a read version silent after restart but allows an unread one", async () => {
    const { selectUnseenNotificationSoundIds } = await import("./sound");
    const items = [update("0.0.2", "ready")];

    expect(
      selectUnseenNotificationSoundIds(items, new Set(["update:0.0.2"])),
    ).toEqual([]);
    expect(selectUnseenNotificationSoundIds(items, new Set())).toEqual([
      "update:0.0.2",
    ]);
  });
});
