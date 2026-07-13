import type { Update } from "@tauri-apps/plugin-updater";
import { describe, expect, it } from "vitest";
import { releaseDetails } from "./releaseNotes";

type ReleaseSource = Pick<Update, "version" | "body" | "rawJson">;

function source(rawJson: Record<string, unknown>): ReleaseSource {
  return {
    version: "0.0.2",
    body: "Fallback release body",
    rawJson,
  };
}

describe("releaseDetails", () => {
  it("uses bounded localized metadata from the signed update manifest", () => {
    const details = releaseDetails(
      source({
        modelcrew: {
          releaseUrl:
            "https://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v0.0.2",
          releaseNotes: {
            ru: {
              title: "  Быстрее\nи спокойнее  ",
              summary: "Новый центр\u0000 уведомлений",
              highlights: ["Тихая проверка", "Фоновая загрузка"],
            },
          },
        },
      }),
      "ru",
    );

    expect(details).toEqual({
      version: "0.0.2",
      title: "Быстрее и спокойнее",
      summary: "Новый центр уведомлений",
      highlights: ["Тихая проверка", "Фоновая загрузка"],
      releaseUrl:
        "https://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v0.0.2",
    });
  });

  it("rejects external release URLs and invalid localized collections", () => {
    const details = releaseDetails(
      source({
        modelcrew: {
          releaseUrl: "https://example.com/fake-installer",
          releaseNotes: {
            en: {
              title: "Untrusted title",
              summary: "Untrusted summary",
              highlights: ["1", "2", "3", "4", "5", "6"],
            },
          },
        },
      }),
      "en",
    );

    expect(details.title).toBe("ModelCrew 0.0.2 update");
    expect(details.summary).toBe("Fallback release body");
    expect(details.highlights).toEqual([]);
    expect(details.releaseUrl).toBe(
      "https://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v0.0.2",
    );
  });

  it("truncates oversized fallback notes instead of exposing arbitrary payloads", () => {
    const details = releaseDetails(
      {
        version: "0.0.2",
        body: "x".repeat(250),
        rawJson: {},
      },
      "en",
    );

    expect(Array.from(details.summary)).toHaveLength(200);
    expect(details.summary.endsWith("…")).toBe(true);
  });
});
