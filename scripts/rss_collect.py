import argparse
import calendar
import json
import os
from datetime import datetime, timedelta, timezone

import feedparser


def entry_time(entry):
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if not parsed:
        return None
    return datetime.fromtimestamp(calendar.timegm(parsed), tz=timezone.utc)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--hours", type=int, default=48)
    args = parser.parse_args()

    with open(args.config, "r", encoding="utf-8-sig") as f:
        config = json.load(f)

    now = datetime.now(timezone.utc)
    threshold = now - timedelta(hours=args.hours)
    result = {
        "collected_at_utc": now.isoformat(),
        "window_hours": args.hours,
        "feeds": [],
        "items": [],
    }

    for feed in config.get("rssFeeds", []):
        parsed = feedparser.parse(feed["url"])
        feed_status = {
            "name": feed["name"],
            "category": feed.get("category", ""),
            "url": feed["url"],
            "bozo": bool(parsed.bozo),
            "error": str(getattr(parsed, "bozo_exception", "")) if parsed.bozo else "",
            "entry_count": len(parsed.entries),
        }
        result["feeds"].append(feed_status)
        for entry in parsed.entries[:50]:
            dt = entry_time(entry)
            if dt and dt < threshold:
                continue
            result["items"].append({
                "feed": feed["name"],
                "category": feed.get("category", ""),
                "title": entry.get("title", ""),
                "url": entry.get("link", ""),
                "published_utc": dt.isoformat() if dt else "",
                "summary": (entry.get("summary", "") or "")[:800],
                "time_unconfirmed": dt is None,
            })

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "feeds": len(result["feeds"]),
        "items": len(result["items"]),
        "failed_feeds": [x["name"] for x in result["feeds"] if x["bozo"]],
        "output": args.output,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
