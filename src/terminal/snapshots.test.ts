import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializeAddon } from "@xterm/addon-serialize";

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  return {
    invoke: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

type Snapshots = typeof import("./snapshots");

// Запись снимка, которую тест отпускает сам: так видно, что идёт следом.
type PendingSave = { id: string; resolve: () => void; reject: () => void };

let snapshots: Snapshots;
let saves: PendingSave[];

function source(text: string) {
  const serialize = vi.fn(() => text);
  return { serialize, addon: { serialize } as unknown as SerializeAddon };
}

// Даёт отработать цепочке промисов: проход доходит до следующей записи.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(async () => {
  vi.resetModules();
  saves = [];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(
    (command: string, args: { id: string }) =>
      new Promise<void>((resolve, reject) => {
        if (command === "terminal_snapshot_save") {
          saves.push({ id: args.id, resolve, reject: () => reject(new Error("disk")) });
        } else {
          resolve();
        }
      }),
  );
  snapshots = await import("./snapshots");
});

describe("terminal snapshots", () => {
  it("serializes dirty panels one at a time", async () => {
    const a = source("a");
    const b = source("b");
    snapshots.registerSnapshotSource("a", a.addon);
    snapshots.registerSnapshotSource("b", b.addon);
    snapshots.markSnapshotDirty("a");
    snapshots.markSnapshotDirty("b");

    const flushed = snapshots.flushDirtySnapshots();
    await settle();
    // Второй буфер не сериализуется, пока первый снимок не записан.
    expect(saves.map((save) => save.id)).toEqual(["a"]);
    expect(b.serialize).not.toHaveBeenCalled();

    saves[0].resolve();
    await settle();
    expect(saves.map((save) => save.id)).toEqual(["a", "b"]);
    saves[1].resolve();
    await flushed;
  });

  it("waits for the pass in flight on quit and leaves clean panels alone", async () => {
    const a = source("a");
    const b = source("b");
    const clean = source("clean");
    snapshots.registerSnapshotSource("a", a.addon);
    snapshots.registerSnapshotSource("b", b.addon);
    snapshots.registerSnapshotSource("clean", clean.addon);
    snapshots.markSnapshotDirty("a");

    void snapshots.flushDirtySnapshots();
    await settle();
    snapshots.markSnapshotDirty("b");

    let quitDone = false;
    const quit = snapshots.flushPendingSnapshots().then(() => {
      quitDone = true;
    });
    await settle();
    // Снимок «a» ещё в пути: выход не должен его опередить.
    expect(quitDone).toBe(false);
    expect(saves.map((save) => save.id)).toEqual(["a"]);

    saves[0].resolve();
    await settle();
    expect(saves.map((save) => save.id)).toEqual(["a", "b"]);
    saves[1].resolve();
    await quit;

    expect(quitDone).toBe(true);
    expect(a.serialize).toHaveBeenCalledTimes(1);
    expect(clean.serialize).not.toHaveBeenCalled();
  });

  it("retries a snapshot whose write failed", async () => {
    const a = source("a");
    snapshots.registerSnapshotSource("a", a.addon);
    snapshots.markSnapshotDirty("a");

    const first = snapshots.flushDirtySnapshots();
    await settle();
    saves[0].reject();
    await first;

    const quit = snapshots.flushPendingSnapshots();
    await settle();
    expect(saves.map((save) => save.id)).toEqual(["a", "a"]);
    saves[1].resolve();
    await quit;
  });

  it("does not write a panel that was closed while queued", async () => {
    const a = source("a");
    const b = source("b");
    snapshots.registerSnapshotSource("a", a.addon);
    snapshots.registerSnapshotSource("b", b.addon);
    snapshots.markSnapshotDirty("a");
    snapshots.markSnapshotDirty("b");

    const flushed = snapshots.flushDirtySnapshots();
    await settle();
    snapshots.discardSnapshot("b");
    saves[0].resolve();
    await flushed;

    expect(saves.map((save) => save.id)).toEqual(["a"]);
    expect(b.serialize).not.toHaveBeenCalled();
  });
});
