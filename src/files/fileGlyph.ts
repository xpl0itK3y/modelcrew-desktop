// Чем помечен файл в дереве.
//
// Значок здесь — короткая надпись, а не картинка: расширений много, рисовать
// под каждое иконку значит держать их пачку и всё равно упереться в незнакомое.
// Надпись же читается сразу и для незнакомого расширения выглядит так же
// уместно, как для знакомого.

export type FileGlyph = {
  /// Что написать на значке. Пусто — значка нет, рисуется обычный файл.
  label: string;
  /// Разряд для окраски: у знакомых языков свой цвет, как в редакторах.
  kind: string;
};

const PLAIN: FileGlyph = { label: "", kind: "plain" };

// Порядок важен: `tsx` должен опознаться раньше `ts`, иначе `.tsx` разберётся
// как `x` — расширение мы берём по последней точке, но семейство ищем целиком.
const BY_EXTENSION: [string[], FileGlyph][] = [
  [["ts", "tsx", "mts", "cts"], { label: "TS", kind: "ts" }],
  [["js", "jsx", "mjs", "cjs"], { label: "JS", kind: "js" }],
  [["json", "jsonc", "json5"], { label: "{ }", kind: "json" }],
  [["md", "markdown", "mdx"], { label: "M↓", kind: "md" }],
  [["rs"], { label: "RS", kind: "rs" }],
  [["toml"], { label: "TOML", kind: "toml" }],
  [["yml", "yaml"], { label: "YML", kind: "yaml" }],
  [["css", "scss", "less"], { label: "CSS", kind: "css" }],
  [["html", "htm"], { label: "<>", kind: "html" }],
  [["sh", "bash", "zsh", "fish"], { label: "$", kind: "sh" }],
];

export function fileGlyph(name: string): FileGlyph {
  const extension = extensionOf(name);
  if (!extension) {
    return PLAIN;
  }
  for (const [family, glyph] of BY_EXTENSION) {
    if (family.includes(extension)) {
      return glyph;
    }
  }
  return PLAIN;
}

/// Расширение в нижнем регистре. У файла без имени (`.gitignore`) расширения
/// нет: точка там начинает имя, а не отделяет расширение, и `gitignore`
/// значком не помечается.
function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  if (at <= 0 || at === name.length - 1) {
    return "";
  }
  return name.slice(at + 1).toLowerCase();
}
