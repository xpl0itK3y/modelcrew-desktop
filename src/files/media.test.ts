import { describe, expect, it } from "vitest";
import { drawnAsImage, imageMimeOf, mediaSource, svgSource } from "./media";

describe("media", () => {
  it("knows the pictures a webview can draw by itself", () => {
    expect(imageMimeOf("logo.png")).toBe("image/png");
    expect(imageMimeOf("shot.JPEG")).toBe("image/jpeg");
    expect(imageMimeOf("loop.gif")).toBe("image/gif");
    expect(imageMimeOf("photo.avif")).toBe("image/avif");
    expect(imageMimeOf("favicon.ico")).toBe("image/x-icon");
    expect(imageMimeOf("mark.svg")).toBe("image/svg+xml");
  });

  it("leaves everything else to the text editor", () => {
    expect(imageMimeOf("main.rs")).toBeNull();
    expect(imageMimeOf("README")).toBeNull();
    // Точка в начале — имя файла, а не расширение.
    expect(imageMimeOf(".png")).toBeNull();
  });

  it("sends only what cannot be edited to the picture view", () => {
    expect(drawnAsImage("assets/logo.png")).toBe(true);
    expect(drawnAsImage("assets/logo.PNG")).toBe(true);
    // SVG правится как текст — и остаётся в редакторе, с глазом наверху.
    expect(drawnAsImage("assets/mark.svg")).toBe(false);
    expect(drawnAsImage("src/main.rs")).toBe(false);
  });

  it("hands the picture over as an address the page may load", () => {
    expect(
      mediaSource({
        mime: "image/png",
        data: "iVBOR",
        bytes: 5,
        tooLarge: false,
        exists: true,
      }),
    ).toBe("data:image/png;base64,iVBOR");
  });

  it("escapes the drawing instead of pasting it into the page", () => {
    const source = svgSource('<svg onload="steal()"><script/></svg>');
    expect(source.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    // Ни одной угловой скобки: браузер получит адрес, а не разметку.
    expect(source).not.toContain("<");
    expect(decodeURIComponent(source.split(",")[1])).toContain("onload");
  });
});
