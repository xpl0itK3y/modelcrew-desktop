// Чем занята выбранная панель — строкой справа в шапке группы.
//
// Место одно на всю группу, поэтому здесь только активная панель. Про
// остальных говорит значок на их вкладках: там нет ширины под имя файла, а
// место справа пустует и подпись в нём не жмётся к имени агента.

import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  claimGlyph,
  claimTooltipKey,
  currentClaim,
  fileName,
} from "../crew/claimLabel";
import { getPanelClaims, subscribePanelClaims } from "../crew/claimStore";

export function PanelClaimStatus(props: { panelId: string }) {
  const { t } = useI18n();
  const [claims, setClaims] = useState(() => getPanelClaims(props.panelId));

  useEffect(() => {
    setClaims(getPanelClaims(props.panelId));
    return subscribePanelClaims(() => setClaims(getPanelClaims(props.panelId)));
  }, [props.panelId]);

  const current = currentClaim(claims);
  if (!current) {
    return null;
  }

  const { key, values } = claimTooltipKey(claims);
  const rest = claims.waitingFor ? 0 : claims.held.length - 1;
  return (
    <span
      className={`panel-claim ${claims.waitingFor ? "is-waiting" : ""}`}
      title={t(key, values)}
    >
      <span className="panel-claim-glyph" aria-hidden="true">
        {claimGlyph(claims)}
      </span>
      <span className="panel-claim-file">{fileName(current)}</span>
      {/* Остальные файлы — счётчиком: перечислять их негде, полный список
          лежит в подсказке. */}
      {rest > 0 && <span className="panel-claim-rest">+{rest}</span>}
    </span>
  );
}
