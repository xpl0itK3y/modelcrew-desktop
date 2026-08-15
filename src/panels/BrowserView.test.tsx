// Ящик со страницей: что в нём видно и что уходит в бэкенд.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { BrowserView } from "./BrowserView";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const PIXEL = "iVBORw0KGgo=";

function frame(over: Record<string, unknown> = {}) {
  return { image: "", url: "", title: "", running: false, ...over };
}

function address(): HTMLInputElement {
  return screen.getByLabelText("Адрес страницы") as HTMLInputElement;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(frame());
});

afterEach(() => {
  setLocale("ru");
});

describe("BrowserView", () => {
  it("says the browser is not up yet instead of showing a hole", async () => {
    render(<BrowserView workspaceId="w1" />);

    expect(
      await screen.findByText(/Браузер проекта ещё не запущен/),
    ).toBeInTheDocument();
  });

  it("shows the page as a picture once there is a frame", async () => {
    invoke.mockResolvedValue(
      frame({
        image: PIXEL,
        url: "http://localhost:1420/",
        title: "Стенд",
        running: true,
      }),
    );

    render(<BrowserView workspaceId="w1" />);

    const picture = await screen.findByRole("img", { name: "Стенд" });
    expect(picture).toHaveAttribute("src", `data:image/png;base64,${PIXEL}`);
  });

  it("follows the page in the address bar", async () => {
    invoke.mockResolvedValue(
      frame({ image: PIXEL, url: "http://localhost:1420/x", running: true }),
    );

    render(<BrowserView workspaceId="w1" />);

    await waitFor(() =>
      expect(address()).toHaveValue("http://localhost:1420/x"),
    );
  });

  it("does not overwrite an address being typed", async () => {
    // Кадр приходит раз в секунду; затирай он поле — набрать адрес было бы
    // нельзя в принципе.
    invoke.mockResolvedValue(
      frame({ image: PIXEL, url: "http://localhost:1420/", running: true }),
    );
    render(<BrowserView workspaceId="w1" />);
    await waitFor(() => expect(address()).toHaveValue("http://localhost:1420/"));

    address().focus();
    fireEvent.change(address(), { target: { value: "example.com" } });
    await waitFor(
      () => expect(invoke.mock.calls.length).toBeGreaterThan(2),
      { timeout: 4_000 },
    );

    expect(address()).toHaveValue("example.com");
  });

  it("keeps a typed address after the caret leaves the field", async () => {
    // Набрать адрес и потянуться мышью к «Открыть» — этого хватало, чтобы
    // поле опустело: слежение за страницей смотрело только на курсор.
    invoke.mockResolvedValue(frame());
    render(<BrowserView workspaceId="w1" />);

    address().focus();
    fireEvent.change(address(), { target: { value: "example.com" } });
    address().blur();
    await waitFor(
      () => expect(invoke.mock.calls.length).toBeGreaterThan(2),
      { timeout: 4_000 },
    );

    expect(address()).toHaveValue("example.com");
  });

  it("follows the page again once the page has been opened", async () => {
    // Иначе поле замирало бы на набранном навсегда, и переход по ссылке
    // внутри страницы в адресе бы не отражался.
    invoke.mockImplementation((command: string) =>
      command === "browser_go"
        ? Promise.resolve()
        : Promise.resolve(
            frame({ url: "http://example.com/after-redirect", running: true }),
          ),
    );
    render(<BrowserView workspaceId="w1" />);

    fireEvent.change(address(), { target: { value: "example.com" } });
    fireEvent.submit(address());

    await waitFor(
      () => expect(address()).toHaveValue("http://example.com/after-redirect"),
      { timeout: 4_000 },
    );
  });

  it("opens what the person typed, with the scheme filled in", async () => {
    render(<BrowserView workspaceId="w1" />);

    fireEvent.change(address(), { target: { value: "localhost:1420" } });
    fireEvent.submit(address());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("browser_go", {
        workspaceId: "w1",
        url: "http://localhost:1420",
      }),
    );
  });

  it("explains a refusal in words the person can act on", async () => {
    invoke.mockImplementation((command: string) =>
      command === "browser_go"
        ? Promise.reject({ code: "browser_not_installed" })
        : Promise.resolve(frame()),
    );

    render(<BrowserView workspaceId="w1" />);
    fireEvent.change(address(), { target: { value: "example.com" } });
    fireEvent.submit(address());

    // Код ошибки человеку ничего не говорит: он должен прочитать, что делать.
    expect(await screen.findByRole("alert")).toHaveTextContent(/Chrome/);
  });

  it("says it is working while the browser starts up", async () => {
    // Первый запуск Chrome занимает секунды: без этой строки нажатие
    // выглядит как будто ничего не произошло, и человек жмёт ещё раз.
    let release = () => {};
    invoke.mockImplementation((command: string) =>
      command === "browser_go"
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(frame()),
    );

    render(<BrowserView workspaceId="w1" />);
    fireEvent.change(address(), { target: { value: "example.com" } });
    fireEvent.submit(address());

    expect(await screen.findByText("Открываю страницу…")).toBeInTheDocument();

    release();
    await waitFor(() =>
      expect(screen.queryByText("Открываю страницу…")).not.toBeInTheDocument(),
    );
  });

  it("shows nothing of the previous project when the project changes", async () => {
    // Чужая страница в ящике — не косметика: в адресной строке остался бы
    // чужой адрес, и «Открыть» отправил бы его в браузер нового проекта.
    invoke.mockImplementation((_command: string, args: { workspaceId: string }) =>
      Promise.resolve(
        args.workspaceId === "w1"
          ? frame({ image: PIXEL, url: "http://a.test/", running: true })
          : frame(),
      ),
    );

    const view = render(<BrowserView workspaceId="w1" />);
    await waitFor(() => expect(address()).toHaveValue("http://a.test/"));

    view.rerender(<BrowserView workspaceId="w2" />);

    // Сразу же, тем же кадром отрисовки, а не после первого ответа нового.
    expect(address()).toHaveValue("");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps the open button out of reach while there is nothing to open", () => {
    render(<BrowserView workspaceId="w1" />);

    expect(screen.getByRole("button", { name: "Открыть" })).toBeDisabled();
  });
});
