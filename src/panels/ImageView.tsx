// Открытая картинка: её саму править нечем, но посмотреть на неё надо.
//
// Раньше PNG в редакторе был «двоичным файлом — показать нечем», хотя картинки
// в проекте лежат ровно затем, чтобы на них смотреть: иконка, скриншот в
// README, то, что агент только что нарисовал. Открывать их приходилось в
// стороннем просмотрщике, и картинка выпадала из проекта.

import { useEffect, useRef, useState } from "react";
import { localizeBackendError, useI18n } from "../i18n";
import { parentOf, watchWorkspaceTree } from "../files/fileTree";
import { mediaSource, readWorkspaceMedia, type FileMedia } from "../files/media";
import { fileName } from "../crew/claimLabel";

/// Размеры пишем в тех же единицах, что и загрузка обновления: килобайты для
/// иконок, мегабайты для скриншотов.
function formatSize(bytes: number, locale: string): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (bytes < 1024) {
    return `${number.format(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${number.format(bytes / 1024)} KB`;
  }
  return `${number.format(bytes / (1024 * 1024))} MB`;
}

export function ImageView(props: {
  workspaceId: string;
  path: string;
  /// Эту вкладку сейчас видно. Спрятанная за картинкой не ходит: она весит
  /// столько же, сколько файл, и держать её ради невидимой вкладки незачем.
  visible?: boolean;
}) {
  const { locale, t } = useI18n();
  const { workspaceId, path } = props;
  const visible = props.visible ?? true;
  const [media, setMedia] = useState<FileMedia | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  // Настоящий размер вместо вписанного в окно. По умолчанию вписываем: чаще
  // всего смотрят «что там нарисовано», а не считают пиксели.
  const [actual, setActual] = useState(false);
  // Сколько пикселей в картинке на самом деле. Спрашиваем у самой картинки:
  // разбирать заголовки девяти форматов в бэкенде ради двух чисел — работа,
  // которую вебвью уже сделал, пока рисовал.
  const [pixels, setPixels] = useState<{ width: number; height: number } | null>(
    null,
  );

  const load = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    setMedia(null);
    setError(null);
    setBroken(false);
    setPixels(null);
    if (!workspaceId || !path) {
      return;
    }
    const read = () => {
      void readWorkspaceMedia(workspaceId, path)
        .then((next) => {
          if (cancelled) {
            return;
          }
          setMedia(next);
          setBroken(false);
        })
        .catch((cause) => {
          if (!cancelled) {
            setError(localizeBackendError(cause));
          }
        });
    };
    load.current = read;
    read();
    return () => {
      cancelled = true;
      load.current = () => {};
    };
    // `t` сюда не входит нарочно: useI18n отдаёт новую функцию на каждом
    // рендере, и эффект, зависящий от неё, перечитывал бы файл без конца.
  }, [workspaceId, path]);

  // Картинку перерисовал агент — показываем новую. Своей правки здесь нет, так
  // что спрашивать не о чем: догоняем диск молча.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const missed = useRef(false);
  useEffect(() => {
    missed.current = false;
    if (!workspaceId || !path) {
      return;
    }
    const home = parentOf(path);
    return watchWorkspaceTree(workspaceId, (dirs, partial) => {
      if (!partial && !dirs.includes(home)) {
        return;
      }
      if (!visibleRef.current) {
        missed.current = true;
        return;
      }
      load.current();
    });
  }, [workspaceId, path]);

  useEffect(() => {
    if (visible && missed.current) {
      missed.current = false;
      load.current();
    }
  }, [visible]);

  const shown = media !== null && media.exists && !media.tooLarge && !broken;
  const meta: string[] = [];
  if (pixels) {
    meta.push(`${pixels.width} × ${pixels.height}`);
  }
  if (media && media.exists) {
    meta.push(formatSize(media.bytes, locale));
  }

  return (
    <div className="file-view">
      <div className="file-view-header">
        <span className="file-view-path" title={path}>
          {path}
        </span>
        {meta.length > 0 && (
          <span className="file-view-note">{meta.join(" · ")}</span>
        )}
        {shown && (
          <button
            type="button"
            className="file-view-zoom"
            aria-pressed={actual}
            title={t(actual ? "files.fitImage" : "files.actualSize")}
            onClick={() => setActual((current) => !current)}
          >
            {t(actual ? "files.fitImage" : "files.actualSize")}
          </button>
        )}
      </div>
      {error && (
        <div className="file-view-error" role="alert">
          {error}
        </div>
      )}
      {media === null && !error ? (
        <div className="file-view-empty">{t("files.loading")}</div>
      ) : !media?.exists ? (
        <div className="file-view-empty">{t("files.missing")}</div>
      ) : media.tooLarge ? (
        <div className="file-view-empty">{t("files.imageTooLarge")}</div>
      ) : broken ? (
        <div className="file-view-empty">{t("files.imageBroken")}</div>
      ) : (
        /* Клетка под картинкой — чтобы прозрачное было видно прозрачным, а не
           белым на светлой теме и чёрным на тёмной. */
        <div className={`picture-sheet ${actual ? "is-actual" : ""}`}>
          <img
            className="picture-shown"
            src={mediaSource(media)}
            alt={fileName(path)}
            onLoad={(event) =>
              setPixels({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setBroken(true)}
          />
        </div>
      )}
    </div>
  );
}
