"""Sorts a mixed-use venue's events into live music, not music, and unclear.

Used by venues with `music_only: true` in venues.yaml (bars, breweries and lounges whose
calendars also carry drag shows, screenings, trivia, food trucks and parties). Only events that
clearly say music are kept, so the calendar and the review queue stay free of everything else."""
from __future__ import annotations

import re

from .models import Show

MUSIC = re.compile(
    r"\b(live music|live band|band|bands|concert|jazz|blues|funk|soul|r&b|hip[- ]?hop|rap|reggae|rock|punk|"
    r"metal|folk|bluegrass|country|americana|acoustic|singer|songwriter|open mic|jam|orchestra|symphony|"
    r"quartet|trio|duo|ensemble|choir|dj|djs|techno|tech house|house music|edm|electronic|disco|salsa|cumbia|"
    r"mariachi|samba|bossa|vinyl|live set|performances? by|music)\b", re.I)
NOT_MUSIC = re.compile(
    r"\b(drag|divas|screening|watch party|viewing party|housewives|trivia|bingo|comedy|comedian|stand-?up|"
    r"karaoke|costume contest|match night|speed dating|singles|dating|yoga|paint|sip and|market|brunch|"
    r"game night|board games|book club|fundraiser|networking|private event|closed|cocktail|negroni|"
    r"happy hour|tasting|wine night|food truck|painting|pumpkin|swap|charity|cinema|film|movie|pop-?up|"
    r"run club|runners|pixels|pairing|workshop|book fair|costume party)\b", re.I)

GENRE_WORDS = re.compile(r"\b(jazz|blues|funk|soul|reggae|folk|bluegrass|country|americana|techno|house|"
                         r"salsa|cumbia|samba|bossa nova|hip[- ]?hop|rock|punk|metal|disco)\b", re.I)


def classify(show: Show) -> str:
    """'music', 'not_music' or 'unclear'."""
    title = show.title or ""
    text = f"{title} {show.description or ''}"
    music_title, music_any = MUSIC.search(title), MUSIC.search(text)
    other_title, other_any = NOT_MUSIC.search(title), NOT_MUSIC.search(text)
    if music_title and not other_title:
        return "music"
    if other_title and not music_title:
        return "not_music"
    if music_any and not other_any:
        return "music"
    if other_any and not music_any:
        return "not_music"
    return "unclear"


def title_is_music(title: str) -> bool:
    return bool(MUSIC.search(title or "")) and not NOT_MUSIC.search(title or "")


def add_genre_words(show: Show) -> None:
    """Genres named in the title or blurb ('Jazz Night', 'Techno, Tech House'), when a source gives none."""
    if not show.raw_genres:
        show.raw_genres = sorted({m.lower() for m in GENRE_WORDS.findall(f"{show.title} {show.description or ''}")})


def apply(shows: list[Show]) -> list[Show]:
    kept = []
    for show in shows:
        if classify(show) != "music":
            continue
        add_genre_words(show)
        kept.append(show)
    return kept
