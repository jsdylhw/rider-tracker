"""FIT 文件路径解析工具."""

from __future__ import annotations

from pathlib import Path


def resolve_fit_path(value: str | Path) -> Path:
    """把 latest、目录或具体路径解析为一个本地 FIT 文件."""
    text = str(value)
    if text == "latest":
        fit_files = sorted(
            iter_candidate_fit_files(),
            key=lambda path: path.stat().st_mtime,
        )
        if not fit_files:
            raise FileNotFoundError("No FIT file found. Pass a FIT path explicitly.")
        return fit_files[-1].resolve()

    path = Path(value).expanduser()
    if path.is_dir():
        fit_files = sorted(path.glob("*.fit"), key=lambda item: item.stat().st_mtime)
        if not fit_files:
            raise FileNotFoundError(f"No *.fit found in {path}")
        return fit_files[-1].resolve()
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix.lower() != ".fit":
        raise ValueError(f"Expected a .fit file: {path}")
    return path.resolve()


def iter_candidate_fit_files() -> list[Path]:
    """返回常用本地目录下可被自然语言匹配的 FIT 候选文件."""
    roots = [
        Path("data") / "fit",
        Path("garmin_cn_fit_files"),
        Path.cwd(),
    ]
    files: list[Path] = []
    for root in roots:
        if root.exists():
            files.extend(path for path in root.glob("*.fit") if path.is_file())
    return files
