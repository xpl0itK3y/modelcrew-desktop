import { describe, expect, it, vi } from "vitest";
import {
  droppedPathPastes,
  findTerminalDropTargetAtPoint,
  MAX_CLIPBOARD_IMAGE_BYTES,
  pasteClipboardImage,
  pasteDroppedPaths,
  type TerminalDropTarget,
} from "./fileDrop";

function createTarget(
  overrides: Partial<TerminalDropTarget> = {},
): TerminalDropTarget {
  const container = document.createElement("div");
  document.body.append(container);
  return {
    container,
    exited: false,
    inputReady: true,
    term: {
      focus: vi.fn(),
      paste: vi.fn(),
    },
    ...overrides,
  };
}

describe("droppedPathPastes", () => {
  it("prepares each POSIX path as a separate shell-safe paste", () => {
    expect(
      droppedPathPastes([
        "/tmp/Image 1.png",
        "/Users/denis/Documents/spec's draft.md",
      ]),
    ).toEqual([
      "'/tmp/Image 1.png' ",
      "'/Users/denis/Documents/spec'\\''s draft.md' ",
    ]);
  });

  it("quotes Windows drive and UNC paths", () => {
    expect(
      droppedPathPastes([
        "C:\\Users\\Denis\\Image 1.png",
        "\\\\server\\share\\notes.txt",
      ]),
    ).toEqual([
      '"C:\\Users\\Denis\\Image 1.png" ',
      '"\\\\server\\share\\notes.txt" ',
    ]);
  });

  it("rejects unsafe paths, relative paths, and duplicates", () => {
    expect(
      droppedPathPastes([
        "relative.png",
        "/tmp/line\nbreak.png",
        'C:\\bad"name.png',
        "/tmp/valid.png",
        "/tmp/valid.png",
      ]),
    ).toEqual(["'/tmp/valid.png' "]);
  });

  it("limits the number and total size of pasted paths", () => {
    const manyPaths = Array.from(
      { length: 20 },
      (_, index) => `/tmp/image-${index}.png`,
    );
    expect(droppedPathPastes(manyPaths)).toHaveLength(16);

    const oversizedPath = `/${"x".repeat(4_096)}`;
    expect(droppedPathPastes([oversizedPath])).toEqual([]);

    const largePaths = Array.from(
      { length: 5 },
      (_, index) => `/${index}-${"x".repeat(4_000)}`,
    );
    expect(droppedPathPastes(largePaths)).toHaveLength(4);
  });
});

function setRect(
  target: TerminalDropTarget,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  vi.spyOn(target.container, "getBoundingClientRect").mockReturnValue({
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  });
}

describe("findTerminalDropTargetAtPoint", () => {
  it("selects the terminal whose full rectangle contains the drop point", () => {
    const first = createTarget();
    const second = createTarget();
    setRect(first, 0, 0, 300, 200);
    setRect(second, 310, 0, 300, 200);

    expect(
      findTerminalDropTargetAtPoint([first, second], { x: 500, y: 100 }),
    ).toBe(second);
    expect(
      findTerminalDropTargetAtPoint([first, second], { x: 100, y: 100 }),
    ).toBe(first);
  });

  it("ignores disconnected, hidden, exited, and unready terminals", () => {
    const target = createTarget();
    setRect(target, 0, 0, 300, 200);

    expect(
      findTerminalDropTargetAtPoint([{ ...target, inputReady: false }], {
        x: 100,
        y: 100,
      }),
    ).toBeNull();
    expect(
      findTerminalDropTargetAtPoint([{ ...target, exited: true }], {
        x: 100,
        y: 100,
      }),
    ).toBeNull();

    target.container.remove();
    expect(
      findTerminalDropTargetAtPoint([target], { x: 100, y: 100 }),
    ).toBeNull();

    const hidden = createTarget();
    setRect(hidden, 0, 0, 0, 0);
    expect(findTerminalDropTargetAtPoint([hidden], { x: 0, y: 0 })).toBeNull();
  });
});

describe("pasteDroppedPaths", () => {
  it("focuses once and pastes every path separately without submitting", () => {
    const target = createTarget();

    expect(
      pasteDroppedPaths(target, ["/tmp/first.png", "/tmp/second.md"]),
    ).toBe(2);
    expect(target.term.focus).toHaveBeenCalledOnce();
    expect(target.term.paste).toHaveBeenNthCalledWith(1, "'/tmp/first.png' ");
    expect(target.term.paste).toHaveBeenNthCalledWith(2, "'/tmp/second.md' ");
  });
});

describe("pasteClipboardImage", () => {
  it("saves a copied image and pastes its path into the same terminal", async () => {
    const target = createTarget();
    const bytes = Uint8Array.from([1, 2, 3]);
    const preventDefault = vi.fn();
    const saveImage = vi.fn().mockResolvedValue("/tmp/clipboard-image.png");

    const handled = await pasteClipboardImage(
      target,
      {
        clipboardData: {
          items: {
            0: {
              kind: "file",
              type: "image/png",
              getAsFile: () => ({
                size: bytes.byteLength,
                arrayBuffer: async () => bytes.buffer,
              }),
            },
            length: 1,
          },
        },
        preventDefault,
      },
      saveImage,
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(saveImage).toHaveBeenCalledWith(bytes);
    expect(target.term.paste).toHaveBeenCalledWith(
      "'/tmp/clipboard-image.png' ",
    );
  });

  it("leaves ordinary text paste to xterm", async () => {
    const target = createTarget();
    const preventDefault = vi.fn();
    const saveImage = vi.fn();

    const handled = await pasteClipboardImage(
      target,
      {
        clipboardData: {
          items: {
            0: {
              kind: "string",
              type: "text/plain",
              getAsFile: () => null,
            },
            length: 1,
          },
        },
        preventDefault,
      },
      saveImage,
    );

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(saveImage).not.toHaveBeenCalled();
  });

  it("blocks an oversized clipboard image before IPC", async () => {
    const target = createTarget();
    const preventDefault = vi.fn();
    const saveImage = vi.fn();

    const handled = await pasteClipboardImage(
      target,
      {
        clipboardData: {
          items: {
            0: {
              kind: "file",
              type: "image/png",
              getAsFile: () => ({
                size: MAX_CLIPBOARD_IMAGE_BYTES + 1,
                arrayBuffer: async () => new ArrayBuffer(0),
              }),
            },
            length: 1,
          },
        },
        preventDefault,
      },
      saveImage,
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(saveImage).not.toHaveBeenCalled();
  });
});
