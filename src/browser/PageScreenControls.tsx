// Экран страницы внизу ящика — как панель устройств в инструментах
// разработчика: размер вписывают руками, экран поворачивают набок, а три
// самых частых экрана стоят кнопками.

import { useRef, useState, type KeyboardEvent } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { DesktopIcon, PhoneIcon, RotateIcon, TabletIcon } from "../ui/Icons";
import {
  DEVICES,
  DEVICE_SIZES,
  deviceOf,
  fitScreen,
  rotated,
  sameScreen,
  saveScreen,
  useScreen,
  type ScreenSize,
} from "./pageDevice";

// Экраны внизу ящика — от широкого к узкому.
const DEVICE_BUTTONS = {
  desktop: { label: "browser.deviceDesktop", Icon: DesktopIcon },
  tablet: { label: "browser.deviceTablet", Icon: TabletIcon },
  phone: { label: "browser.devicePhone", Icon: PhoneIcon },
} as const;

type Side = "width" | "height";
type Draft = Record<Side, string>;

const SIDES: readonly { side: Side; label: MessageKey }[] = [
  { side: "width", label: "browser.screenWidth" },
  { side: "height", label: "browser.screenHeight" },
];

export function PageScreenControls(props: {
  // Сколько странице досталось на деле. `null` — место ещё не измерено.
  viewport: ScreenSize | null;
}) {
  const { t } = useI18n();
  const wanted = useScreen();
  const device = deviceOf(wanted);
  // У страницы во весь ящик своего размера нет: поля показывают, сколько
  // есть, — и с этого же размера удобнее всего начать свой.
  const shown = wanted ?? props.viewport;
  // Набранное, пока фокус в полях. Ссылка — чтобы уход из поля после Escape
  // знал, что набранное уже выброшено: состояние до него ещё не дошло.
  const [draft, setDraftState] = useState<Draft | null>(null);
  const typed = useRef<Draft | null>(null);
  const fields = useRef<HTMLDivElement | null>(null);
  const setDraft = (next: Draft | null) => {
    typed.current = next;
    setDraftState(next);
  };

  const values: Draft = draft ?? {
    width: shown ? String(shown.width) : "",
    height: shown ? String(shown.height) : "",
  };

  // Экран, которому ящик мал, ужимается до ящика, и сказать об этом надо:
  // вёрстка перед глазами — уже не та, что вписали.
  const squeezed =
    wanted !== null &&
    props.viewport !== null &&
    (props.viewport.width < wanted.width - 1 ||
      props.viewport.height < wanted.height - 1);

  const commit = () => {
    const entered = typed.current;
    setDraft(null);
    if (!entered) {
      return;
    }
    // Стёртое поле — эту сторону не трогаем.
    const side = (key: Side) =>
      /^\d+$/.test(entered[key]) ? Number(entered[key]) : (shown?.[key] ?? NaN);
    const typedSize = { width: side("width"), height: side("height") };
    // Вписали то же, что было, — ящик так и остаётся ящиком.
    if (sameScreen(typedSize, shown)) {
      return;
    }
    const next = fitScreen(typedSize.width, typedSize.height);
    if (next && !sameScreen(next, shown)) {
      saveScreen(next);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setDraft(null);
      event.currentTarget.blur();
    }
  };

  return (
    <>
      <div
        className={`browser-screen-size ${squeezed ? "is-squeezed" : ""}`}
        ref={fields}
        role="group"
        aria-label={t("browser.screenSize")}
        title={
          squeezed && props.viewport
            ? t("browser.screenSqueezed", props.viewport)
            : t("browser.screenSizeHint")
        }
      >
        {SIDES.map(({ side, label }, position) => (
          <span key={side} className="browser-screen-side">
            {position > 0 && <span aria-hidden="true">×</span>}
            <input
              type="text"
              inputMode="numeric"
              className="browser-screen-field"
              value={values[side]}
              spellCheck={false}
              aria-label={t(label)}
              onFocus={(event) => {
                if (typed.current === null) {
                  setDraft(values);
                }
                event.currentTarget.select();
              }}
              onChange={(event) =>
                setDraft({
                  ...values,
                  [side]: event.target.value.replace(/\D/g, ""),
                })
              }
              onKeyDown={onKeyDown}
              // Ширину и высоту вписывают одним жестом: переход между полями
              // ещё не повод перестраивать страницу.
              onBlur={(event) => {
                if (!fields.current?.contains(event.relatedTarget as Node)) {
                  commit();
                }
              }}
            />
          </span>
        ))}
      </div>
      {wanted && (
        <button
          type="button"
          className="icon-button browser-rotate"
          title={t("browser.screenRotate")}
          aria-label={t("browser.screenRotate")}
          onClick={() => saveScreen(rotated(wanted))}
        >
          <RotateIcon />
        </button>
      )}
      <div
        className="browser-devices"
        role="group"
        aria-label={t("browser.device")}
      >
        {DEVICES.map((kind) => {
          const { label, Icon } = DEVICE_BUTTONS[kind];
          return (
            <button
              key={kind}
              type="button"
              className="icon-button browser-device"
              title={t(label)}
              aria-label={t(label)}
              aria-pressed={device === kind}
              onClick={() => saveScreen(DEVICE_SIZES[kind])}
            >
              <Icon />
            </button>
          );
        })}
      </div>
    </>
  );
}
