#!/usr/bin/env python3
"""Collect completed US arrivals from OpenSky and update the dashboard JSON.

The script intentionally uses only Python's standard library so it can run in
GitHub Actions without an install step.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AIRPORTS_PATH = ROOT / "data" / "airports.json"
ARRIVALS_PATH = ROOT / "data" / "arrivals.json"
TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/"
    "opensky-network/protocol/openid-connect/token"
)
FLIGHTS_URL = "https://opensky-network.org/api/flights/all"
USER_AGENT = "arrival-pulse-github-pages/1.0"
HISTORY_DAYS = 45


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def request_json(url: str, *, data: bytes | None = None, headers: dict | None = None):
    request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, data=data, headers=request_headers)
    with urllib.request.urlopen(request, timeout=45) as response:
        body = response.read()
    return json.loads(body.decode("utf-8")) if body else None


def get_access_token() -> str | None:
    client_id = os.environ.get("OPENSKY_CLIENT_ID", "").strip()
    client_secret = os.environ.get("OPENSKY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        print("OpenSky credentials are not set; attempting the anonymous quota.")
        return None

    payload = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        }
    ).encode("ascii")
    token_data = request_json(
        TOKEN_URL,
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    return token_data["access_token"]


def fetch_flights(begin: datetime, end: datetime, token: str | None):
    query = urllib.parse.urlencode(
        {
            "begin": int(begin.timestamp()),
            "end": int(end.timestamp()),
        }
    )
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return request_json(f"{FLIGHTS_URL}?{query}", headers=headers) or []


def hour_start(timestamp: int) -> datetime:
    result = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    return result.replace(minute=0, second=0, microsecond=0)


def build_buckets(
    flights: list[dict],
    airport_icaos: set[str],
    begin: datetime,
    end: datetime,
):
    counts_by_hour: dict[datetime, Counter] = defaultdict(Counter)
    unknown_by_hour: Counter = Counter()
    raw_by_hour: Counter = Counter()
    seen_flights: set[tuple] = set()

    for flight in flights:
        fingerprint = (
            flight.get("icao24"),
            flight.get("firstSeen"),
            flight.get("lastSeen"),
            flight.get("estArrivalAirport"),
        )
        if fingerprint in seen_flights:
            continue
        seen_flights.add(fingerprint)

        arrival = flight.get("estArrivalAirport")
        last_seen = flight.get("lastSeen")
        if not arrival or not isinstance(last_seen, int):
            continue
        if last_seen < int(begin.timestamp()) or last_seen >= int(end.timestamp()):
            continue

        bucket_hour = hour_start(last_seen)
        raw_by_hour[bucket_hour] += 1
        if arrival in airport_icaos:
            counts_by_hour[bucket_hour][arrival] += 1
        elif arrival.startswith("K"):
            unknown_by_hour[bucket_hour] += 1

    buckets = []
    for bucket_hour in sorted(set(raw_by_hour) | set(counts_by_hour)):
        airport_counts = counts_by_hour[bucket_hour]
        buckets.append(
            {
                "start": bucket_hour.isoformat().replace("+00:00", "Z"),
                "end": (bucket_hour + timedelta(hours=1))
                .isoformat()
                .replace("+00:00", "Z"),
                "total": sum(airport_counts.values()),
                "unknownCount": unknown_by_hour[bucket_hour],
                "rawCompletedFlights": raw_by_hour[bucket_hour],
                "arrivals": [
                    {"airport": airport, "count": count}
                    for airport, count in airport_counts.most_common()
                ],
            }
        )
    return buckets


def merge_buckets(existing: list[dict], incoming: list[dict], cutoff: datetime):
    merged = {
        bucket["start"]: bucket
        for bucket in existing
        if datetime.fromisoformat(bucket["start"].replace("Z", "+00:00")) >= cutoff
    }
    merged.update({bucket["start"]: bucket for bucket in incoming})
    return [merged[key] for key in sorted(merged)]


def main() -> int:
    airports = load_json(AIRPORTS_PATH)
    dashboard_data = load_json(ARRIVALS_PATH)
    airport_icaos = {airport["icao"] for airport in airports}

    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    begin = end - timedelta(hours=2)

    try:
        token = get_access_token()
        flights = fetch_flights(begin, end, token)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            print("OpenSky returned no completed flights for this interval; data is unchanged.")
            return 0
        print(f"OpenSky request failed with HTTP {error.code}; data is unchanged.", file=sys.stderr)
        return 0
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as error:
        print(f"OpenSky request failed ({error}); data is unchanged.", file=sys.stderr)
        return 0

    incoming = build_buckets(flights, airport_icaos, begin, end)
    if not incoming:
        print("No monitored US arrivals were found; data is unchanged.")
        return 0

    cutoff = end - timedelta(days=HISTORY_DAYS)
    dashboard_data["buckets"] = merge_buckets(
        dashboard_data.get("buckets", []),
        incoming,
        cutoff,
    )
    dashboard_data["meta"] = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "observed",
        "provider": "OpenSky Network",
        "coverage": f"{len(airports)} major US airports",
        "windowStart": begin.isoformat().replace("+00:00", "Z"),
        "windowEnd": end.isoformat().replace("+00:00", "Z"),
        "retentionDays": HISTORY_DAYS,
        "authenticated": bool(token),
        "note": (
            "Counts are completed flights whose estimated arrival airport is in "
            "the monitored airport list. Longer history may use the sample baseline."
        ),
    }

    with ARRIVALS_PATH.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(dashboard_data, handle, indent=2)
        handle.write("\n")

    monitored = sum(bucket["total"] for bucket in incoming)
    print(
        f"Updated {len(incoming)} hourly buckets with {monitored} monitored arrivals "
        f"from {len(flights)} completed flight records."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
