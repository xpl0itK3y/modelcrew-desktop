// Разметка как её читают, а не как её пишут.
//
// Собирается из дерева блоков в узлы React, а не из строки в HTML: файл,
// который здесь показывают, пишет агент, и пути от его текста к исполняемому
// коду не должно существовать вовсе. Тег, скрипт или обработчик, набранный в
// документе, доедет сюда обычными буквами — показать его можно, выполнить
// нельзя.

import { useMemo, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../i18n";
import { grammarForTag, tokenize } from "../files/highlight";
import type { Block, Inline } from "../files/markdown";
import { parseMarkdown } from "../files/markdown";

/// Куда можно уйти из документа. Всё остальное — ссылка на соседний файл или
/// на якорь внутри страницы: увести по ней некуда, и притворяться ссылкой она
/// не должна.
const EXTERNAL = /^(https?|mailto):/i;

function Link(props: { href: string; children: ReactNode }) {
  if (!EXTERNAL.test(props.href)) {
    return (
      <span className="md-link is-local" title={props.href}>
        {props.children}
      </span>
    );
  }
  return (
    <a
      className="md-link"
      href={props.href}
      title={props.href}
      onClick={(event) => {
        // Обычный переход увёл бы всё окно приложения на чужую страницу, и
        // вернуться из него было бы нечем: у окна нет ни адресной строки, ни
        // кнопки «назад».
        event.preventDefault();
        void openUrl(props.href).catch(() => {});
      }}
    >
      {props.children}
    </a>
  );
}

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "code":
        return (
          <code key={index} className="md-code">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{inlines(node.children)}</strong>;
      case "em":
        return <em key={index}>{inlines(node.children)}</em>;
      case "strike":
        return <s key={index}>{inlines(node.children)}</s>;
      case "link":
        return (
          <Link key={index} href={node.href}>
            {inlines(node.children)}
          </Link>
        );
      case "image":
        // Картинку не грузим: локальный путь вебвью не отдаст без отдельного
        // разрешения, а сломанный значок хуже честной подписи.
        return (
          <span key={index} className="md-image" title={node.src}>
            {node.alt || node.src}
          </span>
        );
    }
  });
}

function Code(props: { language: string | null; text: string }) {
  const grammar = props.language ? grammarForTag(props.language) : null;
  const tokens = tokenize(props.text, grammar);
  return (
    <pre className="md-block-code">
      <code>
        {tokens.map((token, index) => (
          <span key={index} className={`tok-${token.kind}`}>
            {token.text}
          </span>
        ))}
      </code>
    </pre>
  );
}

function Heading(props: { level: number; children: ReactNode }) {
  const Tag = `h${Math.min(6, Math.max(1, props.level))}` as "h1";
  return <Tag className="md-heading">{props.children}</Tag>;
}

function blocks(list: Block[]): ReactNode[] {
  return list.map((block, index) => {
    switch (block.kind) {
      case "heading":
        return (
          <Heading key={index} level={block.level}>
            {inlines(block.children)}
          </Heading>
        );
      case "paragraph":
        return (
          <p key={index} className="md-paragraph">
            {inlines(block.children)}
          </p>
        );
      case "code":
        return <Code key={index} language={block.language} text={block.text} />;
      case "quote":
        return (
          <blockquote key={index} className="md-quote">
            {blocks(block.blocks)}
          </blockquote>
        );
      case "rule":
        return <hr key={index} className="md-rule" />;
      case "list":
        return block.ordered ? (
          <ol key={index} className="md-list" start={block.start}>
            {block.items.map((item, at) => (
              <li key={at}>{blocks(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={index} className="md-list">
            {block.items.map((item, at) => (
              <li key={at}>{blocks(item)}</li>
            ))}
          </ul>
        );
      case "table":
        return (
          <div key={index} className="md-table-scroll">
            <table className="md-table">
              <thead>
                <tr>
                  {block.head.map((cell, at) => (
                    <th key={at}>{inlines(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, at) => (
                  <tr key={at}>
                    {row.map((cell, column) => (
                      <td key={column}>{inlines(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function MarkdownView(props: { text: string }) {
  const { t } = useI18n();
  // Разбор идёт по всему файлу, а рендер случается и от того, что подъехала
  // полоска или сменилась метка правки: без памяти документ разбирался бы
  // заново на каждый кадр.
  const parsed = useMemo(() => parseMarkdown(props.text), [props.text]);
  if (parsed.length === 0) {
    return <div className="file-view-empty">{t("files.previewEmpty")}</div>;
  }
  return <div className="markdown-view">{blocks(parsed)}</div>;
}
