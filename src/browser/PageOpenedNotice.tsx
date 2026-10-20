// Плашка «агент открыл страницу».
//
// Число на глобусе — точка в углу заголовка, и пока человек смотрит в
// терминал, её не видно. Системный баннер, пока окно впереди, macOS не
// показывает вовсе. Выходило, что агент открыл страницу, а человек не знает,
// открыл ли: ящик закрыт, и ничего не шелохнулось. Поэтому о странице говорит
// само окно — плашкой у глобуса, с кнопкой, которая страницу и показывает.

import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { CloseIcon, GlobeIcon } from "../ui/Icons";
import { useAnimatedPresence } from "../ui/useAnimatedPresence";
import { pageLabel, type OpenedPage } from "./pagesOpened";

/** Сколько плашка висит, пока человек на неё не смотрит. */
export const NOTICE_MS = 8_000;

type Props = {
  page: OpenedPage | null;
  // Проект страницы, если он не тот, что открыт сейчас. Тогда кнопка сначала
  // переключит на него.
  otherProject: string | null;
  onOpen: () => void;
  onDismiss: () => void;
};

export function PageOpenedNotice(props: Props) {
  const { t } = useI18n();
  const presence = useAnimatedPresence(props.page, 160);
  const dismiss = useRef(props.onDismiss);
  dismiss.current = props.onDismiss;
  // Пока курсор на плашке, её читают или тянутся к кнопке — убирать нельзя.
  const hovered = useRef(false);
  const restart = useRef<() => void>(() => {});

  // Срок идёт, только пока окно в фокусе: плашка, исчезнувшая, пока человек
  // был в другом приложении, ни о чём бы ему не сказала.
  useEffect(() => {
    if (!props.page) {
      return;
    }
    let timer: number | undefined;
    const start = () => {
      window.clearTimeout(timer);
      if (!hovered.current && document.hasFocus()) {
        timer = window.setTimeout(() => dismiss.current(), NOTICE_MS);
      }
    };
    restart.current = start;
    start();
    window.addEventListener("focus", start);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", start);
      restart.current = () => {};
    };
  }, [props.page]);

  if (!presence) {
    return null;
  }
  const page = presence.item;
  return (
    <div
      className={`page-opened-notice ${presence.closing ? "is-closing" : ""}`}
      role="status"
      aria-live="polite"
      onMouseEnter={() => {
        hovered.current = true;
        restart.current();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        restart.current();
      }}
    >
      <span className="page-opened-notice-icon" aria-hidden="true">
        <GlobeIcon />
      </span>
      <span className="page-opened-notice-text">
        <span className="page-opened-notice-title">
          {props.otherProject
            ? t("browser.pageOpenedIn", { project: props.otherProject })
            : t("browser.pageOpened")}
        </span>
        <span className="page-opened-notice-page" title={page.url}>
          {pageLabel(page)}
        </span>
      </span>
      <button
        type="button"
        className="page-opened-notice-open"
        disabled={presence.closing}
        onClick={props.onOpen}
      >
        {t("browser.showPage")}
      </button>
      <button
        type="button"
        className="icon-button page-opened-notice-close"
        title={t("browser.dismissNotice")}
        aria-label={t("browser.dismissNotice")}
        disabled={presence.closing}
        onClick={props.onDismiss}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
