// Окно с отказом git.
//
// Строки в панели хватает, пока сбой описывается фразой: «ветка уже есть»,
// «коммит не в текущей ветке». Но когда отказывается сам git, распознать
// причину мы не можем и говорим «команда git не выполнилась» — а git в это
// время назвал и файлы, которые перезапишет checkout, и то, что с ними делать.
// Эти слова и показываем: они и есть ответ на вопрос «что случилось».
//
// Окно, а не строка, по двум причинам. Такой отказ занимает несколько строк, и
// в панели шириной в треть экрана он бы её распёр. И гасить его по таймеру
// нельзя — прочитать нужно всё, а не успеть за шесть секунд.

import { useEffect, useRef, useState } from "react";
import { useI18n, type BackendFailure } from "../../i18n";

export function GitErrorDialog(props: {
  failure: BackendFailure;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const okRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    okRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const copy = async () => {
    // Копируем вместе с заголовком: в отчёте об ошибке одна голая простыня из
    // git не говорит, за каким действием она последовала.
    const text = props.failure.details
      ? `${props.failure.message}\n\n${props.failure.details}`
      : props.failure.message;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Буфер обмена мог быть занят другим приложением — текст всё равно на
      // экране и выделяется мышью.
    }
  };

  return (
    <div className="git-reword-backdrop" onPointerDown={props.onClose}>
      <div
        className="git-error-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={props.failure.message}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="git-error-head">
          <svg
            className="git-error-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              d="M12 3.6 22 20.4H2z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <path
              d="M12 9.6v4.8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <circle cx="12" cy="17.4" r="1.1" fill="currentColor" />
          </svg>
          <span className="git-error-title">{props.failure.message}</span>
        </div>
        {props.failure.details && (
          <pre className="git-error-output">{props.failure.details}</pre>
        )}
        <div className="git-reword-actions">
          <button
            type="button"
            className="git-actions-cancel"
            onClick={() => void copy()}
          >
            {copied ? t("git.copied") : t("common.copy")}
          </button>
          <button
            ref={okRef}
            type="button"
            className="git-actions-go"
            onClick={props.onClose}
          >
            {t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
