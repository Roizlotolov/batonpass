#!/usr/bin/env python3
"""Test-only harness: loads the batonpass Hermes plugin's register(ctx) with a
fake ctx that records registered hooks/commands, then invokes exactly one of
them with JSON kwargs piped on stdin. Mirrors the real PluginManager's shape
(register_hook(name, cb), register_command(name, cb, description=...)) closely
enough to exercise the plugin as a real child process, without depending on a
real Hermes install being present.
"""
import importlib.util
import json
import sys


class FakeCtx:
    def __init__(self):
        self.hooks = {}
        self.commands = {}

    def register_hook(self, name, cb):
        self.hooks[name] = cb

    def register_command(self, name, cb, description=""):
        self.commands[name] = cb


def main():
    plugin_path, action = sys.argv[1], sys.argv[2]
    spec = importlib.util.spec_from_file_location("batonpass_hermes_plugin", plugin_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    ctx = FakeCtx()
    mod.register(ctx)

    raw = sys.stdin.read()
    kwargs = json.loads(raw) if raw.strip() else {}

    if action.startswith("command:"):
        name = action.split(":", 1)[1]
        result = ctx.commands[name](kwargs.get("raw_args", ""))
    else:
        result = ctx.hooks[action](**kwargs)

    print(json.dumps({"returned": result}))


if __name__ == "__main__":
    main()
