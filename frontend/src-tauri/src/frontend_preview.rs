use std::{
    borrow::Cow,
    fs, io,
    path::{Component, Path, PathBuf},
};

use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    Assets, Runtime,
};

/// A preview pins an entire frontend version for the lifetime of the application.
pub(crate) struct PreviewAssets(PathBuf);

impl PreviewAssets {
    pub(crate) fn open(root: &Path) -> io::Result<Self> {
        let version = fs::read_to_string(root.join("active-version"))?;
        let version = version.trim();
        if version.is_empty()
            || !version.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid frontend preview version"));
        }

        let versions = root.join("versions").canonicalize()?;
        let selected = versions.join(version).canonicalize()?;
        if selected.parent() != Some(versions.as_path()) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "preview version is outside the versions directory"));
        }

        let assets = Self(selected);
        if assets.read("index.html").is_none() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "frontend preview is missing index.html"));
        }
        Ok(assets)
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        let relative = Path::new(path.strip_prefix('/').unwrap_or(path));
        if !relative.components().all(|part| matches!(part, Component::Normal(_))) {
            return None;
        }
        let file = self.0.join(relative).canonicalize().ok()?;
        if !file.starts_with(&self.0) || !file.is_file() {
            return None;
        }
        fs::read(file).ok()
    }

    fn keys(&self, directory: &Path, keys: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(directory) else { return };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                self.keys(&path, keys);
            } else if kind.is_file() {
                if let Ok(relative) = path.strip_prefix(&self.0) {
                    keys.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
}

impl<R: Runtime> Assets<R> for PreviewAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.read(key.as_ref()).map(Cow::Owned)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        let mut keys = Vec::new();
        self.keys(&self.0, &mut keys);
        Box::new(keys.into_iter().filter_map(|key| {
            let bytes = self.read(&key)?;
            Some((Cow::Owned(format!("/{key}")), Cow::Owned(bytes)))
        }))
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        // The desktop application currently has no Tauri-generated CSP.
        Box::new(std::iter::empty())
    }
}
