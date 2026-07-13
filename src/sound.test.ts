import type { NotificationItem, UpdateNotificationPhase } from "./updater/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

let audioInstances: FakeAudio[] = [];
let playResult: Promise<void>;

class FakeAudio {
  src = "";
  currentTime = 12;
  play = vi.fn(() => playResult);

  constructor() {
    audioInstances.push(this);
  }
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
