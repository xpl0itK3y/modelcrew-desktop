// Страница проекта внутри ModelCrew.
//
// Браузер живёт без своего окна, и его страницу человек видит здесь, а не в
// отдельном приложении поверх нашего. Приходит она картинкой: встроить сайт
// рамкой нельзя — `frame-src` в CSP стоит в `none`, и это охраняется тестом
// (`security/appSecurityConfig.test.ts`).
//
// Тем же браузером пользуются агенты проекта. Поэтому ящик — не только
// просмотр: набранный здесь адрес открывается в той же вкладке, которую
// агент и увидит.

import { useEffect, useRef, useState } from "react";
import {
  NO_FRAME,
  frameSource,
  normalizeAddress,
  openPage,
  watchBrowserFrame,
  type BrowserFrame,
} from "../browser/browserFrames";
import { localizeBackendError, useI18n } from "../i18n";

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
  // была той же формы, что и ящик.
  const pageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return watchBrowserFrame(
      props.workspaceId,
      (next) => {
        setFrame(next);
        setTrouble(null);
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
    );
  }, [props.workspaceId]);

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

  const failure = refusal ?? trouble;
  const picture = frameSource(frame.image);

  return (
    <div className="browser-view">
      <form className="browser-address-bar" onSubmit={submit}>
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
          type="submit"
          className="browser-open"
          disabled={opening || !normalizeAddress(address)}
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
          <p className="browser-empty">
            {
              // Первый запуск браузера занимает секунды, и без этой строки
              // нажатие «Открыть» выглядит как будто ничего не произошло.
              opening
                ? t("browser.opening")
                : frame.running
                  ? t("browser.blank")
                  : t("browser.notRunning")
            }
          </p>
        )}
      </div>
    </div>
  );
}
