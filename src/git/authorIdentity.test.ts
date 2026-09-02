import { describe, expect, it } from "vitest";
import { canonicalAuthorNames, withCanonicalAuthors } from "./authorIdentity";

type Commit = {
  author: string;
  authorEmail: string;
  parents: string[];
  displayAuthor?: string;
};

function commit(
  author: string,
  authorEmail: string,
  parents: string[] = ["p1"],
): Commit {
  return { author, authorEmail, parents };
}

function merge(author: string, authorEmail: string): Commit {
  return commit(author, authorEmail, ["p1", "p2"]);
}

describe("canonicalAuthorNames", () => {
  it("gives one person one name when GitHub signed their merges differently", () => {
    // Ровно то, что видно в истории: merge, сделанный кнопкой на GitHub, идёт
    // под именем из профиля, а обычные коммиты — под user.name из конфига.
    // Почта одна, значит и человек один.
    const history = [
      merge("Vladimir", "chiglinzev.vladimir@icloud.com"),
      commit("Modern-Messiah", "chiglinzev.vladimir@icloud.com"),
      merge("Vladimir", "chiglinzev.vladimir@icloud.com"),
      commit("Modern-Messiah", "chiglinzev.vladimir@icloud.com"),
    ];

    const named = withCanonicalAuthors(history);
    expect(named.map((item) => item.displayAuthor)).toEqual([
      "Modern-Messiah",
      "Modern-Messiah",
      "Modern-Messiah",
      "Modern-Messiah",
    ]);
    // Подпись в самом коммите настоящая и остаётся нетронутой.
    expect(named[0].author).toBe("Vladimir");
  });

  it("does not let the merge-to-commit ratio decide the name", () => {
    // Загруженного куска истории может не хватить, чтобы обычных коммитов
    // оказалось больше. Имя от этого меняться не должно: иначе при прокрутке
    // автор переименовывался бы на глазах.
    const history = [
      merge("Vladimir", "one@example.com"),
      merge("Vladimir", "one@example.com"),
      merge("Vladimir", "one@example.com"),
      commit("Modern-Messiah", "one@example.com"),
    ];

    expect(canonicalAuthorNames(history).get("one@example.com")).toBe(
      "Modern-Messiah",
    );
  });

  it("falls back to the merge name when that is all the email ever had", () => {
    const history = [
      merge("Vladimir", "one@example.com"),
      merge("Vova", "one@example.com"),
      merge("Vladimir", "one@example.com"),
    ];

    expect(canonicalAuthorNames(history).get("one@example.com")).toBe(
      "Vladimir",
    );
  });

  it("keeps different people apart even when a name is shared", () => {
    // Имя — не опознавательный знак: двое «Alex» с разной почтой остаются
    // двумя людьми, и сводить их вместе было бы хуже исходной беды.
    const history = [
      commit("Alex", "alex@example.com"),
      merge("Alexander", "alex@example.com"),
      commit("Alex", "other@example.com"),
    ];

    const canonical = canonicalAuthorNames(history);
    expect(canonical.get("alex@example.com")).toBe("Alex");
    expect(canonical.has("other@example.com")).toBe(false);
  });

  it("treats the same address in different case as one person", () => {
    const history = [
      merge("Vladimir", "One@Example.com"),
      commit("Modern-Messiah", "one@example.com"),
    ];

    expect(canonicalAuthorNames(history).get("one@example.com")).toBe(
      "Modern-Messiah",
    );
  });

  it("leaves a history where everyone signs consistently alone", () => {
    const history = [
      commit("Denis", "denis@example.com"),
      merge("Denis", "denis@example.com"),
      commit("Valde", "valde@example.com"),
    ];

    expect(canonicalAuthorNames(history).size).toBe(0);
    expect(withCanonicalAuthors(history).map((item) => item.displayAuthor)).toEqual(
      ["Denis", "Denis", "Valde"],
    );
  });

  it("survives commits without an author or an address", () => {
    const history = [
      commit("", "one@example.com"),
      commit("Modern-Messiah", ""),
      merge("Vladimir", "one@example.com"),
      commit("Modern-Messiah", "one@example.com"),
    ];

    const named = withCanonicalAuthors(history);
    expect(named[1].displayAuthor).toBe("Modern-Messiah");
    expect(named[2].displayAuthor).toBe("Modern-Messiah");
  });

  it("prefers the most recent of two names used equally often", () => {
    // История приходит от свежих к старым, поэтому верхнее имя и есть то,
    // которым человек подписывается сейчас.
    const history = [
      commit("Modern-Messiah", "one@example.com"),
      commit("Vladimir", "one@example.com"),
      merge("Vladimir", "one@example.com"),
    ];

    expect(canonicalAuthorNames(history).get("one@example.com")).toBe(
      "Modern-Messiah",
    );
  });
});
