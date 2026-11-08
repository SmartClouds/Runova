#!/usr/bin/env python3
"""Turns the web fonts the desktop uses into the TTF files the phones need.

Run once when a font or the icon list changes, with fonttools and brotli installed:

    python build-fonts.py <folder with the unpacked npm packages>

The results are committed, so building the apps needs none of this.
"""
import json
import pathlib
import shutil
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

here = pathlib.Path(__file__).resolve().parent
source = pathlib.Path(sys.argv[1])
fonts = here / "fonts"
fonts.mkdir(exist_ok=True)


def find(pattern):
    return next(source.rglob(pattern))


def convert(woff2, target, ligatures=True):
    font = TTFont(woff2)
    font.flavor = None
    if not ligatures:
        # A terminal draws every character in its own cell, as the desktop's does.
        del font["GSUB"]
    font.save(fonts / target)


convert(find("inter-latin-wght-normal.woff2"), "Inter.ttf")
convert(find("jetbrains-mono-latin-wght-normal.woff2"), "JetBrainsMono.ttf", ligatures=False)

icons = json.loads((here / "icons.json").read_text())
options = subset.Options()
options.layout_features = []
options.notdef_outline = True
font = TTFont(find("fa-solid-900.woff2"))
subsetter = subset.Subsetter(options)
subsetter.populate(unicodes=[int(code, 16) for code in icons.values()])
subsetter.subset(font)
font.flavor = None
font.save(fonts / "FontAwesomeSolid.ttf")

licenses = fonts / "licenses"
licenses.mkdir(exist_ok=True)
shutil.copy(find("inter-latin-wght-normal.woff2").parents[1] / "LICENSE", licenses / "Inter.txt")
shutil.copy(
    find("jetbrains-mono-latin-wght-normal.woff2").parents[1] / "LICENSE",
    licenses / "JetBrainsMono.txt",
)
shutil.copy(find("fa-solid-900.woff2").parents[1] / "LICENSE.txt", licenses / "FontAwesome.txt")
