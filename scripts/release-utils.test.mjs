import assert from "node:assert/strict";
import test from "node:test";
import {
  characterCount,
  containsPlaceholder,
  isSemVer,
  validateReleaseNote,
} from "./release-utils.mjs";

const validNote = {
  version: "0.0.1",
  ru: {
    title: "Релиз",
    summary: "Краткое описание",
    highlights: ["Первое изменение"],
  },
  en: {
    title: "Release",
    summary: "Short description",
    highlights: ["First change"],
  },
};

test("isSemVer accepts valid SemVer and rejects ambiguous versions", () => {
  assert.equal(isSemVer("0.0.1"), true);
  assert.equal(isSemVer("1.2.3-beta.1+build.9"), true);
  assert.equal(isSemVer("01.2.3"), false);
  assert.equal(isSemVer("v1.2.3"), false);
  assert.equal(isSemVer("1.2"), false);
});

test("characterCount counts Unicode code points", () => {
  assert.equal(characterCount("Русский"), 7);
  assert.equal(characterCount("🚀"), 1);
});

test("placeholder detection covers generated templates", () => {
  assert.equal(containsPlaceholder("__REPLACE_ME_RU_TITLE__"), true);
  assert.equal(containsPlaceholder("TODO: write notes"), true);
  assert.equal(containsPlaceholder("Ready for release"), false);
});

test("a complete bilingual release note passes", () => {
  assert.deepEqual(
    validateReleaseNote(validNote, { expectedVersion: "0.0.1" }),
    [],
  );
});

test("release note limits and placeholders fail", () => {
  const invalidNote = structuredClone(validNote);
  invalidNote.ru.summary = "x".repeat(201);
  invalidNote.en.highlights = ["TODO"];
  invalidNote.version = "0.0.2";

  const errors = validateReleaseNote(invalidNote, {
    expectedVersion: "0.0.1",
  });

  assert.ok(errors.some((error) => error.includes("does not match filename")));
  assert.ok(errors.some((error) => error.includes("must not exceed 200")));
  assert.ok(errors.some((error) => error.includes("placeholder")));
});
