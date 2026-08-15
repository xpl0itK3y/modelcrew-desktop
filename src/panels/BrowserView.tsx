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

export function BrowserView(props: { workspaceId: string }) {
  const { t } = useI18n();
  const [frame, setFrame] = useState<BrowserFrame>(NO_FRAME);
  const [address, setAddress] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setFrame(NO_FRAME);
    setFailure(null);
    return watchBrowserFrame(props.workspaceId, (next) => {
      setFrame(next);
      // Адрес в поле подтягивается за страницей, но не тогда, когда человек
      // в нём пишет: иначе набранное затиралось бы на каждом кадре.
      if (document.activeElement !== input.current) {
        setAddress(next.url);
      }
    });
  }, [props.workspaceId]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const url = normalizeAddress(address);
    if (!url || opening) {
      return;
    }
    setOpening(true);
    setFailure(null);
    openPage(props.workspaceId, url)
      .catch((error) => setFailure(localizeBackendError(error)))
      .finally(() => setOpening(false));
  };

  const picture = frameSource(frame.image);

  return (
    <div className="browser-view">
      <form className="browser-address-bar" onSubmit={submit}>
        <input
          ref={input}
          type="text"
          className="browser-address"
          value={address}
          spellCheck={false}
          placeholder={t("browser.address")}
          aria-label={t("browser.address")}
          onChange={(event) => setAddress(event.target.value)}
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
      <div className="browser-page">
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
