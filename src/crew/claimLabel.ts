// Как заявки панели превращаются в подпись: одни правила на вкладку и на
// шапку группы. Показывают они разное — значок и полную строку, — но решают
// одинаково, иначе вкладка и шапка расходились бы в показаниях.

import type { MessageKey } from "../i18n";
import type { PanelClaims } from "./claimStore";

// Имя файла без пути: ни на вкладке, ни в шапке путь не помещается, а полный
// лежит в подсказке.
export function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

// Ожидание обгоняет собственную правку: на нём агент стоит, а правка идёт
// своим ходом. Из своих файлов — последний взятый: в нём он сейчас и работает.
export function currentClaim(claims: PanelClaims): string | null {
  return claims.waitingFor ?? claims.held[claims.held.length - 1] ?? null;
}

// Значок несёт разницу состояний сам по себе, без опоры на цвет.
export function claimGlyph(claims: PanelClaims): string {
  return claims.waitingFor ? "⏳" : "✎";
}

export function claimTooltipKey(claims: PanelClaims): {
  key: MessageKey;
  values: Record<string, string>;
} {
  if (claims.waitingFor) {
    return { key: "crew.waitingFor", values: { path: claims.waitingFor } };
  }
  return {
    key: claims.awaited ? "crew.holdingAwaited" : "crew.holding",
    values: { paths: claims.held.join("\n") },
  };
}
