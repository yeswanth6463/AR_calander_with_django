"""Validation for Project.game_logic (AR Game rule builder + script).

Shape:
    {
      "variables": [{"name": "lives", "initial": 3}],
      "rules": [{
        "event": {"type": "tap", "item": "<item id>"},
        "conditions": [{"type": "var", "var": "lives", "op": ">", "value": 0}],
        "actions": [{"action": "change_var", "var": "lives", "value": -1}]
      }],
      "script_enabled": false,
      "script": "on('tap', (name) => { ... })"
    }

Keep the whitelists in sync with ar-studio-frontend/src/ar/gameEngine.js.
"""

import re

from rest_framework import serializers

MAX_VARIABLES = 20
MAX_RULES = 50
MAX_CONDITIONS = 10
MAX_ACTIONS = 20
MAX_SCRIPT_CHARS = 20_000
MAX_NUMBER = 1_000_000

VAR_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,31}$")

# event type -> required params
EVENTS = {
    "game_start": (),
    "tap": ("item?",),
    "target_found": (),
    "target_lost": (),
    "every": ("seconds",),
    "after": ("seconds",),
    "score_at_least": ("value",),
    "var_at_least": ("var", "value"),
}

CONDITIONS = {
    "score": ("op", "value"),
    "var": ("var", "op", "value"),
    "visible": ("item", "bool"),
}
OPS = {"<", "<=", "==", "!=", ">=", ">"}

ACTIONS = {
    "show_item": ("item",),
    "hide_item": ("item",),
    "toggle_item": ("item",),
    "toggle_animation": ("item",),
    "play_animation": ("item",),
    "spin_item": ("item", "value"),
    "move_item": ("item", "x", "y", "z"),
    "add_score": ("value",),
    "set_score": ("value",),
    "set_var": ("var", "value"),
    "change_var": ("var", "value"),
    "play_sound": ("sound",),
    "play_asset_sound": ("asset",),
    "show_message": ("text",),
    "win": ("text?",),
    "lose": ("text?",),
}
SOUNDS = {"pop", "chime", "success", "fail"}


def _fail(message):
    raise serializers.ValidationError({"game_logic": message})


def _number(raw, where, lo=-MAX_NUMBER, hi=MAX_NUMBER):
    try:
        value = float(raw)
    except (TypeError, ValueError):
        _fail(f"{where}: needs a number.")
    if value != value or not lo <= value <= hi:  # NaN / range
        _fail(f"{where}: number must be between {lo:g} and {hi:g}.")
    return value


def _ref(raw, where):
    text = str(raw or "").strip()
    if not text or len(text) > 64:
        _fail(f"{where}: pick an item.")
    return text


def _clean_params(spec, raw, where, var_names):
    out = {}
    for param in spec:
        optional = param.endswith("?")
        name = param.rstrip("?")
        value = raw.get(name)
        if optional and value in (None, ""):
            continue
        if name in ("item", "asset"):
            out[name] = _ref(value, where)
        elif name == "var":
            if value not in var_names:
                _fail(f"{where}: unknown variable “{value}”.")
            out[name] = value
        elif name == "op":
            if value not in OPS:
                _fail(f"{where}: unknown comparison.")
            out[name] = value
        elif name == "seconds":
            out[name] = _number(value, where, 0.1, 3600)
        elif name in ("value", "x", "y", "z"):
            out[name] = _number(value, where)
        elif name == "bool":
            out[name] = bool(value)
        elif name == "sound":
            if value not in SOUNDS:
                _fail(f"{where}: unknown sound.")
            out[name] = value
        elif name == "text":
            text = str(value or "").strip()[:200]
            if not text and not optional:
                _fail(f"{where}: needs text.")
            out[name] = text
    return out


def clean_game_logic(value):
    if value in (None, "", {}):
        return None
    if not isinstance(value, dict):
        _fail("Must be an object.")

    variables = value.get("variables") or []
    rules = value.get("rules") or []
    if not isinstance(variables, list) or len(variables) > MAX_VARIABLES:
        _fail(f"At most {MAX_VARIABLES} variables.")
    if not isinstance(rules, list) or len(rules) > MAX_RULES:
        _fail(f"At most {MAX_RULES} rules.")

    clean_vars = []
    var_names = set()
    for index, var in enumerate(variables):
        name = (var or {}).get("name") if isinstance(var, dict) else None
        if not isinstance(name, str) or not VAR_NAME.match(name):
            _fail(f"Variable #{index + 1}: use letters, numbers and _ (max 32).")
        if name in var_names:
            _fail(f"Variable “{name}” is defined twice.")
        var_names.add(name)
        clean_vars.append({"name": name, "initial": _number(var.get("initial", 0), f"Variable “{name}”")})

    clean_rules = []
    for index, rule in enumerate(rules):
        where = f"Rule #{index + 1}"
        if not isinstance(rule, dict):
            _fail(f"{where}: invalid.")
        event = rule.get("event") or {}
        if not isinstance(event, dict) or event.get("type") not in EVENTS:
            _fail(f"{where}: pick a trigger.")
        clean_event = {"type": event["type"], **_clean_params(EVENTS[event["type"]], event, where, var_names)}

        conditions = rule.get("conditions") or []
        actions = rule.get("actions") or []
        if not isinstance(conditions, list) or len(conditions) > MAX_CONDITIONS:
            _fail(f"{where}: at most {MAX_CONDITIONS} conditions.")
        if not isinstance(actions, list) or not actions or len(actions) > MAX_ACTIONS:
            _fail(f"{where}: add 1–{MAX_ACTIONS} actions.")

        clean_conditions = []
        for c_index, cond in enumerate(conditions):
            c_where = f"{where}, condition #{c_index + 1}"
            if not isinstance(cond, dict) or cond.get("type") not in CONDITIONS:
                _fail(f"{c_where}: invalid.")
            clean_conditions.append(
                {"type": cond["type"], **_clean_params(CONDITIONS[cond["type"]], cond, c_where, var_names)}
            )

        clean_actions = []
        for a_index, action in enumerate(actions):
            a_where = f"{where}, action #{a_index + 1}"
            if not isinstance(action, dict) or action.get("action") not in ACTIONS:
                _fail(f"{a_where}: pick an action.")
            clean_actions.append(
                {"action": action["action"], **_clean_params(ACTIONS[action["action"]], action, a_where, var_names)}
            )

        clean_rules.append({
            "event": clean_event,
            "conditions": clean_conditions,
            "actions": clean_actions,
        })

    script = value.get("script") or ""
    if not isinstance(script, str):
        _fail("Script must be text.")
    if len(script) > MAX_SCRIPT_CHARS:
        _fail(f"Script is too long (max {MAX_SCRIPT_CHARS} characters).")

    return {
        "variables": clean_vars,
        "rules": clean_rules,
        "script_enabled": bool(value.get("script_enabled")) and bool(script.strip()),
        "script": script,
    }
