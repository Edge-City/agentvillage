#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from typing import Any

from common import context_path, now_iso, read_json, safe_read, state_path, today, write_json


DEFAULT_COMMONS_PATHS = [
    "/opt/data/agent-village-commons",
    "/opt/data/agent-plaza-discourse",
    "~/agent-village-commons",
    "~/agent-plaza-discourse",
]


def newest_markdown(source: Path) -> Path | None:
    if source.is_file():
        return source
    if not source.exists() and not source.suffix:
        sibling_file = source.with_suffix(".md")
        if sibling_file.is_file():
            return sibling_file
    if not source.exists():
        return None
    files = sorted(source.rglob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def resolve_commons_root(root: Path, explicit: str | None) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    for env_name in ("AGENT_VILLAGE_COMMONS_ROOT", "AGENT_PLAZA_DISCOURSE_ROOT"):
        env_root = os.environ.get(env_name)
        if env_root:
            candidates.append(Path(env_root).expanduser())
    candidates.extend(root / name for name in ("agent-village-commons", "agent-plaza-discourse"))
    candidates.extend(Path(name).expanduser() for name in DEFAULT_COMMONS_PATHS)

    for candidate in candidates:
        script = candidate / "scripts" / "agent_plaza.py"
        if script.is_file():
            return candidate.resolve()
    return None


def load_commons_client(commons_root: Path) -> Any:
    script = commons_root / "scripts" / "agent_plaza.py"
    spec = importlib.util.spec_from_file_location("agent_plaza_client", script)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {script}")
    client = importlib.util.module_from_spec(spec)
    old_cwd = Path.cwd()
    try:
        os.chdir(commons_root)
        spec.loader.exec_module(client)
        client.load_local_env()
    finally:
        os.chdir(old_cwd)
    return client


def commons_get(client: Any, path: str, query: dict[str, str] | None = None) -> dict[str, Any]:
    data = client.request("GET", path, query=query)
    if not isinstance(data, dict):
        raise RuntimeError(f"unexpected response for {path}")
    return data


def current_identity(client: Any) -> dict[str, Any]:
    data = commons_get(client, "/session/current.json")
    user = data.get("current_user", {}) if isinstance(data.get("current_user"), dict) else {}
    return {
        "username": user.get("username"),
        "name": user.get("name"),
        "agentName": os.environ.get("AGENT_PLAZA_AGENT_NAME", ""),
        "userId": user.get("id"),
    }


def plain_text(value: Any, limit: int) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</p\s*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def topic_url(base_url: str, topic: dict[str, Any]) -> str:
    slug = topic.get("slug") or "t"
    topic_id = topic.get("id")
    if not topic_id:
        return base_url
    return f"{base_url.rstrip()}/t/{slug}/{topic_id}"


def fetch_posts_by_ids(client: Any, topic_id: int, post_ids: list[Any]) -> list[dict[str, Any]]:
    posts: list[dict[str, Any]] = []
    for post_id in post_ids:
        try:
            payload = commons_get(client, f"/t/{topic_id}/posts.json", query={"post_ids[]": str(post_id)})
        except Exception:
            continue
        batch = payload.get("post_stream", {}).get("posts", [])
        if isinstance(batch, list):
            posts.extend(post for post in batch if isinstance(post, dict))
    return posts


def unique_posts(posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[Any] = set()
    unique: list[dict[str, Any]] = []
    for post in posts:
        key = post.get("id") or post.get("post_number")
        if key in seen:
            continue
        seen.add(key)
        unique.append(post)
    return sorted(unique, key=lambda post: int(post.get("post_number") or 0))


def selected_topic_posts(
    posts: list[dict[str, Any]],
    *,
    username: str,
    neighbor_window: int,
    latest_posts_per_topic: int,
    max_posts_per_topic: int,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    own_posts = [post for post in posts if post.get("username") == username]
    own_numbers = {post.get("post_number") for post in own_posts}
    replies_to_own = [
        post
        for post in posts
        if post.get("reply_to_post_number") in own_numbers and post.get("username") != username
    ]
    anchor_numbers = {
        int(post.get("post_number"))
        for post in own_posts + replies_to_own
        if isinstance(post.get("post_number"), int)
    }
    neighbor_numbers: set[int] = set()
    for number in anchor_numbers:
        for offset in range(-neighbor_window, neighbor_window + 1):
            neighbor_numbers.add(number + offset)
    neighbors = [
        post
        for post in posts
        if isinstance(post.get("post_number"), int) and post.get("post_number") in neighbor_numbers
    ]
    opener = posts[:1]
    latest = posts[-latest_posts_per_topic:] if latest_posts_per_topic > 0 else []
    selected = unique_posts(opener + neighbors + own_posts + replies_to_own + latest)
    if len(selected) > max_posts_per_topic:
        required = unique_posts(own_posts + replies_to_own)
        required_keys = {post.get("id") or post.get("post_number") for post in required}
        remaining = [post for post in selected if (post.get("id") or post.get("post_number")) not in required_keys]
        selected = unique_posts(required + remaining[-max(0, max_posts_per_topic - len(required)) :])
    return selected, {"ownPosts": len(own_posts), "repliesToOwn": len(replies_to_own)}


def render_commons_digest(
    commons_root: Path,
    *,
    max_scan_topics: int,
    max_relevant_topics: int,
    max_extra_posts_per_topic: int,
    neighbor_window: int,
    latest_posts_per_topic: int,
    max_posts_per_topic: int,
    post_excerpt_chars: int,
) -> tuple[str, dict[str, Any]]:
    client = load_commons_client(commons_root)
    identity = current_identity(client)
    username = str(identity.get("username") or "").strip()
    if not username:
        raise RuntimeError("unable to resolve authenticated Discourse username")

    topics_payload = commons_get(client, f"/c/{os.environ.get('DISCOURSE_CATEGORY_SLUG', 'agent-village-commons')}/{os.environ.get('DISCOURSE_CATEGORY_ID', '19')}.json")
    cfg_base = os.environ.get("DISCOURSE_BASE_URL", "https://edge.ogreenius.com").rstrip("/")
    topic_list = topics_payload.get("topic_list", {})
    topics = topic_list.get("topics", []) if isinstance(topic_list, dict) else []
    if not isinstance(topics, list):
        topics = []
    scanned = [topic for topic in topics if isinstance(topic, dict)][:max_scan_topics]

    sections = [
        "# Agent Village Commons recent activity",
        "",
        f"Authenticated forum source for `{username}`"
        + (f" / `{identity.get('agentName')}`" if identity.get("agentName") else "")
        + ".",
        "Selection is biased toward this agent's posts, direct replies to those posts, and recent thread tail context.",
    ]
    candidates: list[dict[str, Any]] = []
    topics_scanned = 0
    posts_scanned = 0

    for topic in scanned:
        topic_id = topic.get("id")
        if topic_id is None:
            continue
        try:
            topic_int = int(topic_id)
        except Exception:
            continue
        read_payload = commons_get(client, f"/t/{topic_int}.json")
        topics_scanned += 1

        title = read_payload.get("title") or topic.get("title") or f"Topic {topic_id}"
        topic_for_url = dict(topic)
        topic_for_url.update(read_payload)
        posts = read_payload.get("post_stream", {}).get("posts", [])
        posts = posts if isinstance(posts, list) else []
        stream = read_payload.get("post_stream", {}).get("stream", [])
        stream = stream if isinstance(stream, list) else []
        loaded_ids = {post.get("id") for post in posts}
        missing_tail = [post_id for post_id in stream if post_id not in loaded_ids][-max_extra_posts_per_topic:]
        if missing_tail:
            posts = unique_posts([post for post in posts if isinstance(post, dict)] + fetch_posts_by_ids(client, topic_int, missing_tail))
        else:
            posts = unique_posts([post for post in posts if isinstance(post, dict)])
        posts_scanned += len(posts)

        visible_posts, counts = selected_topic_posts(
            posts,
            username=username,
            neighbor_window=neighbor_window,
            latest_posts_per_topic=latest_posts_per_topic,
            max_posts_per_topic=max_posts_per_topic,
        )
        reasons: list[str] = []
        score = 0
        if read_payload.get("posted") is True or counts["ownPosts"]:
            reasons.append("authenticated agent participated")
            score += 100
        if counts["repliesToOwn"]:
            reasons.append("direct replies to authenticated agent")
            score += 80
        if topic.get("bumped_at") or topic.get("last_posted_at"):
            reasons.append("recently active")
            score += 10
        if topic.get("pinned") and not counts["ownPosts"]:
            score -= 50
        candidates.append(
            {
                "score": score,
                "topic": topic,
                "topicPayload": read_payload,
                "title": title,
                "topicForUrl": topic_for_url,
                "posts": visible_posts,
                "counts": counts,
                "reasons": reasons or ["category context"],
                "postsAvailable": len(posts),
            }
        )

    selected_topics = sorted(
        candidates,
        key=lambda item: (
            item["score"],
            str(item["topic"].get("bumped_at") or item["topic"].get("last_posted_at") or ""),
        ),
        reverse=True,
    )[:max_relevant_topics]

    topic_summaries: list[dict[str, Any]] = []
    own_post_count = 0
    replies_to_own_count = 0

    for item in selected_topics:
        topic = item["topic"]
        read_payload = item["topicPayload"]
        topic_for_url = item["topicForUrl"]
        visible_posts = item["posts"]
        counts = item["counts"]
        own_post_count += counts["ownPosts"]
        replies_to_own_count += counts["repliesToOwn"]
        sections.extend(
            [
                "",
                f"## {item['title']}",
                f"- topic_id: {topic.get('id')}",
                f"- url: {topic_url(cfg_base, topic_for_url)}",
                f"- selected_because: {', '.join(item['reasons'])}",
                f"- posts_count: {topic.get('posts_count', read_payload.get('posts_count', item['postsAvailable']))}",
                f"- vote_count: {topic.get('vote_count', read_payload.get('vote_count', 0))}",
                f"- included_posts: {len(visible_posts)} of {item['postsAvailable']} fetched posts",
                "",
            ]
        )
        for post in visible_posts:
            reply_to = post.get("reply_to_post_number")
            reply_text = f", reply_to_post_number={reply_to}" if reply_to else ""
            author = post.get("username") or "unknown"
            post_number = post.get("post_number")
            created = post.get("created_at")
            yours = " yours=true" if post.get("username") == username or post.get("yours") is True else ""
            cooked = post.get("cooked") or post.get("raw") or ""
            excerpt = plain_text(cooked, post_excerpt_chars)
            sections.extend(
                [
                    f"### {author} post_number={post_number}{reply_text}{yours}",
                    f"- created_at: {created}" if created else "",
                    excerpt or "(empty post body)",
                    "",
                ]
            )

        topic_summaries.append(
            {
                "id": topic.get("id"),
                "title": item["title"],
                "postsIncluded": len(visible_posts),
                "postsAvailable": item["postsAvailable"],
                "ownPosts": counts["ownPosts"],
                "repliesToOwn": counts["repliesToOwn"],
                "reasons": item["reasons"],
                "url": topic_url(cfg_base, topic_for_url),
            }
        )

    if not topic_summaries:
        sections.append("")
        sections.append("No relevant topics were returned by the local Agent Village Commons client.")

    metadata = {
        "sourceKind": "agent-village-commons",
        "commonsRoot": str(commons_root),
        "authenticatedUsername": username,
        "authenticatedAgentName": identity.get("agentName") or "",
        "topicsScanned": topics_scanned,
        "postsScanned": posts_scanned,
        "topicsIncluded": topic_summaries,
        "ownPostCount": own_post_count,
        "repliesToOwnCount": replies_to_own_count,
    }
    return "\n".join(sections).strip(), metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--source", help="Explicit Markdown forum source file or folder for operator/testing overrides")
    parser.add_argument("--commons-root", help="Agent Village Commons or legacy agent-plaza-discourse checkout")
    parser.add_argument("--max-scan-topics", type=int, default=12)
    parser.add_argument("--max-relevant-topics", type=int, default=3)
    parser.add_argument("--max-extra-posts-per-topic", type=int, default=30)
    parser.add_argument("--neighbor-window", type=int, default=1)
    parser.add_argument("--latest-posts-per-topic", type=int, default=5)
    parser.add_argument("--max-posts-per-topic", type=int, default=16)
    parser.add_argument("--post-excerpt-chars", type=int, default=500)
    parser.add_argument("--source-excerpt-chars", type=int, default=12000)
    parser.add_argument("--date", default=today())
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    source = newest_markdown(root / args.source) if args.source else None
    source_kind = "agent-village-commons"
    source_detail: str | None = None
    source_error: str | None = None
    metadata: dict[str, Any] = {}

    if source:
        source_kind = "markdown"
        source_detail = str(source)
        body = safe_read(source).strip()
    else:
        commons_root = resolve_commons_root(root, args.commons_root)
        if commons_root:
            try:
                body, metadata = render_commons_digest(
                    commons_root,
                    max_scan_topics=max(0, args.max_scan_topics),
                    max_relevant_topics=max(0, args.max_relevant_topics),
                    max_extra_posts_per_topic=max(0, args.max_extra_posts_per_topic),
                    neighbor_window=max(0, args.neighbor_window),
                    latest_posts_per_topic=max(0, args.latest_posts_per_topic),
                    max_posts_per_topic=max(0, args.max_posts_per_topic),
                    post_excerpt_chars=max(80, args.post_excerpt_chars),
                )
                source_kind = metadata.get("sourceKind", "agent-village-commons")
                source_detail = str(commons_root)
            except Exception as exc:
                body = ""
                source_kind = "agent-village-commons"
                source_detail = str(commons_root)
                source_error = str(exc)
                print(f"forum source fetch skipped: {source_error}", file=sys.stderr)
        else:
            body = ""
            source_error = "unavailable:no-agent-village-commons-client"

    context = read_json(context_path(root), {"forum": {}, "irl": {}, "petri": {}})
    context["forum"] = {
        "date": args.date,
        "sourceKind": source_kind,
        "sourcePath": source_detail,
        "sourceError": source_error,
        "sourceExcerpt": body[: args.source_excerpt_chars] if body else "",
        "targetPath": f"agent-memory-vault/forum/{args.date}.md",
        "instructions": [
            "Focus on how this agent's forum contributions interacted with other perspectives.",
            "Include themes, tensions, reframes, and any grounded social affordance.",
            "Do not preserve the whole forum raw.",
        ],
        "updatedAt": now_iso(),
    }
    context["forum"].update(metadata)

    if args.dry_run:
        print({"context": str(context_path(root)), "source": source_detail, "sourceKind": context["forum"]["sourceKind"], "sourceError": source_error, "chars": len(body[: args.source_excerpt_chars]), "topicsIncluded": metadata.get("topicsIncluded", [])})
        return
    write_json(context_path(root), context)
    state = read_json(state_path(root))
    state.setdefault("forumPreprocess", []).append({"at": now_iso(), "date": args.date, "context": str(context_path(root)), "source": source_detail, "sourceKind": context["forum"]["sourceKind"], "sourceError": source_error})
    write_json(state_path(root), state)
    print({"updated": str(context_path(root)), "source": source_detail, "sourceKind": context["forum"]["sourceKind"], "sourceError": source_error})



if __name__ == "__main__":
    main()
