// Аватар автора коммита: из сети (GitHub/Gravatar) или офлайн-инициалы.
// Показывается и в строке графа, и в раскрытой карточке, и в шапке сравнения.

import { useEffect, useState } from "react";
import { authorAvatar, resolveAvatarUrl } from "../../../git/gitChanges";
import {
  githubAvatarForEmail,
  subscribeGithubAvatars,
} from "../../../git/githubAvatars";
import { isGithubSignedIn, subscribeGithubAuth } from "../../../github/authState";
import { loadNetworkAvatars } from "../../../terminal/preferences";

export function AuthorAvatar(props: { name: string; email?: string }) {
  const { initials, hue } = authorAvatar(props.name);
  const [enabled, setEnabled] = useState(() => loadNetworkAvatars());
  const [signedIn, setSignedIn] = useState(() => isGithubSignedIn());
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Сетевые аватарки доступны только после входа через GitHub.
  const networkOn = enabled && signedIn;

  useEffect(() => {
    const onChange = () => setEnabled(loadNetworkAvatars());
    window.addEventListener("modelcrew:network-avatars", onChange);
    return () =>
      window.removeEventListener("modelcrew:network-avatars", onChange);
  }, []);

  useEffect(
    () => subscribeGithubAuth(() => setSignedIn(isGithubSignedIn())),
    [],
  );

  useEffect(() => {
    if (!networkOn || !props.email) {
      setUrl(null);
      return;
    }
    const email = props.email;
    let cancelled = false;
    // Приоритет: реальный GitHub-аватар из карты коммиттеров, иначе Gravatar
    // по почте. Перечитываем и когда карта догрузилась (событие).
    const resolve = () => {
      const github = githubAvatarForEmail(email);
      if (github) {
        if (!cancelled) {
          setFailed(false);
          setUrl(github);
        }
        return;
      }
      setFailed(false);
      resolveAvatarUrl(email)
        .then((resolved) => {
          if (!cancelled) {
            setUrl(resolved);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setUrl(null);
          }
        });
    };
    resolve();
    const unsubscribe = subscribeGithubAvatars(resolve);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [networkOn, props.email]);

  const showImage = networkOn && url !== null && !failed;
  return (
    <span
      className="git-avatar"
      style={{
        background: showImage ? "transparent" : `hsl(${hue} 50% 42%)`,
      }}
      title={props.name}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          className="git-avatar-img"
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        initials
      )}
    </span>
  );
}

// Иконка-статус в списке: одна буква как в git status.

// соседние карточки съезжают, а не скачут.
