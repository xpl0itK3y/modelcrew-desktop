// Человека в git опознаёт почта, а не имя. Имя — это поле, которое в каждый
// коммит вписывает то, что его создало, и один человек запросто подписан
// по-разному: локальные коммиты идут под `user.name` из конфига, а merge,
// сделанный кнопкой на GitHub, — под именем из профиля. В одной истории это
// выглядит как два разных человека, идущих строго по очереди, хотя почта у
// них одна и та же:
//
//   Merge pull request #17 …   Vladimir        <chiglinzev.vladimir@icloud.com>
//   Stage 17: …                Modern-Messiah  <chiglinzev.vladimir@icloud.com>
//
// GitHub этого не показывает, потому что сводит коммиты к аккаунту по почте.
// Здесь то же самое, но своими силами: одна почта — одно имя во всей истории.
//
// Какое из имён взять, решает не большинство: соотношение merge-коммитов к
// обычным зависит от того, сколько истории загружено, и имя тогда менялось бы
// при прокрутке. Решает происхождение. Имя из merge-коммита вписал не человек,
// а тот, кто слил ветку за него, поэтому предпочитаем то, которым он
// подписывает обычные коммиты, — и оно же совпадает с тем, что показывает
// GitHub. Если почта встречается только в merge-коммитах, брать больше нечего.

type AuthorSource = {
  author: string;
  authorEmail: string;
  // Полные хеши родителей: два и больше — слияние.
  parents: string[];
};

export function authorIdentityKey(email: string): string {
  return email.trim().toLowerCase();
}

type Tally = {
  // Имя → сколько раз встретилось и на каком месте сверху впервые. История
  // приходит от свежих к старым, поэтому меньший индекс — более свежее имя.
  ownCommits: Map<string, { count: number; first: number }>;
  merges: Map<string, { count: number; first: number }>;
};

function note(
  into: Map<string, { count: number; first: number }>,
  name: string,
  index: number,
): void {
  const seen = into.get(name);
  if (seen) {
    seen.count += 1;
  } else {
    into.set(name, { count: 1, first: index });
  }
}

// Самое частое имя; при равенстве — то, что встретилось выше по истории.
function pick(
  names: Map<string, { count: number; first: number }>,
): string | undefined {
  let best: [string, { count: number; first: number }] | undefined;
  for (const entry of names) {
    if (
      !best ||
      entry[1].count > best[1].count ||
      (entry[1].count === best[1].count && entry[1].first < best[1].first)
    ) {
      best = entry;
    }
  }
  return best?.[0];
}

/**
 * Карта «почта → имя, под которым показывать её коммиты».
 *
 * В карту попадают только почты, у которых имён больше одного: для остальных
 * подменять нечего, и лишние записи только мешали бы читать.
 */
export function canonicalAuthorNames(
  commits: readonly AuthorSource[],
): Map<string, string> {
  const tallies = new Map<string, Tally>();
  commits.forEach((commit, index) => {
    const key = authorIdentityKey(commit.authorEmail);
    const name = commit.author.trim();
    if (!key || !name) {
      return;
    }
    let tally = tallies.get(key);
    if (!tally) {
      tally = { ownCommits: new Map(), merges: new Map() };
      tallies.set(key, tally);
    }
    note(commit.parents.length > 1 ? tally.merges : tally.ownCommits, name, index);
  });

  const canonical = new Map<string, string>();
  for (const [key, tally] of tallies) {
    const names = new Set([...tally.ownCommits.keys(), ...tally.merges.keys()]);
    if (names.size < 2) {
      continue;
    }
    const chosen = pick(tally.ownCommits) ?? pick(tally.merges);
    if (chosen) {
      canonical.set(key, chosen);
    }
  }
  return canonical;
}

/**
 * Проставляет каждому коммиту имя, под которым его показывать. Исходное имя
 * остаётся на месте: оно настоящее, и подписи в git мы не переписываем — это
 * решение о показе, а не о данных.
 */
export function withCanonicalAuthors<
  T extends AuthorSource & { displayAuthor?: string },
>(commits: T[]): T[] {
  const canonical = canonicalAuthorNames(commits);
  if (canonical.size === 0) {
    return commits.map((commit) => ({
      ...commit,
      displayAuthor: commit.author,
    }));
  }
  return commits.map((commit) => ({
    ...commit,
    displayAuthor:
      canonical.get(authorIdentityKey(commit.authorEmail)) ?? commit.author,
  }));
}
