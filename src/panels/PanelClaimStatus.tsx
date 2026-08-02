// Что панель правит прямо сейчас — строкой в её шапке.
//
// Место выбрано по нужде: между вкладкой и кнопками группы пусто, а искать
// эту подпись где-то ещё пользователю неоткуда — она про конкретную панель.
// Когда правок нет, не рисуем ничего: дюжина шапок с постоянной подписью
// превращается в рябь.

import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { getPanelClaims, subscribePanelClaims } from "../crew/claimStore";

// Имя файла без пути: в шапке шириной с ладонь путь всё равно не поместится,
// а полный лежит в подсказке.
function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function PanelClaimStatus(props: { panelId: string }) {
  const { t } = useI18n();
  const [claims, setClaims] = useState(() => getPanelClaims(props.panelId));

  useEffect(() => {
    setClaims(getPanelClaims(props.panelId));
    return subscribePanelClaims(() => setClaims(getPanelClaims(props.panelId)));
  }, [props.panelId]);

  // Ожидание важнее правки: агент упёрся в занятый файл, и это то, что стоит
  // показать, даже если он параллельно правит что-то ещё.
  if (claims.waitingFor) {
    const name = fileName(claims.waitingFor);
    return (
      <span
        className="panel-claim is-waiting"
        title={t("crew.waitingFor", { path: claims.waitingFor })}
      >
        <span className="panel-claim-glyph" aria-hidden="true">
          ⏳
        </span>
        <span className="panel-claim-file">{name}</span>
      </span>
    );
  }

  if (claims.held.length === 0) {
    return null;
  }

  // Показываем последний взятый файл: он же тот, в котором агент работает
  // сейчас. Остальные — счётчиком, полный список в подсказке.
  const current = claims.held[claims.held.length - 1];
  const rest = claims.held.length - 1;
  return (
    <span
      className={`panel-claim ${claims.awaited ? "is-awaited" : ""}`}
      title={
        claims.awaited
          ? t("crew.holdingAwaited", { paths: claims.held.join("\n") })
          : t("crew.holding", { paths: claims.held.join("\n") })
      }
    >
      <span className="panel-claim-glyph" aria-hidden="true">
        ✎
      </span>
      <span className="panel-claim-file">{fileName(current)}</span>
      {rest > 0 && <span className="panel-claim-rest">+{rest}</span>}
      {/* Точка говорит держателю, что файл нужен ещё кому-то: без неё он
          отпустит его только по таймеру. */}
      {claims.awaited && (
        <span className="panel-claim-dot" aria-hidden="true" />
      )}
    </span>
  );
}
