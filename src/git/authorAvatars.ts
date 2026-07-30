// Аватарка автора коммита без входа в GitHub: инициалы с детерминированным
// оттенком и URL реальной картинки по почте. Карта аватарок из GitHub API
// живёт отдельно (githubAvatars) и подставляется перед этими.

// Аватарка автора: инициалы + детерминированный оттенок из имени. Один автор
// всегда одного цвета — граф читается «в лицах», как в GitLens.
export function authorAvatar(name: string): { initials: string; hue: number } {
  const trimmed = name.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  let initials = "?";
  if (words.length >= 2) {
    initials =
      (Array.from(words[0])[0] ?? "") + (Array.from(words[1])[0] ?? "");
  } else if (words.length === 1) {
    initials = Array.from(words[0]).slice(0, 2).join("");
  }
  initials = initials.toUpperCase();

  let hash = 0;
  for (const char of trimmed) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return { initials, hue: hash % 360 };
}

// URL реальной аватарки по почте автора: GitHub-ноreply → аватар профиля
// GitHub, иначе Gravatar (d=404 — вернёт 404, если аватара нет, тогда откат
// на инициалы через onError). null — почты нет. Результат кешируется.
const avatarUrlCache = new Map<string, Promise<string | null>>();

async function computeAvatarUrl(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return null;
  }
  // GitHub noreply с числовым id: 12345+user@users.noreply.github.com
  const withId = normalized.match(
    /^(\d+)\+[^@]+@users\.noreply\.github\.com$/,
  );
  if (withId) {
    return `https://avatars.githubusercontent.com/u/${withId[1]}?s=48&v=4`;
  }
  // GitHub noreply без id: user@users.noreply.github.com
  const plain = normalized.match(/^([^@]+)@users\.noreply\.github\.com$/);
  if (plain) {
    return `https://github.com/${encodeURIComponent(plain[1])}.png?size=48`;
  }
  // Gravatar по SHA-256 почты.
  try {
    const bytes = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `https://www.gravatar.com/avatar/${hex}?d=404&s=48`;
  } catch {
    return null;
  }
}

export function resolveAvatarUrl(email: string): Promise<string | null> {
  const key = email.trim().toLowerCase();
  let cached = avatarUrlCache.get(key);
  if (!cached) {
    cached = computeAvatarUrl(email);
    avatarUrlCache.set(key, cached);
  }
  return cached;
}
