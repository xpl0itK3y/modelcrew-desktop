// Страница проекта внутри ModelCrew.
//
// Браузер живёт без своего окна, и его страницу человек видит здесь, а не в
// отдельном приложении поверх нашего. Встроить сайт рамкой нельзя —
// `frame-src` в CSP стоит в `none`, и это охраняется тестом
// (`security/appSecurityConfig.test.ts`). Поэтому на место ящика бэкенд
// ставит саму страницу, отдельным webview, и в ней щёлкают и печатают как в
// браузере (`browser/pageDock.ts`). Где система так не умеет и пока место
// чем-то закрыто, страница приходит картинкой.
//
// Тем же браузером пользуются агенты проекта. Поэтому ящик — не только
// просмотр: адрес, набранный здесь и отправленный Enter, открывается в той же
// вкладке, которую агент и увидит. Кнопка «Открыть» уводит адрес в основной
// браузер системы — тот, что человек выбрал сам: там его закладки, вход на
// сайты и инструменты разработчика.

import { useEffect, useRef, useState } from "react";
import {
  NO_FRAME,
  frameSource,
  isWebAddress,
  normalizeAddress,
  openOutside,
  openPage,
  stepPage,
  watchBrowserFrame,
  type BrowserFrame,
  type PageStep,
} from "../browser/browserFrames";
import { keepPageDocked, type PageDock } from "../browser/pageDock";
import { localizeBackendError, useI18n } from "../i18n";
import { BackIcon, ForwardIcon, ReloadIcon } from "../ui/Icons";

// Кнопки над страницей — как у любого браузера, в том же порядке.
const STEPS = [
  { step: "back", label: "browser.back", Icon: BackIcon },
  { step: "forward", label: "browser.forward", Icon: ForwardIcon },
  { step: "reload", label: "browser.reload", Icon: ReloadIcon },
] as const;

/**
 * Ящик со страницей проекта.
 *
 * Содержимое живёт под ключом проекта: со сменой проекта состояние обязано
 * начаться заново. Иначе в ящике до первого ответа нового проекта висел бы
 * кадр предыдущего — чужая страница целиком, — а в адресной строке чужой
 * адрес, который ушёл бы в чужой браузер, нажми человек «Открыть». Сброс
 * эффектом тут не спасает: эффект выполняется уже после отрисовки.
 */
export function BrowserView(props: { workspaceId: string }) {
  return <BrowserProjectView key={props.workspaceId} {...props} />;
}

function BrowserProjectView(props: { workspaceId: string }) {
  const { t } = useI18n();
  const [frame, setFrame] = useState<BrowserFrame>(NO_FRAME);
  const [address, setAddress] = useState("");
  // Отказ на «Открыть» — про действие человека, и висит он до следующей
  // попытки или до тех пор, пока страница куда-нибудь не уйдёт. Обрыв связи —
  // про сам браузер, и снимается первым же дошедшим кадром.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // Поле трогали руками. Пока это так, адрес за страницей не следует: кадр
  // приходит раз в секунду и стирал бы набранное — достаточно было увести
  // курсор из поля, и от адреса ничего не оставалось.
  const typed = useRef(false);
  // Где стояла страница, когда отказали. Ушла дальше — отказ уже не про то,
  // что видно, и убирается сам.
  const refusedAt = useRef<string | null>(null);
  // Место под кадр: по нему бэкенд подгоняет саму страницу, чтобы картинка
  // была той же формы, что и ящик. Живую страницу ставят ровно сюда же.
  const pageRef = useRef<HTMLDivElement | null>(null);
  // Стоит ли страница здесь живой. Пока стоит, картинку не просим.
  const docked = useRef(false);
  const dock = useRef<PageDock | null>(null);

  useEffect(() => {
    return watchBrowserFrame(
      props.workspaceId,
      (next) => {
        setFrame(next);
        setTrouble(null);
        // Страницу открыли заново или увели из ящика, пока окно прятали:
        // место надо прислать снова, хоть оно и не сдвинулось.
        if (docked.current && !next.docked) {
          dock.current?.forget();
        }
        if (!typed.current) {
          setAddress(next.url);
        }
        if (refusedAt.current !== null && next.url !== refusedAt.current) {
          refusedAt.current = null;
          setRefusal(null);
        }
      },
      (error) => setTrouble(localizeBackendError(error)),
      () => {
        const box = pageRef.current?.getBoundingClientRect();
        // Нулевой размер бывает, пока ящик ещё раскрывается: подгонять по
        // нему — значит на мгновение сжать страницу в точку.
        return box && box.width > 0 && box.height > 0
          ? { width: Math.round(box.width), height: Math.round(box.height) }
          : null;
      },
      () => docked.current,
    );
  }, [props.workspaceId]);

  const dockable = frame.running && frame.dockable;
  useEffect(() => {
    const place = pageRef.current;
    if (!dockable || !place) {
      return;
    }
    const current = keepPageDocked(
      props.workspaceId,
      place,
      (next) => {
        docked.current = next;
      },
      (error) => setTrouble(localizeBackendError(error)),
    );
    dock.current = current;
    return () => {
      current.stop();
      dock.current = null;
      docked.current = false;
    };
  }, [dockable, props.workspaceId]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const url = normalizeAddress(address);
    if (!url || opening) {
      return;
    }
    setOpening(true);
    setRefusal(null);
    refusedAt.current = null;
    openPage(props.workspaceId, url)
      // Открылось — снова следуем за страницей: она сама скажет, куда попала,
      // с поправкой на редиректы. Не открылось — набранное остаётся, его
      // правят и пробуют ещё раз.
      .then(() => {
        typed.current = false;
      })
      .catch((error) => {
        setRefusal(localizeBackendError(error));
        refusedAt.current = frame.url;
      })
      .finally(() => setOpening(false));
  };

  // Набранное или то, где стоит страница: поле показывает ровно это.
  const outside = () => {
    const url = normalizeAddress(address);
    if (!url) {
      return;
    }
    setRefusal(null);
    refusedAt.current = null;
    openOutside(url).catch(() => {
      setRefusal(
        isWebAddress(url)
          ? t("browser.outsideFailed")
          : t("error.browserUrlUnsupported"),
      );
      refusedAt.current = frame.url;
    });
  };

  const step = (next: PageStep) => {
    // Страница уйдёт сама, и адресная строка снова идёт за ней: набранное,
    // но не открытое, к новой странице уже не относится.
    typed.current = false;
    stepPage(props.workspaceId, next).catch((error) =>
      setTrouble(localizeBackendError(error)),
    );
  };

  const failure = refusal ?? trouble;
  const picture = frameSource(frame.image);
  // Первый запуск браузера занимает секунды, и без надписи нажатие
  // «Открыть» выглядит как будто ничего не произошло. Живая страница стоит
  // поверх этого места или вот-вот встанет, а её кадр придёт со следующим
  // опросом: «пусто» про неё соврало бы.
  const notice = opening
    ? t("browser.opening")
    : !frame.running
      ? t("browser.notRunning")
      : dockable
        ? null
        : t("browser.blank");

  return (
    <div className="browser-view">
      <form className="browser-address-bar" onSubmit={submit}>
        {STEPS.map(({ step: kind, label, Icon }) => (
          <button
            key={kind}
            type="button"
            className={`icon-button ${frame.running ? "" : "is-disabled"}`}
            title={t(label)}
            aria-label={t(label)}
            disabled={!frame.running}
            onClick={() => step(kind)}
          >
            <Icon />
          </button>
        ))}
        <input
          type="text"
          className="browser-address"
          value={address}
          spellCheck={false}
          placeholder={t("browser.address")}
          aria-label={t("browser.address")}
          onChange={(event) => {
            typed.current = true;
            setAddress(event.target.value);
          }}
        />
        <button
          type="button"
          className="browser-open"
          title={t("browser.openOutside")}
          disabled={!normalizeAddress(address)}
          onClick={outside}
        >
          {t("browser.open")}
        </button>
      </form>
      {failure && (
        <p className="browser-failure" role="alert">
          {failure}
        </p>
      )}
      <div className="browser-page" ref={pageRef}>
        {picture ? (
          <img
            className="browser-frame"
            src={picture}
            alt={frame.title || t("browser.frameAlt")}
          />
        ) : (
          notice && <p className="browser-empty">{notice}</p>
        )}
      </div>
    </div>
  );
}
