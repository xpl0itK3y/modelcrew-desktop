import { describe, expect, it } from "vitest";
// Конфиги читаются как текст с диска (?raw), а не импортируются как JSON:
// тест обязан видеть ровно то, что уедет в сборку, включая опечатки в строках.
// Путь разрешается относительно этого модуля, а не рабочего каталога vitest.
import tauriConfigRaw from "../../src-tauri/tauri.conf.json?raw";

const capabilityFilesRaw = import.meta.glob(
  "../../src-tauri/capabilities/*.json",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

interface TauriConfig {
  build?: {
    frontendDist?: string;
    devUrl?: string;
  };
  app?: {
    withGlobalTauri?: boolean;
    windows?: Array<Record<string, unknown>>;
    security?: {
      csp?: string;
      devCsp?: string;
      dangerousDisableAssetCspModification?: unknown;
      assetProtocol?: { enable?: boolean; scope?: unknown };
      capabilities?: unknown;
    };
  };
  bundle?: {
    createUpdaterArtifacts?: boolean;
  };
  plugins?: Record<string, unknown> & {
    updater?: { pubkey?: string; endpoints?: string[] };
  };
}

interface Capability {
  identifier?: string;
  windows?: string[];
  webviews?: string[];
  remote?: unknown;
  permissions?: Array<string | Record<string, unknown>>;
}

const config = JSON.parse(tauriConfigRaw) as TauriConfig;

const capabilities = Object.entries(capabilityFilesRaw).map(
  ([path, raw]) =>
    [
      path.slice(path.lastIndexOf("/") + 1),
      JSON.parse(raw) as Capability,
    ] as const,
);

const defaultCapability = capabilities.find(
  ([name]) => name === "default.json",
)?.[1] as Capability;

/** Разбирает CSP в пары "директива → источники", сохраняя порядок объявления. */
const parseCsp = (csp: string): Array<readonly [string, string[]]> =>
  csp
    .split(";")
    .map((part) => part.trim().split(/\s+/u).filter(Boolean))
    .filter((tokens) => tokens.length > 0)
    .map((tokens) => [tokens[0].toLowerCase(), tokens.slice(1)] as const);

const directives = (csp: string) => {
  const map = new Map<string, string[]>();
  // Браузер применяет первое вхождение директивы, поэтому дубликаты не
  // перетирают уже разобранные источники.
  for (const [name, sources] of parseCsp(csp)) {
    if (!map.has(name)) {
      map.set(name, sources);
    }
  }
  return map;
};

const productionCsp = config.app?.security?.csp ?? "";
const devCsp = config.app?.security?.devCsp ?? "";
const production = directives(productionCsp);

const sourcesOf = (name: string) => production.get(name) ?? [];

const hasWildcard = (sources: string[]) =>
  sources.some((source) => source.includes("*"));

/** Источник, который тянет содержимое из сети: со схемой, протокол-relative или голый хост. */
const isRemoteSource = (source: string) =>
  /^(?:https?|wss?|ftp):/iu.test(source) ||
  source.startsWith("//") ||
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$)/iu.test(source);

// Хосты, которые Tauri сам использует для IPC на Windows/Android.
const IPC_HOSTS = new Set(["ipc.localhost", "tauri.localhost"]);

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

describe("production CSP", () => {
  it("ships a non-empty content security policy", () => {
    expect(typeof productionCsp).toBe("string");
    expect(productionCsp.trim().length).toBeGreaterThan(0);
    expect(production.size).toBeGreaterThan(0);
  });

  it("locks the exact set of directives", () => {
    // Новая директива (например frame-ancestors или worker-src с внешним
    // источником) обязана проходить через ревью этого теста.
    expect([...production.keys()].sort()).toEqual([
      "base-uri",
      "connect-src",
      "default-src",
      "font-src",
      "form-action",
      "frame-src",
      "img-src",
      "media-src",
      "object-src",
      "script-src",
      "style-src",
    ]);
  });

  it("declares every directive only once", () => {
    const names = parseCsp(productionCsp).map(([name]) => name);
    expect(names).toEqual([...new Set(names)]);
  });

  it("falls back to self for anything not listed explicitly", () => {
    expect(sourcesOf("default-src")).toEqual(["'self'"]);
  });

  it("executes only scripts bundled with the app", () => {
    const script = sourcesOf("script-src");
    expect(script).toEqual(["'self'"]);
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'strict-dynamic'");
    expect(hasWildcard(script)).toBe(false);
    expect(script.some((source) => isRemoteSource(source))).toBe(false);
    // Схема без хоста ("https:", "data:") пускает любой скрипт этой схемы.
    expect(script.some((source) => /^[a-z][a-z0-9+.-]*:$/iu.test(source))).toBe(
      false,
    );
  });

  it("blocks plugins, framing, form posts and base-tag hijacking", () => {
    expect(sourcesOf("object-src")).toEqual(["'none'"]);
    expect(sourcesOf("frame-src")).toEqual(["'none'"]);
    expect(sourcesOf("form-action")).toEqual(["'none'"]);
    expect(sourcesOf("base-uri")).toEqual(["'self'"]);
  });

  it("allows only the local IPC transports to be contacted", () => {
    const connect = sourcesOf("connect-src");
    expect(connect).toEqual(["'self'", "ipc:", "http://ipc.localhost"]);
    expect(hasWildcard(connect)).toBe(false);
    for (const source of connect) {
      if (/^https?:\/\//iu.test(source)) {
        expect(IPC_HOSTS.has(new URL(source).hostname)).toBe(true);
      } else {
        // Голый хост без схемы тоже открывает сеть, поэтому его быть не должно.
        expect(isRemoteSource(source)).toBe(false);
      }
    }
  });

  it("loads remote images only from pinned https hosts", () => {
    const img = sourcesOf("img-src");
    expect(hasWildcard(img)).toBe(false);
    for (const source of img) {
      if (source === "'self'" || source === "data:") {
        continue;
      }
      expect(source.startsWith("https://")).toBe(true);
      const url = new URL(source);
      expect(url.hostname).not.toContain("*");
      expect(url.hostname.length).toBeGreaterThan(0);
    }
    expect(img).toContain("'self'");
    expect(img.some((source) => source.startsWith("http://"))).toBe(false);
  });

  it("pins the remote image hosts", () => {
    expect(sourcesOf("img-src")).toEqual([
      "'self'",
      "data:",
      "https://avatars.githubusercontent.com",
      "https://github.com",
      "https://www.gravatar.com",
    ]);
  });

  it("keeps media and fonts off the network", () => {
    const media = sourcesOf("media-src");
    expect(hasWildcard(media)).toBe(false);
    expect(media.some((source) => isRemoteSource(source))).toBe(false);
    expect(sourcesOf("font-src")).toEqual(["'self'"]);
  });

  it("relaxes style-src no further than inline attributes", () => {
    const style = sourcesOf("style-src");
    expect(style).toContain("'self'");
    expect(style).not.toContain("'unsafe-eval'");
    expect(hasWildcard(style)).toBe(false);
    expect(style.some((source) => isRemoteSource(source))).toBe(false);
  });

  it("never ships the dev server origins", () => {
    expect(productionCsp).not.toMatch(/wss?:\/\//iu);
    expect(productionCsp).not.toMatch(/:14\d\d/u);
    const devUrl = new URL(config.build?.devUrl ?? "http://localhost:1420");
    expect(productionCsp).not.toContain(devUrl.host);
    // "localhost" в продакшене допустим только как внутренний IPC-хост Tauri.
    for (const [, sources] of production) {
      for (const source of sources) {
        if (source.includes("localhost")) {
          expect(IPC_HOSTS.has(new URL(source).hostname)).toBe(true);
        }
      }
    }
  });
});

describe("dev CSP", () => {
  it("stays a separate value from the production one", () => {
    expect(typeof devCsp).toBe("string");
    expect(devCsp.trim().length).toBeGreaterThan(0);
    expect(devCsp).not.toBe(productionCsp);
  });

  it("keeps its relaxations out of the production policy", () => {
    // Всё, что dev-режиму позволено ослабить, продакшен видеть не должен.
    for (const token of ["'unsafe-eval'", "ws://", "wss://", ":1420", ":1421"]) {
      expect(productionCsp).not.toContain(token);
    }
  });

  it("still blocks plugins and base-tag hijacking while developing", () => {
    const dev = directives(devCsp);
    expect(dev.get("default-src")).toEqual(["'self'"]);
    expect(dev.get("object-src")).toEqual(["'none'"]);
    expect(dev.get("base-uri")).toEqual(["'self'"]);
  });
});

describe("capabilities", () => {
  it("ships exactly one capability file", () => {
    expect(capabilities.map(([name]) => name)).toEqual(["default.json"]);
  });

  it("binds the default capability to the main window only", () => {
    expect(defaultCapability.windows).toEqual(["main"]);
    expect(defaultCapability.identifier).toBe("default");
    // remote/webviews открыли бы IPC внешним origin'ам или чужим webview.
    expect(defaultCapability.remote).toBeUndefined();
    expect(defaultCapability.webviews).toBeUndefined();
  });

  it("targets a window label that the app actually creates", () => {
    const windows = config.app?.windows ?? [];
    const labels = windows.map((window) => window.label ?? "main");
    for (const label of defaultCapability.windows ?? []) {
      expect(labels).toContain(label);
    }
  });

  it("pins the exact permission list", () => {
    expect(defaultCapability.permissions).toEqual([
      "core:default",
      "core:window:allow-start-dragging",
      "core:window:allow-set-background-color",
      "core:window:allow-set-theme",
      "opener:default",
      "dialog:default",
      "notification:default",
      "updater:allow-check",
      "updater:allow-download",
      "updater:allow-install",
      "process:allow-restart",
    ]);
  });

  it("declares every permission as a plain identifier", () => {
    // Объектная форма permission несёт scope (allow/deny) — такой список надо
    // читать глазами, а не пропускать мимо этого теста.
    for (const [name, capability] of capabilities) {
      for (const permission of capability.permissions ?? []) {
        const where = `${name}: ${JSON.stringify(permission)}`;
        expect(typeof permission, where).toBe("string");
      }
    }
  });

  it("grants no permission matching a dangerous pattern", () => {
    const forbidden = [
      /^shell:/u,
      /^fs:/u,
      /^http:/u,
      /^core:webview:allow-create/u,
      /allow-execute$/u,
      /allow-spawn$/u,
      // open_path отдаёт произвольный путь системному обработчику, то есть
      // запускает файл из репозитория, который открыл пользователь.
      /allow-open-path$/u,
      /allow-write-file$/u,
      /allow-read-file$/u,
      /\*/u,
    ];
    for (const [name, capability] of capabilities) {
      for (const permission of capability.permissions ?? []) {
        const identifier =
          typeof permission === "string"
            ? permission
            : String(permission.identifier ?? "");
        for (const pattern of forbidden) {
          expect(pattern.test(identifier), `${name}: ${identifier}`).toBe(false);
        }
      }
    }
  });
});

describe("updater plugin", () => {
  const updater = config.plugins?.updater;

  it("downloads updates only over https from github.com", () => {
    expect(updater?.endpoints?.length).toBeGreaterThan(0);
    for (const endpoint of updater?.endpoints ?? []) {
      const url = new URL(endpoint);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("github.com");
      // Логин в URL увёл бы запрос на другой хост в глазах невнимательного ревью.
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.pathname.startsWith("/xpl0itK3y/modelcrew-desktop/")).toBe(
        true,
      );
    }
  });

  it("pins the minisign public key that verifies every update", () => {
    expect(updater?.pubkey).toBe(
      "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFENUE2NDg4RjA1NjJDMjIKUldRaUxGYndpR1JhcmViU1V5M1hGVVpUelZydGp2R3F5aWV0Qkh0YU8yTEVTVnlRNGxGZjBOU0sK",
    );

    const block = atob(updater?.pubkey ?? "");
    const [comment, encodedKey] = block.trim().split(/\r?\n/u);
    expect(comment).toMatch(
      /^untrusted comment: minisign public key: [0-9A-F]{16}$/u,
    );

    // Тело ключа minisign: 2 байта алгоритма + 8 байт key id + 32 байта Ed25519.
    const key = decodeBase64(encodedKey);
    expect(key).toHaveLength(42);
    expect(String.fromCharCode(key[0], key[1])).toBe("Ed");

    // Key id в комментарии — это те же 8 байт в обратном порядке; расхождение
    // означает битый или подменённый блок ключа.
    const keyId = [...key.slice(2, 10)]
      .reverse()
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    expect(comment.endsWith(keyId)).toBe(true);
  });

  it("builds signed updater artifacts", () => {
    expect(config.bundle?.createUpdaterArtifacts).toBe(true);
  });
});

describe("window and asset origins", () => {
  it("serves the frontend from a local bundle", () => {
    const dist = config.build?.frontendDist ?? "";
    expect(dist.length).toBeGreaterThan(0);
    // Ни схемы, ни protocol-relative: иначе окно грузило бы фронтенд из сети.
    expect(dist).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//iu);
    expect(dist.startsWith("//")).toBe(false);
    expect(dist).toBe("../dist");
  });

  it("never points a production window at a remote origin", () => {
    const windows = config.app?.windows ?? [];
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      const url = window.url;
      if (url !== undefined) {
        expect(String(url)).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//iu);
      }
    }
    // devUrl живёт только в build и обязан оставаться локальным.
    const devUrl = config.build?.devUrl;
    if (devUrl !== undefined) {
      expect(new URL(devUrl).hostname).toBe("localhost");
    }
  });

  it("keeps the dangerous asset escape hatches off", () => {
    const security = config.app?.security ?? {};
    expect(security.dangerousDisableAssetCspModification ?? false).toBe(false);
    expect(security.assetProtocol?.enable ?? false).toBe(false);
    expect(config.app?.withGlobalTauri ?? false).toBe(false);
  });

  it("configures no plugin beyond the updater", () => {
    expect(Object.keys(config.plugins ?? {}).sort()).toEqual(["updater"]);
  });
});
