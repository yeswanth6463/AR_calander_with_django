"""Compile all of a project's target images into one bundle file."""

import hashlib
import json

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from django.utils import timezone

from .target_compiler import (
    BUNDLE_FORMAT,
    BUNDLE_VERSION,
    COMPILER_VERSION,
    CONFIG,
    RATING_TEXT,
    TargetCompileError,
    bundle_entry,
    compile_target,
    targets_signature,
)


def active_targets(project):
    """Targets in bundle order: the index shown in the sidebar (#0, #1, ...)."""
    return list(
        project.target_images.filter(is_active=True).order_by("created_at", "id")
    )


def _failed(message):
    return {
        "compiler_version": COMPILER_VERSION,
        "status": "failed",
        "feature_count": 0,
        "spread": 0,
        "rating": 0,
        "rating_text": RATING_TEXT[0],
        "error": message,
    }


def compile_project_targets(project):
    """Compile every active target and store the bundle on the project.

    Targets that cannot be tracked are left out of the bundle and marked
    ``failed`` in their ``tracking_data``; the rest get a bundle ``index``.
    """
    targets = active_targets(project)
    compiled_at = timezone.now()
    entries = []
    qualities = []

    for target in targets:
        compiled = None
        try:
            if not target.image:
                raise TargetCompileError("Target image is missing.")
            compiled = compile_target(target.image.path)
            quality = compiled["quality"]
        except (TargetCompileError, OSError, ValueError) as exc:
            quality = _failed(str(exc) or "Unable to compile target.")
        if compiled is not None and quality["status"] == "ready":
            quality["index"] = len(entries)
            entries.append(bundle_entry(target, len(entries), compiled))
        else:
            quality["index"] = None
        quality["compiled_at"] = compiled_at.isoformat()
        qualities.append((target, quality))

    bundle = {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "compiler_version": COMPILER_VERSION,
        "project": str(project.id),
        "config": CONFIG,
        "targets": entries,
    }
    data = json.dumps(bundle, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha1(data).hexdigest()[:16]
    name = f"compiled_targets/{project.id}/targets-{digest}.json"

    # Content-addressed and never overwritten: links published earlier keep
    # pointing at the exact bundle they were published with.
    if not default_storage.exists(name):
        name = default_storage.save(name, ContentFile(data))

    with transaction.atomic():
        for target, quality in qualities:
            target.tracking_data = quality
            target.save(update_fields=["tracking_data", "updated_at"])
        project.compiled_targets.name = name
        project.targets_signature = targets_signature(targets)
        project.targets_compiled_at = compiled_at
        project.save(
            update_fields=[
                "compiled_targets",
                "targets_signature",
                "targets_compiled_at",
                "updated_at",
            ]
        )
    return compile_status(project, targets)


def compile_status(project, targets=None):
    if targets is None:
        targets = active_targets(project)
    has_bundle = bool(project.compiled_targets and project.compiled_targets.name)
    ready = sum(
        1
        for t in targets
        if isinstance(t.tracking_data, dict)
        and t.tracking_data.get("compiler_version") == COMPILER_VERSION
        and t.tracking_data.get("index") is not None
    )
    return {
        "version": COMPILER_VERSION,
        "total": len(targets),
        "compiled": ready,
        "compiled_at": project.targets_compiled_at,
        "url": project.compiled_targets.url if has_bundle else None,
        "stale": bool(targets)
        and (not has_bundle or project.targets_signature != targets_signature(targets)),
    }


def ensure_compiled(project):
    """Compile before publishing when targets changed since the last compile."""
    targets = active_targets(project)
    if targets and compile_status(project, targets)["stale"]:
        return compile_project_targets(project)
    return compile_status(project, targets)


def bundle_payload(request, project):
    """What a published snapshot needs to load the bundle in the viewer."""
    status = compile_status(project)
    if not status["url"] or status["stale"]:
        return None
    return {
        "url": request.build_absolute_uri(status["url"]),
        "version": BUNDLE_VERSION,
        "count": status["compiled"],
    }
