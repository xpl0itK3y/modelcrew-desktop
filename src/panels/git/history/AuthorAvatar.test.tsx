// Три источника аватарки и порядок отката между ними.
//
// Проверяется напрямую: панельный тест видит только «какой-то кружок», а
// разница между картинкой из GitHub, картинкой по почте и инициалами — это
// разница между «показали чужое лицо», «сходили в сеть без спроса» и «ничего
// не показали».

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  githubAvatar: vi.fn<(email: string) => string | undefined>(() => undefined),
  resolveAvatarUrl: vi.fn(
    async (_email: string): Promise<string | null> => null,
  ),
}));

vi.mock("../../../git/githubAvatars", () => ({
  githubAvatarForEmail: mocks.githubAvatar,
  subscribeGithubAvatars: () => () => {},
}));
vi.mock("../../../git/authorAvatars", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../git/authorAvatars")>()),
  resolveAvatarUrl: mocks.resolveAvatarUrl,
}));

import { setGithubSignedIn } from "../../../github/authState";
import { saveNetworkAvatars } from "../../../terminal/preferences";
import { AuthorAvatar } from "./AuthorAvatar";

const image = () => document.querySelector("img.git-avatar-img");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.githubAvatar.mockReturnValue(undefined);
  mocks.resolveAvatarUrl.mockResolvedValue(null);
  localStorage.clear();
  setGithubSignedIn(true);
  saveNetworkAvatars(true);
});

afterEach(() => {
  setGithubSignedIn(false);
});

describe("AuthorAvatar", () => {
  it("prefers the real GitHub avatar over the derived one", async () => {
    mocks.githubAvatar.mockReturnValue(
      "https://avatars.githubusercontent.com/u/7",
    );
    mocks.resolveAvatarUrl.mockResolvedValue(
      "https://www.gravatar.com/avatar/x",
    );

    render(<AuthorAvatar name="Denis Latun" email="d@t" />);

    await waitFor(() =>
      expect(image()).toHaveAttribute(
        "src",
        "https://avatars.githubusercontent.com/u/7",
      ),
    );
    // За Gravatar даже не ходили: карта коммиттеров уже дала точный ответ.
    expect(mocks.resolveAvatarUrl).not.toHaveBeenCalled();
  });

  it("falls back to the address-derived avatar", async () => {
    mocks.resolveAvatarUrl.mockResolvedValue(
      "https://www.gravatar.com/avatar/x",
    );

    render(<AuthorAvatar name="Denis Latun" email="d@t" />);

    await waitFor(() =>
      expect(image()).toHaveAttribute(
        "src",
        "https://www.gravatar.com/avatar/x",
      ),
    );
  });

  it("shows initials when neither source has a picture", async () => {
    render(<AuthorAvatar name="Denis Latun" email="d@t" />);

    await waitFor(() => expect(mocks.resolveAvatarUrl).toHaveBeenCalled());
    expect(image()).toBeNull();
    expect(screen.getByTitle("Denis Latun")).toHaveTextContent("DL");
  });

  it("returns to initials when the picture fails to load", async () => {
    mocks.resolveAvatarUrl.mockResolvedValue(
      "https://www.gravatar.com/avatar/404",
    );

    render(<AuthorAvatar name="Denis Latun" email="d@t" />);
    const picture = await waitFor(() => {
      const found = image();
      expect(found).not.toBeNull();
      return found!;
    });
    // d=404 у Gravatar — штатный ответ «аватара нет», а не сбой.
    picture.dispatchEvent(new Event("error", { bubbles: false }));

    await waitFor(() => expect(image()).toBeNull());
    expect(screen.getByTitle("Denis Latun")).toHaveTextContent("DL");
  });

  it("stays offline while the user is signed out of GitHub", async () => {
    setGithubSignedIn(false);
    mocks.githubAvatar.mockReturnValue(
      "https://avatars.githubusercontent.com/u/7",
    );

    render(<AuthorAvatar name="Denis Latun" email="d@t" />);

    expect(image()).toBeNull();
    expect(mocks.resolveAvatarUrl).not.toHaveBeenCalled();
  });

  it("stays offline while the setting says initials", async () => {
    saveNetworkAvatars(false);
    mocks.githubAvatar.mockReturnValue(
      "https://avatars.githubusercontent.com/u/7",
    );

    render(<AuthorAvatar name="Denis Latun" email="d@t" />);

    expect(image()).toBeNull();
    expect(mocks.resolveAvatarUrl).not.toHaveBeenCalled();
  });

  it("asks for nothing when the commit has no address", () => {
    render(<AuthorAvatar name="Denis Latun" />);

    expect(image()).toBeNull();
    expect(mocks.resolveAvatarUrl).not.toHaveBeenCalled();
    expect(screen.getByTitle("Denis Latun")).toHaveTextContent("DL");
  });
});
