import type { Update } from "@tauri-apps/plugin-updater";
import { translate, type Locale } from "../i18n";
import type { UpdateDetails } from "./types";

const RELEASES_BASE_URL =
  "https://github.com/xpl0itK3y/modelcrew-desktop/releases";
const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 200;
const MAX_HIGHLIGHT_LENGTH = 120;

type PlainObject = Record<string, unknown>;
type ReleaseDetailsSource = Pick<Update, "version" | "body" | "rawJson">;

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Metadata from the update endpoint is untrusted. Keep only short strings,
 * remove control characters and render the result as ordinary React text.
 */
function plainText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0 || Array.from(normalized).length > maximumLength) {
    return null;
  }
  return normalized;
}

function shortenPlainText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  const characters = Array.from(normalized);
  return characters.length <= maximumLength
    ? normalized
    : `${characters.slice(0, maximumLength - 1).join("")}…`;
}

function safeReleaseUrl(value: unknown, version: string): string {
  const fallback = `${RELEASES_BASE_URL}/tag/v${encodeURIComponent(version)}`;
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith("/xpl0itK3y/modelcrew-desktop/releases/")
    ) {
      return url.toString();
    }
  } catch {
    // A malformed URL is ignored in favour of the known public repository.
  }
  return fallback;
}

function localizedMetadata(
  rawJson: PlainObject,
  locale: Locale,
): Omit<UpdateDetails, "version" | "releaseUrl"> | null {
  const modelcrew = rawJson.modelcrew;
  if (!isPlainObject(modelcrew) || !isPlainObject(modelcrew.releaseNotes)) {
    return null;
  }
  const candidate = modelcrew.releaseNotes[locale];
  if (!isPlainObject(candidate)) {
    return null;
  }

  const title = plainText(candidate.title, MAX_TITLE_LENGTH);
  const summary = plainText(candidate.summary, MAX_SUMMARY_LENGTH);
  if (!title || !summary || !Array.isArray(candidate.highlights)) {
    return null;
  }
  if (candidate.highlights.length < 1 || candidate.highlights.length > 5) {
    return null;
  }
  const highlights = candidate.highlights.map((highlight) =>
    plainText(highlight, MAX_HIGHLIGHT_LENGTH),
  );
  if (highlights.some((highlight) => highlight === null)) {
    return null;
  }
  return { title, summary, highlights: highlights as string[] };
}

export function releaseDetails(
  update: ReleaseDetailsSource,
  locale: Locale,
): UpdateDetails {
  const rawJson = isPlainObject(update.rawJson) ? update.rawJson : {};
  const localized = localizedMetadata(rawJson, locale);
  const fallbackSummary =
    shortenPlainText(update.body, MAX_SUMMARY_LENGTH) ??
    shortenPlainText(rawJson.notes, MAX_SUMMARY_LENGTH) ??
    translate("update.fallbackSummary", {}, locale);
  const modelcrew = isPlainObject(rawJson.modelcrew) ? rawJson.modelcrew : {};

  return {
    version: update.version,
    title:
      localized?.title ??
      translate("update.readyTitle", { version: update.version }, locale),
    summary: localized?.summary ?? fallbackSummary,
    highlights: localized?.highlights ?? [],
    releaseUrl: safeReleaseUrl(modelcrew.releaseUrl, update.version),
  };
}
