"""Exclude an unused optional feed from ephemeral CI browser dependency installs."""
import pathlib
import re
import sys


def prepare(directory):
    root = pathlib.Path(directory)
    if not root.is_dir():
        return
    for source in root.iterdir():
        if source.is_symlink() or not source.is_file() or source.suffix not in ('.list', '.sources'):
            continue
        declaration = (r'^\s*deb(?:-src)?\s+(?:\[[^\]\n]*\]\s+)?' if source.suffix == '.list'
                       else r'^URIs:[^\n]*')
        if re.search(declaration + r'https?://packages\.microsoft\.com(?:/|\s|$)',
                     source.read_text(), re.MULTILINE | re.IGNORECASE):
            source.rename(source.with_name(source.name + '.disabled'))
            print('Disabled unused CI package source: ' + source.name)


if __name__ == '__main__':
    prepare(sys.argv[1] if len(sys.argv) > 1 else '/etc/apt/sources.list.d')
