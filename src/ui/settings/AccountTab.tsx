import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { githubCurrentUser, type GithubUser } from "../../github/auth";
import {
  requestGithubAuth,
  subscribeGithubAuth,
} from "../../github/authState";
import {
  loadNetworkAvatars,
  saveNetworkAvatars,
} from "../../terminal/preferences";
import {
  SettingRow,
  SettingsButton,
  SettingsPage,
  SettingsSegmented,
} from "./SettingsControls";

type AvatarSource = "network" | "initials";

export function AccountTab() {
  const { t } = useI18n();
  const [user, setUser] = useState<GithubUser | null>(null);
  const [networkAvatars, setNetworkAvatars] = useState(() =>
    loadNetworkAvatars(),
  );

  // Вход и выход выполняет GithubAuth в титлбаре, а сюда о результате приходит
  // общее событие — перечитываем пользователя по нему.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void githubCurrentUser().then((current) => {
        if (!cancelled) {
          setUser(current);
        }
      });
    };
    refresh();
    const unsubscribe = subscribeGithubAuth(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Настройку могли переключить извне (автовключение при входе) — подхватываем.
  useEffect(() => {
    const onChange = () => setNetworkAvatars(loadNetworkAvatars());
    window.addEventListener("modelcrew:network-avatars", onChange);
    return () =>
      window.removeEventListener("modelcrew:network-avatars", onChange);
  }, []);

  const signedIn = user !== null;
  // Что реально показывается: «Из сети» действует лишь когда пользователь вошёл.
  const networkActive = signedIn && networkAvatars;

  return (
    <SettingsPage
      section="account"
      title={t("settings.tabAccount")}
      intro={t("settings.accountIntro")}
    >
      <SettingRow
        title={t("settings.accountGithub")}
        description={
          user ? `@${user.login}` : t("settings.accountSignedOutNote")
        }
        media={
          user ? (
            <img
              className="settings-account-avatar"
              src={user.avatarUrl}
              alt=""
              onError={(event) => {
                event.currentTarget.style.visibility = "hidden";
              }}
            />
          ) : undefined
        }
        control={
          <SettingsButton
            label={t(user ? "github.logout" : "github.login")}
            onClick={() => requestGithubAuth(user ? "logout" : "login")}
          />
        }
      />

      <SettingRow
        title={t("settings.networkAvatars")}
        description={
          signedIn
            ? t("settings.networkAvatarsNote")
            : t("settings.networkAvatarsSignIn")
        }
        control={
          <SettingsSegmented<AvatarSource>
            label={t("settings.networkAvatars")}
            value={networkActive ? "network" : "initials"}
            options={[
              {
                value: "network",
                label: t("settings.networkAvatarsOn"),
                // «Из сети» доступна только вошедшим; без входа — «Инициалы».
                disabled: !signedIn,
                title: signedIn
                  ? undefined
                  : t("settings.networkAvatarsSignIn"),
              },
              { value: "initials", label: t("settings.networkAvatarsOff") },
            ]}
            onChange={(value) => {
              const enabled = value === "network";
              setNetworkAvatars(enabled);
              saveNetworkAvatars(enabled);
            }}
          />
        }
      />
    </SettingsPage>
  );
}
