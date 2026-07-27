use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitIdentitySource {
    Repository,
    Global,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredGitIdentity {
    pub name: String,
    pub email: String,
    pub source: GitIdentitySource,
}

impl ConfiguredGitIdentity {
    pub fn identity(&self) -> GitIdentity {
        GitIdentity {
            name: self.name.clone(),
            email: self.email.clone(),
        }
    }
}

fn valid_identity(name: Option<String>, email: Option<String>) -> Option<GitIdentity> {
    let name = name?.trim().to_owned();
    let email = email?.trim().to_owned();
    let safe = |value: &str, limit: usize| {
        !value.is_empty()
            && value.len() <= limit
            && !value.chars().any(|character| character.is_control())
    };
    (safe(&name, 256) && safe(&email, 320) && email.contains('@'))
        .then_some(GitIdentity { name, email })
}

pub(crate) fn configured_git_identity_from(
    mut read: impl FnMut(GitIdentitySource, &str) -> Option<String>,
) -> Option<ConfiguredGitIdentity> {
    for source in [GitIdentitySource::Repository, GitIdentitySource::Global] {
        if let Some(identity) =
            valid_identity(read(source, "user.name"), read(source, "user.email"))
        {
            return Some(ConfiguredGitIdentity {
                name: identity.name,
                email: identity.email,
                source,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn repository_identity_wins_over_global_identity() {
        let values = HashMap::from([
            (
                (GitIdentitySource::Repository, "user.name"),
                "Repository User",
            ),
            (
                (GitIdentitySource::Repository, "user.email"),
                "repo@example.com",
            ),
            ((GitIdentitySource::Global, "user.name"), "Global User"),
            (
                (GitIdentitySource::Global, "user.email"),
                "global@example.com",
            ),
        ]);
        let resolved = configured_git_identity_from(|source, key| {
            values.get(&(source, key)).map(|value| (*value).to_owned())
        })
        .unwrap();

        assert_eq!(resolved.name, "Repository User");
        assert_eq!(resolved.email, "repo@example.com");
        assert_eq!(resolved.source, GitIdentitySource::Repository);
    }

    #[test]
    fn global_identity_is_used_only_when_repository_identity_is_incomplete() {
        let resolved = configured_git_identity_from(|source, key| match (source, key) {
            (GitIdentitySource::Repository, "user.name") => Some("Only a name".to_owned()),
            (GitIdentitySource::Global, "user.name") => Some("Global User".to_owned()),
            (GitIdentitySource::Global, "user.email") => Some("global@example.com".to_owned()),
            _ => None,
        })
        .unwrap();

        assert_eq!(resolved.source, GitIdentitySource::Global);
        assert_eq!(resolved.email, "global@example.com");
    }

    #[test]
    fn invalid_or_partial_identity_is_rejected() {
        assert!(valid_identity(Some("Name".to_owned()), None).is_none());
        assert!(
            valid_identity(Some("Name\nInjected".to_owned()), Some("a@b".to_owned())).is_none()
        );
        assert!(valid_identity(Some("Name".to_owned()), Some("not-an-email".to_owned())).is_none());
    }
}
