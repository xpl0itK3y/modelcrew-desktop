// Ящик со страницей: что в нём видно и что уходит в бэкенд.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { BrowserView } from "./BrowserView";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

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
  openUrl.mockReset();
  openUrl.mockResolvedValue(undefined);
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
        ? Promise.reject({ code: "browser_url_unsupported" })
        : Promise.resolve(frame()),
    );

    render(<BrowserView workspaceId="w1" />);
    fireEvent.change(address(), { target: { value: "example.com" } });
    fireEvent.submit(address());

    // Код ошибки человеку ничего не говорит: он должен прочитать, что делать.
    expect(await screen.findByRole("alert")).toHaveTextContent(/http/);
  });

  it("names the reason the page did not open, not just the failure", async () => {
    // «Браузер не смог» без причины не подсказывает ничего, а причина здесь —
    // ответ самой страницы: дев-сервер не поднят, адрес набран с опечаткой.
    invoke.mockImplementation((command: string) =>
      command === "browser_go"
        ? Promise.reject({
            code: "browser_command_failed",
            context: { reason: "net::ERR_CONNECTION_REFUSED" },
          })
        : Promise.resolve(frame()),
    );

    render(<BrowserView workspaceId="w1" />);
    fireEvent.change(address(), { target: { value: "localhost:3000" } });
    fireEvent.submit(address());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "net::ERR_CONNECTION_REFUSED",
    );
  });

  it("takes the refusal away once the page moves on", async () => {
    // Отказ висел вечно: страница давно ушла на другой адрес, а под адресной
    // строкой всё ещё краснела прошлая неудача.
    let url = "http://localhost:1420/";
    invoke.mockImplementation((command: string) =>
      command === "browser_go"
        ? Promise.reject({ code: "browser_command_failed" })
        : Promise.resolve(frame({ url, running: true })),
    );

    render(<BrowserView workspaceId="w1" />);
    fireEvent.change(address(), { target: { value: "localhost:3000" } });
    fireEvent.submit(address());
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // Кадры того же адреса отказ не снимают: он всё ещё про то, что видно.
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeInTheDocument();

    url = "https://example.com/";
    await waitFor(
      () => expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      { timeout: 3_000 },
    );
  });

  it("does not call a living browser absent when a frame fails to arrive", async () => {
    // Пустой кадр — это «браузер не запущен», и говорить так про живой, но
    // не ответивший, значит отправить человека запускать запущенное.
    let answer: () => Promise<unknown> = () =>
      Promise.resolve(
        frame({ image: PIXEL, url: "http://localhost:1420/", running: true }),
      );
    invoke.mockImplementation((command: string) =>
      command === "browser_frame" ? answer() : Promise.resolve(),
    );

    render(<BrowserView workspaceId="w1" />);
    expect(await screen.findByRole("img")).toBeInTheDocument();

    answer = () => Promise.reject({ code: "browser_command_failed" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/не смог/);
    // Прошлый кадр остаётся: он последнее, что известно о странице.
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(
      screen.queryByText(/Браузер проекта ещё не запущен/),
    ).not.toBeInTheDocument();
  });

  it("says it is working while the browser starts up", async () => {
    // Первое открытие страницы занимает секунды: без этой строки нажатие
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

  it("sends the page to the system browser from the open button", async () => {
    // Кнопка — в основной браузер человека, а не в браузер проекта: там его
    // закладки, вход на сайты и инструменты разработчика.
    invoke.mockResolvedValue(
      frame({ image: PIXEL, url: "http://localhost:1420/x", running: true }),
    );
    render(<BrowserView workspaceId="w1" />);
    await waitFor(() => expect(address()).toHaveValue("http://localhost:1420/x"));

    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));

    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("http://localhost:1420/x"),
    );
    expect(invoke).not.toHaveBeenCalledWith("browser_go", expect.anything());
  });

  it("sends a typed address out with the scheme filled in", async () => {
    render(<BrowserView workspaceId="w1" />);

    fireEvent.change(address(), { target: { value: "localhost:3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));

    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("http://localhost:3000"),
    );
  });

  it("keeps anything but the web inside", async () => {
    render(<BrowserView workspaceId="w1" />);

    fireEvent.change(address(), { target: { value: "file:///etc/passwd" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "годятся только http и https",
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("says so when the system browser does not open", async () => {
    openUrl.mockRejectedValue("no handler");
    render(<BrowserView workspaceId="w1" />);

    fireEvent.change(address(), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Основной браузер не открылся",
    );
  });

  it("switches reloading on edits from the address bar", async () => {
    // Страница на localhost сама идёт за правками в проекте. Кому это мешает
    // — набирает в форме, — выключает здесь же, не уходя в настройки.
    render(<BrowserView workspaceId="w1" />);
    const toggle = screen.getByRole("button", {
      name: "Обновлять при правках",
    });
    const pressed = toggle.getAttribute("aria-pressed");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute(
      "aria-pressed",
      pressed === "true" ? "false" : "true",
    );
    expect(invoke).toHaveBeenCalledWith("browser_auto_reload", {
      enabled: pressed !== "true",
    });
  });

  it("keeps the open button out of reach while there is nothing to open", () => {
    render(<BrowserView workspaceId="w1" />);

    expect(screen.getByRole("button", { name: "Открыть" })).toBeDisabled();
  });

  it("does not call a page blank where the live page stands", async () => {
    // Живая страница стоит поверх ящика, а картинки за ней не просят:
    // «пусто» здесь было бы про то, что человек видит своими глазами.
    invoke.mockResolvedValue(
      frame({ url: "http://localhost:1420/", running: true, dockable: true }),
    );

    render(<BrowserView workspaceId="w1" />);
    await waitFor(() =>
      expect(address()).toHaveValue("http://localhost:1420/"),
    );

    expect(screen.queryByText("Страница пока пустая")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("steps the page back, forward and anew", async () => {
    invoke.mockResolvedValue(frame({ image: PIXEL, running: true }));
    render(<BrowserView workspaceId="w1" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Назад" })).toBeEnabled(),
    );

    for (const [name, step] of [
      ["Назад", "back"],
      ["Вперёд", "forward"],
      ["Обновить страницу", "reload"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(invoke).toHaveBeenCalledWith("browser_step", {
        workspaceId: "w1",
        step,
      });
    }
  });

  it("keeps the step buttons out of reach while the browser is not up", () => {
    render(<BrowserView workspaceId="w1" />);

    for (const name of ["Назад", "Вперёд", "Обновить страницу"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("follows the page again after a step", async () => {
    // Набранное, но не открытое, к странице, куда она ушла, не относится:
    // застрянь оно в поле, адрес врал бы о том, что на экране.
    let url = "http://example.com/second";
    invoke.mockImplementation((command: string) =>
      command === "browser_step"
        ? Promise.resolve()
        : Promise.resolve(frame({ image: PIXEL, url, running: true })),
    );
    render(<BrowserView workspaceId="w1" />);
    await waitFor(() => expect(address()).toHaveValue(url));
    fireEvent.change(address(), { target: { value: "half-typ" } });

    url = "http://example.com/first";
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));

    await waitFor(() => expect(address()).toHaveValue(url), {
      timeout: 4_000,
    });
  });

  it("says so when a step does not reach the page", async () => {
    invoke.mockImplementation((command: string) =>
      command === "browser_step"
        ? Promise.reject({ code: "browser_command_failed" })
        : Promise.resolve(frame({ image: PIXEL, running: true })),
    );
    render(<BrowserView workspaceId="w1" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Назад" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/не смог/);
  });
});
