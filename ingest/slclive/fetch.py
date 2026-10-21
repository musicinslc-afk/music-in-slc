"""Polite HTTP: identifies itself, obeys robots.txt, and spaces out requests per host."""
from __future__ import annotations

import socket
import ssl
import tempfile
import time
import urllib.robotparser
from typing import Optional
from urllib.parse import urlparse

import certifi
import requests

from . import settings

_session = requests.Session()
_session.headers.update({"User-Agent": settings.USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})
_robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
_last_hit: dict[str, float] = {}
MIN_GAP_SECONDS = 2.0


class RobotsDisallowed(Exception):
    pass


# Some sites (krcl.org, for one) send their certificate without the intermediate that links it to
# a trusted root. Browsers quietly download the missing piece from the address the certificate
# names; Python doesn't, so we do the same: fetch the intermediate, add it to the usual trusted
# bundle, and verify normally. Nothing is trusted that doesn't chain to a real root.
_verify: dict[str, str] = {}


def _complete_chain(host: str) -> Optional[str]:
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives.serialization import Encoding, pkcs7
        from cryptography.x509.oid import AuthorityInformationAccessOID
        name, _, port = host.partition(":")
        leaf = x509.load_pem_x509_certificate(
            ssl.get_server_certificate((name, int(port or 443)), timeout=15).encode())
        aia = leaf.extensions.get_extension_for_class(x509.AuthorityInformationAccess).value
        pems = []
        for d in aia:
            if d.access_method != AuthorityInformationAccessOID.CA_ISSUERS:
                continue
            data = requests.get(d.access_location.value, timeout=15).content
            if b"-----BEGIN CERTIFICATE-----" in data:
                certs = x509.load_pem_x509_certificates(data)
            else:
                try:
                    certs = [x509.load_der_x509_certificate(data)]
                except ValueError:
                    certs = pkcs7.load_der_pkcs7_certificates(data)
            pems += [c.public_bytes(Encoding.PEM).decode() for c in certs]
        if not pems:
            return None
        bundle = tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False)
        with open(certifi.where()) as f:
            bundle.write(f.read())
        bundle.write("\n" + "".join(pems))
        bundle.close()
        return bundle.name
    except (OSError, ValueError, socket.timeout, requests.RequestException, ImportError):
        return None


def _get(url: str, **kw) -> requests.Response:
    host = urlparse(url).netloc
    if host in _verify:
        return _session.get(url, verify=_verify[host], **kw)
    try:
        return _session.get(url, **kw)
    except requests.exceptions.SSLError:
        path = _complete_chain(host)
        if not path:
            raise
        _verify[host] = path
        return _session.get(url, verify=path, **kw)


def _allowed(url: str) -> bool:
    parts = urlparse(url)
    host = f"{parts.scheme}://{parts.netloc}"
    if host not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            r = _get(host + "/robots.txt", timeout=15)
            if r.status_code >= 400:
                _robots[host] = None  # no robots.txt: allowed
            else:
                rp.parse(r.text.splitlines())
                _robots[host] = rp
        except requests.RequestException:
            _robots[host] = None
    rp = _robots[host]
    return True if rp is None else rp.can_fetch(settings.USER_AGENT, url)


def get(url: str, *, params: dict | None = None, check_robots: bool = True, timeout: int = 30) -> requests.Response:
    if check_robots and not _allowed(url):
        raise RobotsDisallowed(f"robots.txt disallows {url}")
    host = urlparse(url).netloc
    wait = MIN_GAP_SECONDS - (time.monotonic() - _last_hit.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    for attempt in range(3):
        try:
            r = _get(url, params=params, timeout=timeout)
            _last_hit[host] = time.monotonic()
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            return r
        except requests.ConnectionError:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
    r.raise_for_status()
    return r
