import { describe, expect, it } from "vitest";

import { authorAvatar, resolveAvatarUrl } from "./authorAvatars";

describe("resolveAvatarUrl", () => {
  it("derives GitHub avatars from noreply emails", async () => {
    expect(
      await resolveAvatarUrl("49699333+dependabot[bot]@users.noreply.github.com"),
    ).toBe("https://avatars.githubusercontent.com/u/49699333?s=48&v=4");
    expect(await resolveAvatarUrl("octocat@users.noreply.github.com")).toBe(
      "https://github.com/octocat.png?size=48",
    );
  });

  it("falls back to a Gravatar hash for real emails", async () => {
    const url = await resolveAvatarUrl("Person@Example.com");
    // Хеш от нормализованной (нижний регистр) почты.
    expect(url).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}\?/);
  });

  it("returns null without an email", async () => {
    expect(await resolveAvatarUrl("")).toBeNull();
    expect(await resolveAvatarUrl("not-an-email")).toBeNull();
  });
});

describe("authorAvatar", () => {
  it("takes initials from up to two words", () => {
    expect(authorAvatar("Kenny Van de Maele").initials).toBe("KV");
    expect(authorAvatar("pewdiepie-archdaemon").initials).toBe("PE");
    expect(authorAvatar("Денис").initials).toBe("ДЕ");
    expect(authorAvatar("").initials).toBe("?");
  });

  it("is deterministic and varies by name", () => {
    expect(authorAvatar("Denis").hue).toBe(authorAvatar("Denis").hue);
    expect(authorAvatar("Denis").hue).not.toBe(authorAvatar("Boody").hue);
    expect(authorAvatar("x").hue).toBeGreaterThanOrEqual(0);
    expect(authorAvatar("x").hue).toBeLessThan(360);
  });
});
